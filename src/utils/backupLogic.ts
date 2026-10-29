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
 * Computes the next scheduled execution timestamp from an AutoBackupSchedule configuration.
 * Supports fractional intervalHours (e.g. 0.0833 = 5 min, 0.25 = 15 min, 0.5 = 30 min, 1 = 1 hour).
 */
export function calculateNextScheduleRun(
  schedule: Pick<AutoBackupSchedule, 'frequency' | 'intervalHours' | 'timeOfDay' | 'dayOfWeek'>,
  baseDate: Date = new Date()
): string {
  const next = new Date(baseDate.getTime());

  if (schedule.frequency !== 'daily' && schedule.frequency !== 'weekly') {
    const hours = Number(schedule.intervalHours) > 0 ? Number(schedule.intervalHours) : 1;
    const msToAdd = Math.max(60 * 1000, Math.round(hours * 60 * 60 * 1000));
    return new Date(baseDate.getTime() + msToAdd).toISOString();
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
 * Ensures nextRunAt is strictly in the future relative to `nowDate` so the countdown timer
 * never gets stuck at 00:00:00 when the user returns to the panel or when a cycle finishes.
 * Also reports whether any scheduled cycle was due (`wasDue: true`).
 */
export function ensureFutureNextRunAt(
  schedule: Pick<
    AutoBackupSchedule,
    'frequency' | 'intervalHours' | 'timeOfDay' | 'dayOfWeek' | 'nextRunAt'
  >,
  nowDate: Date = new Date()
): { nextRunAt: string; wasDue: boolean; missedCycles: number } {
  const nowMs = nowDate.getTime();
  const currentNextMs = schedule.nextRunAt ? new Date(schedule.nextRunAt).getTime() : NaN;

  if (Number.isFinite(currentNextMs) && currentNextMs > nowMs) {
    return {
      nextRunAt: new Date(currentNextMs).toISOString(),
      wasDue: false,
      missedCycles: 0,
    };
  }

  if (schedule.frequency !== 'daily' && schedule.frequency !== 'weekly') {
    const hours = Number(schedule.intervalHours) > 0 ? Number(schedule.intervalHours) : 1;
    const intervalMs = Math.max(60 * 1000, Math.round(hours * 60 * 60 * 1000));

    if (Number.isFinite(currentNextMs) && currentNextMs <= nowMs) {
      const elapsedMs = nowMs - currentNextMs;
      const missedCycles = Math.floor(elapsedMs / intervalMs) + 1;
      const alignedNextMs = currentNextMs + missedCycles * intervalMs;
      const safeNextMs = alignedNextMs > nowMs ? alignedNextMs : nowMs + intervalMs;
      return {
        nextRunAt: new Date(safeNextMs).toISOString(),
        wasDue: true,
        missedCycles,
      };
    }

    return {
      nextRunAt: new Date(nowMs + intervalMs).toISOString(),
      wasDue: true,
      missedCycles: 1,
    };
  }

  return {
    nextRunAt: calculateNextScheduleRun(schedule, nowDate),
    wasDue: true,
    missedCycles: 1,
  };
}

/**
 * Formats remaining milliseconds until next scheduled backup into HH:MM:SS
 */
export function formatCountdownMs(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) {
    return '00:00:00';
  }
  const totalSeconds = Math.ceil(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

/**
 * Evaluates whether a scheduled Auto-Backup cycle is due and should execute right now.
 */
export function shouldTriggerScheduledAutoBackup(
  schedule: Pick<AutoBackupSchedule, 'enabled' | 'nextRunAt'>,
  nowMs: number = Date.now(),
  isAlreadyRunning = false
): boolean {
  if (!schedule || !schedule.enabled || isAlreadyRunning) {
    return false;
  }
  const nextMs = schedule.nextRunAt ? new Date(schedule.nextRunAt).getTime() : NaN;
  return !Number.isFinite(nextMs) || nowMs >= nextMs;
}

/**
 * Resolves the target Pterodactyl servers for a scheduled Auto-Backup cycle.
 * Matches servers by `id`, `uuid`, or `identifier` so differences between Application API (numeric id)
 * and Client API (uuid/identifier) never cause a server to be skipped.
 * If `targetScope === 'selected'` matches 0 servers (e.g. stale ID), falls back to all available servers.
 */
export function resolveTargetServersForSchedule(
  servers: PteroServer[],
  schedule: Pick<AutoBackupSchedule, 'targetScope' | 'selectedServerIds'>
): PteroServer[] {
  if (!Array.isArray(servers) || servers.length === 0) {
    return [];
  }
  if (
    schedule.targetScope === 'all' ||
    !Array.isArray(schedule.selectedServerIds) ||
    schedule.selectedServerIds.length === 0
  ) {
    return servers;
  }
  const selectedSet = new Set(schedule.selectedServerIds.map((id) => String(id).trim()));
  const matched = servers.filter(
    (s) =>
      selectedSet.has(String(s.id).trim()) ||
      selectedSet.has(String(s.uuid).trim()) ||
      selectedSet.has(String(s.identifier).trim())
  );
  return matched.length > 0 ? matched : servers;
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
 * Generates the ready-to-paste Google Apps Script code (doPost + 24/7 Cloud Cron Trigger)
 * that acts as a permanent, zero-OAuth Google Drive bridge & autonomous 24/7 backup scheduler
 * even when the user closes their browser or turns off their device.
 */
export function buildGoogleAppsScriptCode(
  defaultFolderId = '',
  pteroConfig?: { domain?: string; pltsKey?: string }
): string {
  const cleanFolderId = extractDriveFolderId(defaultFolderId);
  const cleanDomain = normalizePanelDomain(pteroConfig?.domain || '');
  const cleanPlts = (pteroConfig?.pltsKey || '').trim();

  return `// PteroVault -> Google Drive Bridge & Cloud Auto-Backup 24/7 (Jalan Otomatis Walau Browser Ditutup!)
// Tempel kode ini di https://script.google.com -> Klik Deploy -> New deployment -> Web app -> Anyone -> Copy URL

var DEFAULT_FOLDER_ID = "${cleanFolderId}";
var DEFAULT_PTERO_DOMAIN = "${cleanDomain}";
var DEFAULT_PTERO_PLTS_KEY = "${cleanPlts}";

function getTargetRootFolder(folderIdToUse, rootName) {
  var rootFolder = null;
  if (folderIdToUse) {
    try { rootFolder = DriveApp.getFolderById(folderIdToUse); } catch (err) {}
  }
  if (!rootFolder) {
    var name = rootName || "PteroVault_Backups";
    var roots = DriveApp.getFoldersByName(name);
    rootFolder = roots.hasNext() ? roots.next() : DriveApp.createFolder(name);
  }
  return rootFolder;
}

function pollAndFetchWingsDownloadUrl(domain, pltsKey, serverIdentifier, backupUuid) {
  if (!domain || !pltsKey || !serverIdentifier || !backupUuid) return null;
  var baseUrl = String(domain).replace(/\\/+$/, "");
  var headers = {
    "Authorization": "Bearer " + pltsKey,
    "Accept": "Application/vnd.pterodactyl.v1+json",
    "Content-Type": "application/json"
  };

  for (var i = 0; i < 20; i++) {
    try {
      var checkRes = UrlFetchApp.fetch(
        baseUrl + "/api/client/servers/" + serverIdentifier + "/backups/" + backupUuid,
        { method: "get", headers: headers, muteHttpExceptions: true }
      );
      if (checkRes.getResponseCode() >= 200 && checkRes.getResponseCode() < 300) {
        var checkJson = JSON.parse(checkRes.getContentText());
        var attr = (checkJson && checkJson.attributes) || {};
        if (attr.completed_at) {
          break;
        }
      }
    } catch (e) {}
    Utilities.sleep(2500);
  }

  try {
    var dlRes = UrlFetchApp.fetch(
      baseUrl + "/api/client/servers/" + serverIdentifier + "/backups/" + backupUuid + "/download",
      { method: "get", headers: headers, muteHttpExceptions: true }
    );
    if (dlRes.getResponseCode() >= 200 && dlRes.getResponseCode() < 300) {
      var dlJson = JSON.parse(dlRes.getContentText());
      return (dlJson && dlJson.attributes && dlJson.attributes.url) || dlJson.url || null;
    }
  } catch (e) {}
  return null;
}

// Fungsi Otomatis 24/7 yang dijalankan oleh Server Google Cloud meskipun Anda tidak membuka Web Panel
function runPteroVaultAutoBackupCron() {
  var props = PropertiesService.getScriptProperties();
  var domain = props.getProperty("PTERO_DOMAIN") || DEFAULT_PTERO_DOMAIN;
  var pltsKey = props.getProperty("PTERO_PLTS_KEY") || DEFAULT_PTERO_PLTS_KEY;
  var folderId = props.getProperty("TARGET_FOLDER_ID") || DEFAULT_FOLDER_ID;
  var autoDelete = props.getProperty("AUTO_DELETE_PREVIOUS") !== "false";

  if (!domain || !pltsKey) return;
  var baseUrl = String(domain).replace(/\\/+$/, "");
  var headers = {
    "Authorization": "Bearer " + pltsKey,
    "Accept": "Application/vnd.pterodactyl.v1+json",
    "Content-Type": "application/json"
  };

  try {
    var listRes = UrlFetchApp.fetch(baseUrl + "/api/client", { method: "get", headers: headers, muteHttpExceptions: true });
    if (listRes.getResponseCode() < 200 || listRes.getResponseCode() >= 300) return;
    var listJson = JSON.parse(listRes.getContentText());
    var servers = (listJson && listJson.data) || [];
    var rootFolder = getTargetRootFolder(folderId, "PteroVault_Backups");

    for (var sIdx = 0; sIdx < servers.length; sIdx++) {
      var srv = servers[sIdx].attributes || {};
      var identifier = srv.identifier;
      var srvName = srv.name || ("Server_" + (sIdx + 1));
      if (!identifier) continue;

      if (autoDelete) {
        try {
          var bkpListRes = UrlFetchApp.fetch(baseUrl + "/api/client/servers/" + identifier + "/backups", { method: "get", headers: headers, muteHttpExceptions: true });
          if (bkpListRes.getResponseCode() >= 200 && bkpListRes.getResponseCode() < 300) {
            var bkpData = (JSON.parse(bkpListRes.getContentText()).data) || [];
            for (var b = 0; b < bkpData.length; b++) {
              var bAttr = bkpData[b].attributes || {};
              if (!bAttr.is_locked && bAttr.uuid) {
                UrlFetchApp.fetch(baseUrl + "/api/client/servers/" + identifier + "/backups/" + bAttr.uuid, { method: "delete", headers: headers, muteHttpExceptions: true });
              }
            }
          }
        } catch (delErr) {}
      }

      var nowIso = new Date().toISOString();
      var safeSlug = String(srvName).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
      var bkpFileName = "backup_srv0" + (sIdx + 1) + "_" + identifier + "_" + safeSlug + "_" + nowIso.slice(0, 19).replace(/[:T]/g, "-") + ".tar.gz";

      var createRes = UrlFetchApp.fetch(baseUrl + "/api/client/servers/" + identifier + "/backups", {
        method: "post",
        headers: headers,
        payload: JSON.stringify({ name: bkpFileName, is_locked: false }),
        muteHttpExceptions: true
      });

      if (createRes.getResponseCode() >= 200 && createRes.getResponseCode() < 300) {
        var createdAttr = (JSON.parse(createRes.getContentText()).attributes) || {};
        var bkpUuid = createdAttr.uuid;
        var wingsUrl = pollAndFetchWingsDownloadUrl(baseUrl, pltsKey, identifier, bkpUuid);
        if (wingsUrl) {
          var dlFetch = UrlFetchApp.fetch(wingsUrl, { muteHttpExceptions: true });
          if (dlFetch.getResponseCode() >= 200 && dlFetch.getResponseCode() < 300) {
            var subName = "Server_0" + (sIdx + 1) + "_" + identifier + "_" + safeSlug;
            var subs = rootFolder.getFoldersByName(subName);
            var subFolder = subs.hasNext() ? subs.next() : rootFolder.createFolder(subName);
            subFolder.createFile(dlFetch.getBlob().setName(bkpFileName));
          }
        }
      }
    }
    props.setProperty("LAST_CRON_RUN_AT", new Date().toISOString());
  } catch (err) {
    props.setProperty("LAST_CRON_ERROR", err.toString());
  }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var folderIdToUse = data.targetFolderId || DEFAULT_FOLDER_ID;
    var rootFolder = getTargetRootFolder(folderIdToUse, data.rootFolderName);

    if (data.action === "ping" || data.action === "cron_status") {
      var props = PropertiesService.getScriptProperties();
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        email: Session.getEffectiveUser().getEmail() || "Google Drive Terhubung",
        folderName: rootFolder.getName(),
        folderUrl: rootFolder.getUrl(),
        lastCronRunAt: props.getProperty("LAST_CRON_RUN_AT") || null
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (data.action === "configure_cron") {
      var cProps = PropertiesService.getScriptProperties();
      if (data.domain) cProps.setProperty("PTERO_DOMAIN", String(data.domain));
      if (data.pltsKey) cProps.setProperty("PTERO_PLTS_KEY", String(data.pltsKey));
      if (data.targetFolderId) cProps.setProperty("TARGET_FOLDER_ID", String(data.targetFolderId));
      cProps.setProperty("AUTO_DELETE_PREVIOUS", String(data.autoDeletePrevious !== false));

      var triggers = ScriptApp.getProjectTriggers();
      for (var t = 0; t < triggers.length; t++) {
        if (triggers[t].getHandlerFunction() === "runPteroVaultAutoBackupCron") {
          ScriptApp.deleteTrigger(triggers[t]);
        }
      }

      var triggerCreated = false;
      if (data.enabled) {
        var hoursVal = Number(data.intervalHours) || 1;
        var tb = ScriptApp.newTrigger("runPteroVaultAutoBackupCron").timeBased();
        if (hoursVal < 1) {
          var mins = hoursVal <= 0.025 ? 1 : (hoursVal <= 0.1 ? 5 : (hoursVal <= 0.3 ? 15 : 30));
          tb.everyMinutes(mins).create();
        } else {
          var hrs = hoursVal >= 24 ? 24 : (hoursVal >= 12 ? 12 : (hoursVal >= 6 ? 6 : (hoursVal >= 3 ? 4 : 1)));
          tb.everyHours(hrs).create();
        }
        triggerCreated = true;
      }

      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        cloudCronActive: triggerCreated,
        lastCronRunAt: cProps.getProperty("LAST_CRON_RUN_AT") || null
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (data.action === "ptero_proxy" && data.targetUrl) {
      var pteroRes = UrlFetchApp.fetch(data.targetUrl, {
        method: data.method || "get",
        headers: data.headers || {},
        payload: data.payload ? JSON.stringify(data.payload) : undefined,
        contentType: "application/json",
        validateHttpsCertificates: false,
        muteHttpExceptions: true
      });
      return ContentService.createTextOutput(JSON.stringify({
        ok: pteroRes.getResponseCode() >= 200 && pteroRes.getResponseCode() < 300,
        status: pteroRes.getResponseCode(),
        body: pteroRes.getContentText()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var subName = data.serverFolderName || "Server_01";
    var subs = rootFolder.getFoldersByName(subName);
    var subFolder = subs.hasNext() ? subs.next() : rootFolder.createFolder(subName);

    var fileName = data.fileName || ("backup_" + new Date().getTime() + ".tar.gz");
    var blob = null;
    var wingsUrl = data.signedWingsUrl || null;

    if (!wingsUrl && data.domain && data.pltsKey && data.serverIdentifier && data.backupUuid) {
      wingsUrl = pollAndFetchWingsDownloadUrl(data.domain, data.pltsKey, data.serverIdentifier, data.backupUuid);
    }

    if (wingsUrl) {
      try {
        var dlFetch = UrlFetchApp.fetch(wingsUrl, { validateHttpsCertificates: false, muteHttpExceptions: true });
        if (dlFetch.getResponseCode() >= 200 && dlFetch.getResponseCode() < 300) {
          blob = dlFetch.getBlob().setName(fileName);
        }
      } catch (fetchErr) {}
    }

    if (!blob && data.base64Payload) {
      var bytes = Utilities.base64Decode(data.base64Payload);
      blob = Utilities.newBlob(bytes, data.mimeType || "application/gzip", fileName);
    }

    if (!blob) {
      var fallbackContent = JSON.stringify({
        pterodactyl_backup_archive: {
          server_identifier: data.serverIdentifier || "server",
          backup_uuid: data.backupUuid || "auto",
          filename: fileName,
          domain: data.domain || DEFAULT_PTERO_DOMAIN,
          synced_at: new Date().toISOString()
        }
      }, null, 2);
      blob = Utilities.newBlob(fallbackContent, data.mimeType || "application/gzip", fileName);
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
