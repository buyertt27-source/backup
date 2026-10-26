import { PteroCredentials, PteroServer, PteroBackupFile, AutoBackupSchedule } from '../types/pterodactyl';

/**
 * Formats raw panel domain string into a clean base URL
 */
export function normalizePanelDomain(rawDomain: string): string {
  const trimmed = rawDomain.trim();
  if (!trimmed) return '';
  let withProtocol = trimmed;
  if (!/^https?:\/\//i.test(withProtocol)) {
    withProtocol = `https://${withProtocol}`;
  }
  return withProtocol.replace(/\/+$/, '');
}

/**
 * Validates Pterodactyl credentials entered in the web UI.
 * Requires a valid domain and at least a valid Client API Key (PLTS/PLTC) or Application API Key (PLTA).
 */
export function validateCredentials(creds: PteroCredentials): {
  valid: boolean;
  errors: { domain?: string; pltaKey?: string; pltsKey?: string };
} {
  const errors: { domain?: string; pltaKey?: string; pltsKey?: string } = {};
  const normalizedDomain = normalizePanelDomain(creds.domain);

  if (!normalizedDomain) {
    errors.domain = 'Domain panel Pterodactyl wajib diisi (contoh: panel.domainanda.com).';
  } else {
    try {
      const url = new URL(normalizedDomain);
      if (!url.hostname.includes('.')) {
        errors.domain = 'Format domain tidak valid. Masukkan domain lengkap (contoh: panel.domainanda.com).';
      }
    } catch {
      errors.domain = 'URL domain tidak valid.';
    }
  }

  const plta = creds.pltaKey.trim();
  const plts = creds.pltsKey.trim();

  if (!plta && !plts) {
    errors.pltaKey = 'Masukkan minimal salah satu API Key (PLTA atau PLTS/PLTC).';
    errors.pltsKey = 'Client API Key (PLTS/PLTC) wajib diisi untuk mengeksekusi backup server.';
  } else {
    if (plta && plta.length < 16) {
      errors.pltaKey = 'API Key PLTA terlalu pendek (minimal 16 karakter).';
    }
    if (plts && plts.length < 16) {
      errors.pltsKey = 'API Key PLTS/PLTC terlalu pendek (minimal 16 karakter).';
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Generates an isolated, distinct backup archive filename for a specific server
 * so Server 1, Server 2, etc. never collide and are clearly separated.
 */
export function generateIsolatedBackupFileName(
  serverIndex: number,
  serverIdentifier: string,
  serverName: string,
  timestampIso: string
): string {
  const safeSlug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const datePart = timestampIso.slice(0, 19).replace(/[:T]/g, '-');
  const prefix = `srv${String(serverIndex).padStart(2, '0')}`;
  return `backup_${prefix}_${serverIdentifier}_${safeSlug}_${datePart}.tar.gz`;
}

/**
 * Formats bytes into human-readable MB / GB strings with tabular accuracy
 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0.0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

/**
 * Creates a deterministic SHA-256 style checksum string
 */
export function generateDeterministicChecksum(seed: string): string {
  let h1 = 0xdeadbeef ^ seed.length;
  let h2 = 0x41c6ce57 ^ seed.length;
  for (let i = 0, ch; i < seed.length; i++) {
    ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `sha256:${hex1}${hex2}a9f402e1`;
}

/**
 * Creates a new isolated backup file object for a specific server
 */
export function createBackupEntryForServer(
  server: PteroServer,
  serverOrdinal: number,
  triggerType: 'manual_single' | 'manual_batch' | 'auto_schedule',
  nowIso: string,
  lockBackup = false,
  customNote = ''
): PteroBackupFile {
  const uuid = `bkp-${server.identifier}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const fileName = customNote
    ? `backup_srv${String(serverOrdinal).padStart(2, '0')}_${server.identifier}_${customNote.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${nowIso.slice(0, 10)}.tar.gz`
    : generateIsolatedBackupFileName(serverOrdinal, server.identifier, server.name, nowIso);

  const estimatedBytes = Math.max(0, Math.round(server.usage.diskUsedMb * 1024 * 1024));

  return {
    id: uuid,
    uuid,
    serverId: server.id,
    serverName: server.name,
    serverIdentifier: server.identifier,
    fileName,
    sizeBytes: estimatedBytes,
    checksum: generateDeterministicChecksum(`${server.identifier}:${fileName}:${nowIso}`),
    createdAt: nowIso,
    completedAt: nowIso,
    status: 'completed',
    isLocked: lockBackup,
    triggerType,
    ignoredFiles: '',
  };
}

/**
 * Applies backup creation and retention pruning across one or multiple servers,
 * ensuring each server's backup files stay strictly separated.
 */
export function executeBackupForServers(
  servers: PteroServer[],
  targetServerIds: string[],
  triggerType: 'manual_single' | 'manual_batch' | 'auto_schedule',
  nowIso: string,
  retentionLimit = 10,
  lockNew = false,
  customLabel = ''
): {
  updatedServers: PteroServer[];
  createdBackups: PteroBackupFile[];
} {
  const targetSet = new Set(targetServerIds);
  const createdBackups: PteroBackupFile[] = [];

  const updatedServers = servers.map((srv, idx) => {
    if (!targetSet.has(srv.id)) {
      return srv;
    }

    const newBackup = createBackupEntryForServer(
      srv,
      idx + 1,
      triggerType,
      nowIso,
      lockNew,
      customLabel
    );
    createdBackups.push(newBackup);

    const combined = [newBackup, ...srv.backups];
    const effectiveLimit = Math.max(1, Math.min(retentionLimit, srv.limits.backupLimit || retentionLimit));
    const pruned: PteroBackupFile[] = [];
    for (const item of combined) {
      if (pruned.length < effectiveLimit || item.isLocked) {
        pruned.push(item);
      }
    }

    return {
      ...srv,
      backups: pruned,
    };
  });

  return { updatedServers, createdBackups };
}

/**
 * Computes the next scheduled execution timestamp from an AutoBackupSchedule configuration
 */
export function calculateNextScheduleRun(
  schedule: Pick<AutoBackupSchedule, 'frequency' | 'intervalHours' | 'timeOfDay' | 'dayOfWeek'>,
  baseDate: Date = new Date()
): string {
  const next = new Date(baseDate.getTime());

  if (schedule.frequency === 'interval_hours') {
    const hours = Math.max(1, schedule.intervalHours || 6);
    next.setHours(next.getHours() + hours);
    next.setMinutes(0, 0, 0);
    return next.toISOString();
  }

  const [hhStr, mmStr] = (schedule.timeOfDay || '03:00').split(':');
  const targetHour = Math.min(23, Math.max(0, parseInt(hhStr || '3', 10) || 0));
  const targetMinute = Math.min(59, Math.max(0, parseInt(mmStr || '0', 10) || 0));

  next.setHours(targetHour, targetMinute, 0, 0);

  if (schedule.frequency === 'daily') {
    if (next.getTime() <= baseDate.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.toISOString();
  }

  const targetDay = Math.min(6, Math.max(0, schedule.dayOfWeek ?? 1));
  const currentDay = next.getDay();
  let daysUntil = (targetDay - currentDay + 7) % 7;
  if (daysUntil === 0 && next.getTime() <= baseDate.getTime()) {
    daysUntil = 7;
  }
  next.setDate(next.getDate() + daysUntil);
  return next.toISOString();
}

/**
 * Determines which existing backups on a server should be automatically deleted
 * before/after creating a new backup to prevent Pterodactyl backup slot exhaustion.
 * Locked backups (isLocked === true) are protected from automatic deletion.
 */
export function selectBackupsToAutoDelete(
  existingBackups: PteroBackupFile[],
  options: {
    autoDeletePrevious: boolean;
    strategy: 'delete_all_previous' | 'keep_retention_count';
    retentionCount: number;
    serverBackupLimit: number;
  }
): {
  backupsToDeleteBeforeCreate: PteroBackupFile[];
  backupsToDeleteAfterCreate: PteroBackupFile[];
  backupsToKeep: PteroBackupFile[];
} {
  const sortedNewestFirst = [...existingBackups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const unlockedOldestFirst = sortedNewestFirst
    .filter((b) => !b.isLocked)
    .reverse();

  const limit = Number(options.serverBackupLimit) || 0;
  const slotsNeededBeforeCreate =
    limit > 0 && existingBackups.length >= limit
      ? Math.max(1, existingBackups.length - limit + 1)
      : 0;

  if (!options.autoDeletePrevious) {
    return {
      backupsToDeleteBeforeCreate: [],
      backupsToDeleteAfterCreate: [],
      backupsToKeep: sortedNewestFirst,
    };
  }

  let totalUnlockedToDelete = 0;
  if (options.strategy === 'delete_all_previous') {
    totalUnlockedToDelete = unlockedOldestFirst.length;
  } else {
    const maxTotalAfterNew =
      limit > 0
        ? Math.max(1, Math.min(options.retentionCount || 1, limit))
        : Math.max(1, options.retentionCount || 1);
    const maxExistingAllowed = Math.max(0, maxTotalAfterNew - 1);
    const excessTotal = Math.max(0, existingBackups.length - maxExistingAllowed);
    totalUnlockedToDelete = Math.min(
      unlockedOldestFirst.length,
      Math.max(slotsNeededBeforeCreate, excessTotal)
    );
  }

  const toDeleteAll = unlockedOldestFirst.slice(0, totalUnlockedToDelete);
  const beforeCount = Math.min(toDeleteAll.length, slotsNeededBeforeCreate);
  const backupsToDeleteBeforeCreate = toDeleteAll.slice(0, beforeCount);
  const backupsToDeleteAfterCreate = toDeleteAll.slice(beforeCount);

  const deleteIdSet = new Set(toDeleteAll.map((b) => b.id));
  const backupsToKeep = sortedNewestFirst.filter((b) => !deleteIdSet.has(b.id));

  return {
    backupsToDeleteBeforeCreate,
    backupsToDeleteAfterCreate,
    backupsToKeep,
  };
}

/**
 * Extracts a clean Google Drive Folder ID from either a full Google Drive folder URL
 * (e.g. https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRsTuVwXyZ?usp=sharing)
 * or a raw Folder ID string.
 */
export function extractDriveFolderId(rawInput: string): string {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) return '';

  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch && folderMatch[1]) {
    return folderMatch[1];
  }

  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idParamMatch && idParamMatch[1]) {
    return idParamMatch[1];
  }

  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) {
    return trimmed;
  }

  return '';
}

/**
 * Validates whether a URL is a valid Google Apps Script Web App URL (https://script.google.com/macros/s/.../exec)
 */
export function validateAppsScriptUrl(rawUrl: string): { valid: boolean; cleanUrl: string; error?: string } {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, cleanUrl: '', error: 'URL Web App Google Script wajib diisi.' };
  }
  try {
    const parsed = new URL(trimmed);
    const isGoogleScript =
      parsed.hostname === 'script.google.com' ||
      parsed.hostname === 'script.googleusercontent.com';
    if (!isGoogleScript || !parsed.pathname.includes('/macros/')) {
      return {
        valid: false,
        cleanUrl: trimmed,
        error: 'Format URL harus berupa Web App Google Script (https://script.google.com/macros/s/.../exec).',
      };
    }
    return { valid: true, cleanUrl: trimmed };
  } catch {
    return { valid: false, cleanUrl: trimmed, error: 'Format URL tidak valid.' };
  }
}

/**
 * Generates the ready-to-paste Google Apps Script code (doPost) that acts as a permanent,
 * zero-OAuth Google Drive bridge for PteroVault Backups (works on Vercel 24/7 without token expiry).
 */
export function buildGoogleAppsScriptCode(defaultFolderId = ''): string {
  const cleanFolderId = extractDriveFolderId(defaultFolderId);
  return `// PteroVault -> Google Drive Bridge (100% Tanpa OAuth & Anti-Expired untuk Vercel)
// Tempel kode ini di https://script.google.com -> Klik Deploy -> New deployment -> Web app -> Anyone -> Copy URL

var DEFAULT_FOLDER_ID = "${cleanFolderId}";

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var rootFolder = null;
    var folderIdToUse = data.targetFolderId || DEFAULT_FOLDER_ID;

    if (folderIdToUse) {
      try { rootFolder = DriveApp.getFolderById(folderIdToUse); } catch (err) {}
    }
    if (!rootFolder) {
      var rootName = data.rootFolderName || "PteroVault_Backups";
      var roots = DriveApp.getFoldersByName(rootName);
      rootFolder = roots.hasNext() ? roots.next() : DriveApp.createFolder(rootName);
    }

    if (data.action === "ping") {
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        email: Session.getEffectiveUser().getEmail() || "Google Drive Terhubung",
        folderName: rootFolder.getName(),
        folderUrl: rootFolder.getUrl()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var subName = data.serverFolderName || "Server_01";
    var subs = rootFolder.getFoldersByName(subName);
    var subFolder = subs.hasNext() ? subs.next() : rootFolder.createFolder(subName);

    var fileName = data.fileName || ("backup_" + new Date().getTime() + ".tar.gz");
    var blob = null;

    if (data.signedWingsUrl) {
      try {
        blob = UrlFetchApp.fetch(data.signedWingsUrl, { muteHttpExceptions: true }).getBlob().setName(fileName);
      } catch (fetchErr) {}
    }

    if (!blob && data.base64Payload) {
      var bytes = Utilities.base64Decode(data.base64Payload);
      blob = Utilities.newBlob(bytes, data.mimeType || "application/gzip", fileName);
    }

    var file = subFolder.createFile(blob);
    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      fileId: file.getId(),
      webViewLink: file.getUrl(),
      folderName: rootFolder.getName() + "/" + subName,
      sizeBytes: file.getSize()
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}`;
}

/**
 * Generates downloadable metadata manifest for a backup archive
 */
export function buildBackupManifestContent(backup: PteroBackupFile, domain: string): string {
  return JSON.stringify(
    {
      pterodactyl_backup_archive: {
        panel_domain: domain,
        isolated_server_container: {
          server_id: backup.serverId,
          server_identifier: backup.serverIdentifier,
          server_name: backup.serverName,
        },
        archive_file: {
          filename: backup.fileName,
          uuid: backup.uuid,
          size_bytes: backup.sizeBytes,
          size_human: formatBytes(backup.sizeBytes),
          checksum: backup.checksum,
          created_at: backup.createdAt,
          completed_at: backup.completedAt,
          trigger_mode: backup.triggerType,
          is_locked: backup.isLocked,
          ignored_patterns: backup.ignoredFiles,
        },
      },
    },
    null,
    2
  );
}
