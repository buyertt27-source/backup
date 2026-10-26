// Self-contained zero-dependency Vercel Serverless Function for all /api/pterodactyl/* routes.
// Does NOT import vite or express, ensuring 100% reliable execution on Vercel Serverless runtime.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const DEFAULT_HEADERS = {
  Accept: 'Application/vnd.pterodactyl.v1+json',
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 PteroVault/2.0',
};

function cleanDomain(raw: string): string {
  let d = (raw || '').trim();
  if (!d) return '';
  if (!/^https?:\/\//i.test(d)) {
    d = `https://${d}`;
  }
  return d.replace(/\/+$/, '');
}

function buildIsolatedFileName(
  ordinal: number,
  identifier: string,
  serverName: string,
  backupName: string,
  createdAt: string
): string {
  const safeSlug = String(backupName || serverName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const datePart = (createdAt || new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-');
  const prefix = `srv${String(ordinal).padStart(2, '0')}`;
  return `backup_${prefix}_${identifier}_${safeSlug}_${datePart}.tar.gz`;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      headers: {
        ...DEFAULT_HEADERS,
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(req: any): Record<string, any> {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const urlStr = String(req.url || '');
  const actionQuery = String(req.query?.action || '');
  const routeKey = actionQuery || urlStr;
  const body = parseBody(req);

  try {
    // =========================================================================
    // 1. POST /api/pterodactyl/sync
    // =========================================================================
    if (routeKey.includes('sync')) {
      const { domain, pltaKey, pltsKey } = body;
      const baseUrl = cleanDomain(domain);
      const plta = (pltaKey || '').trim();
      const plts = (pltsKey || '').trim();

      if (!baseUrl) {
        res.status(400).json({ ok: false, error: 'Domain panel Pterodactyl wajib diisi.' });
        return;
      }
      if (!plta && !plts) {
        res.status(400).json({
          ok: false,
          error: 'Masukkan minimal salah satu dari Application API Key (PLTA) atau Client API Key (PLTS/PLTC).',
        });
        return;
      }

      let rawServersList: any[] = [];
      let sourceMode: 'application' | 'client' = 'application';
      let pltaWarning: string | null = null;

      if (plta) {
        try {
          const appRes = await fetchWithTimeout(`${baseUrl}/api/application/servers?per_page=100`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${plta}` },
          });
          if (appRes.ok) {
            const appJson = (await appRes.json()) as any;
            if (Array.isArray(appJson?.data)) {
              rawServersList = appJson.data;
              sourceMode = 'application';
            }
          } else {
            const errText = await appRes.text().catch(() => '');
            pltaWarning = `Application API (PLTA) merespons HTTP ${appRes.status}${errText ? `: ${errText.slice(0, 120)}` : ''}`;
          }
        } catch (err: any) {
          pltaWarning = `Gagal menghubungi Application API: ${err?.message || 'Koneksi gagal'}`;
        }
      }

      if (rawServersList.length === 0 && plts) {
        const clientRes = await fetchWithTimeout(`${baseUrl}/api/client?per_page=100`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${plts}` },
        });

        if (!clientRes.ok) {
          const errText = await clientRes.text().catch(() => '');
          res.status(clientRes.status).json({
            ok: false,
            error: `Gagal memuat daftar server dari ${baseUrl}. Client API merespons HTTP ${clientRes.status}.${
              pltaWarning ? ` (${pltaWarning})` : ''
            }`,
            details: errText.slice(0, 300),
          });
          return;
        }

        const clientJson = (await clientRes.json()) as any;
        rawServersList = Array.isArray(clientJson?.data) ? clientJson.data : [];
        sourceMode = 'client';
      }

      if (rawServersList.length === 0 && pltaWarning && !plts) {
        res.status(401).json({ ok: false, error: pltaWarning });
        return;
      }

      const servers = await Promise.all(
        rawServersList.map(async (item: any, idx: number) => {
          const attr = item.attributes || {};
          const identifier = attr.identifier || String(attr.uuid || '').slice(0, 8) || `srv${idx + 1}`;
          const name = attr.name || `Server ${idx + 1}`;

          let currentState: 'running' | 'offline' | 'starting' | 'stopping' = attr.suspended ? 'offline' : 'running';
          let memoryUsedMb = 0;
          let diskUsedMb = 0;
          let backups: any[] = [];

          if (plts) {
            try {
              const resUsage = await fetchWithTimeout(
                `${baseUrl}/api/client/servers/${identifier}/resources`,
                {
                  method: 'GET',
                  headers: { Authorization: `Bearer ${plts}` },
                },
                8000
              );
              if (resUsage.ok) {
                const usageJson = (await resUsage.json()) as any;
                const ua = usageJson?.attributes || {};
                const rawState = String(ua.current_state || 'running').toLowerCase();
                if (
                  rawState === 'running' ||
                  rawState === 'starting' ||
                  rawState === 'stopping' ||
                  rawState === 'offline'
                ) {
                  currentState = rawState;
                }
                memoryUsedMb = Math.round((Number(ua.resources?.memory_bytes) || 0) / (1024 * 1024));
                diskUsedMb = Math.round((Number(ua.resources?.disk_bytes) || 0) / (1024 * 1024));
              }
            } catch {
              // ignore resource timeout
            }

            try {
              const bkpRes = await fetchWithTimeout(
                `${baseUrl}/api/client/servers/${identifier}/backups?per_page=50`,
                {
                  method: 'GET',
                  headers: { Authorization: `Bearer ${plts}` },
                },
                10000
              );
              if (bkpRes.ok) {
                const bkpJson = (await bkpRes.json()) as any;
                const rawBkps = Array.isArray(bkpJson?.data) ? bkpJson.data : [];
                backups = rawBkps.map((b: any) => {
                  const ba = b.attributes || {};
                  const createdStr = ba.created_at || new Date().toISOString();
                  return {
                    id: ba.uuid,
                    uuid: ba.uuid,
                    serverId: String(attr.id || attr.uuid || identifier),
                    serverName: name,
                    serverIdentifier: identifier,
                    fileName: buildIsolatedFileName(idx + 1, identifier, name, ba.name || name, createdStr),
                    sizeBytes: Number(ba.bytes) || 0,
                    checksum: ba.checksum || 'sha256:pending',
                    createdAt: createdStr,
                    completedAt: ba.completed_at || null,
                    status:
                      ba.is_successful === false
                        ? 'failed'
                        : ba.completed_at
                        ? 'completed'
                        : 'in_progress',
                    isLocked: Boolean(ba.is_locked),
                    triggerType: 'manual_single',
                    ignoredFiles: ba.ignored_files
                      ? Array.isArray(ba.ignored_files)
                        ? ba.ignored_files.join(', ')
                        : String(ba.ignored_files)
                      : '',
                  };
                });
              }
            } catch {
              // ignore backup list error
            }
          }

          let allocationDisplay = attr.sftp_details?.ip
            ? `${attr.sftp_details.ip}:${attr.sftp_details.port || ''}`
            : `Node ${attr.node || 'Default'}`;

          const relAllocations = attr.relationships?.allocations?.data;
          if (Array.isArray(relAllocations) && relAllocations.length > 0) {
            const defAlloc = relAllocations.find((a: any) => a.attributes?.is_default) || relAllocations[0];
            if (defAlloc?.attributes?.ip) {
              allocationDisplay = `${defAlloc.attributes.ip_alias || defAlloc.attributes.ip}:${defAlloc.attributes.port}`;
            }
          }

          return {
            id: String(attr.id || attr.uuid || identifier),
            uuid: attr.uuid || identifier,
            identifier,
            name,
            node: attr.node ? String(attr.node) : 'Pterodactyl Node',
            description: attr.description || 'Server Pterodactyl Aktif',
            status: currentState,
            limits: {
              memoryMb: Number(attr.limits?.memory) || 0,
              diskMb: Number(attr.limits?.disk) || 0,
              cpuPercent: Number(attr.limits?.cpu) || 0,
              backupLimit:
                attr.feature_limits?.backups !== undefined ? Number(attr.feature_limits.backups) : 5,
            },
            usage: {
              memoryUsedMb,
              diskUsedMb,
            },
            eggName: attr.invocation ? String(attr.invocation).slice(0, 36) : 'Pterodactyl Container',
            allocation: allocationDisplay,
            backups,
          };
        })
      );

      res.status(200).json({ ok: true, sourceMode, servers });
      return;
    }

    // =========================================================================
    // 2. POST /api/pterodactyl/backup/create
    // =========================================================================
    if (routeKey.includes('backup/create')) {
      const {
        domain,
        pltsKey,
        serverIdentifier,
        serverOrdinal,
        serverName,
        backupName,
        isLocked,
        ignored,
        autoDeletePrevious,
        autoDeleteStrategy,
        retentionCount,
        serverBackupLimit,
      } = body;
      const baseUrl = cleanDomain(domain);
      const plts = (pltsKey || '').trim();

      if (!baseUrl || !plts || !serverIdentifier) {
        res.status(400).json({
          ok: false,
          error: 'Domain, Client API Key (PLTS/PLTC), dan Identifier Server diperlukan untuk membuat backup real.',
        });
        return;
      }

      const ordinal = Number(serverOrdinal) || 1;
      const shouldAutoDelete = Boolean(autoDeletePrevious);
      const strategy: 'delete_all_previous' | 'keep_retention_count' =
        autoDeleteStrategy === 'keep_retention_count' ? 'keep_retention_count' : 'delete_all_previous';
      const maxKeepCount = Math.max(1, Number(retentionCount) || 1);
      const knownLimit = Math.max(0, Number(serverBackupLimit) || 0);

      const deletedBackupUuids: string[] = [];
      const deletedBackupNames: string[] = [];

      const deleteBackupOnPanel = async (bkpUuid: string, bkpLabel: string): Promise<boolean> => {
        try {
          const delRes = await fetchWithTimeout(
            `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${bkpUuid}`,
            {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${plts}` },
            },
            10000
          );
          if (delRes.ok || delRes.status === 204) {
            deletedBackupUuids.push(bkpUuid);
            deletedBackupNames.push(bkpLabel);
            return true;
          }
        } catch {}
        return false;
      };

      let existingPanelBackups: Array<{
        uuid: string;
        name: string;
        createdAt: string;
        isLocked: boolean;
      }> = [];

      if (shouldAutoDelete) {
        try {
          const listRes = await fetchWithTimeout(
            `${baseUrl}/api/client/servers/${serverIdentifier}/backups?per_page=50`,
            {
              method: 'GET',
              headers: { Authorization: `Bearer ${plts}` },
            },
            10000
          );
          if (listRes.ok) {
            const listJson = (await listRes.json()) as any;
            const rawData = Array.isArray(listJson?.data) ? listJson.data : [];
            existingPanelBackups = rawData
              .map((item: any) => {
                const a = item?.attributes || {};
                const createdStr = a.created_at || new Date(0).toISOString();
                return {
                  uuid: String(a.uuid || ''),
                  name: buildIsolatedFileName(
                    ordinal,
                    serverIdentifier,
                    serverName || serverIdentifier,
                    a.name || serverName || serverIdentifier,
                    createdStr
                  ),
                  createdAt: createdStr,
                  isLocked: Boolean(a.is_locked),
                };
              })
              .filter((b: any) => Boolean(b.uuid))
              .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          }
        } catch {}
      }

      const unlockedOldestFirst = [...existingPanelBackups].filter((b) => !b.isLocked).reverse();

      if (shouldAutoDelete && knownLimit > 0 && existingPanelBackups.length >= knownLimit) {
        const slotsNeeded = Math.max(1, existingPanelBackups.length - knownLimit + 1);
        const preDeleteTargets = unlockedOldestFirst.slice(0, slotsNeeded);
        for (const oldBkp of preDeleteTargets) {
          await deleteBackupOnPanel(oldBkp.uuid, oldBkp.name);
        }
      }

      const nowIso = new Date().toISOString();
      const generatedName =
        backupName ||
        buildIsolatedFileName(
          ordinal,
          serverIdentifier,
          serverName || serverIdentifier,
          serverName || serverIdentifier,
          nowIso
        );

      const triggerCreateRequest = () =>
        fetchWithTimeout(`${baseUrl}/api/client/servers/${serverIdentifier}/backups`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${plts}` },
          body: JSON.stringify({
            name: generatedName,
            is_locked: Boolean(isLocked),
            ignored: ignored || '',
          }),
        });

      let response = await triggerCreateRequest();

      if (
        !response.ok &&
        shouldAutoDelete &&
        (response.status === 400 || response.status === 422 || response.status === 409)
      ) {
        const remainingToFree = unlockedOldestFirst.filter((b) => !deletedBackupUuids.includes(b.uuid));
        if (remainingToFree.length > 0) {
          await deleteBackupOnPanel(remainingToFree[0].uuid, remainingToFree[0].name);
          response = await triggerCreateRequest();
        }
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let parsedMsg = `HTTP ${response.status}`;
        try {
          const errJson = JSON.parse(text);
          if (errJson?.errors?.[0]?.detail) parsedMsg = errJson.errors[0].detail;
        } catch {
          if (text) parsedMsg = text.slice(0, 200);
        }
        res.status(response.status).json({
          ok: false,
          error: `Gagal membuat backup pada server ${serverIdentifier}: ${parsedMsg}`,
        });
        return;
      }

      const data = (await response.json()) as any;
      const ba = data?.attributes || {};
      const createdStr = ba.created_at || nowIso;
      const newBackupUuid = String(ba.uuid || '');

      if (shouldAutoDelete && unlockedOldestFirst.length > 0) {
        let totalUnlockedToDelete = 0;
        if (strategy === 'delete_all_previous') {
          totalUnlockedToDelete = unlockedOldestFirst.length;
        } else {
          const maxExistingAllowed = Math.max(0, maxKeepCount - 1);
          const excessCount = Math.max(0, existingPanelBackups.length - maxExistingAllowed);
          totalUnlockedToDelete = Math.min(unlockedOldestFirst.length, excessCount);
        }

        const targetSlice = unlockedOldestFirst.slice(0, totalUnlockedToDelete);
        for (const oldBkp of targetSlice) {
          if (oldBkp.uuid !== newBackupUuid && !deletedBackupUuids.includes(oldBkp.uuid)) {
            await deleteBackupOnPanel(oldBkp.uuid, oldBkp.name);
          }
        }
      }

      const createdBackup = {
        id: ba.uuid,
        uuid: ba.uuid,
        serverId: serverIdentifier,
        serverName: serverName || serverIdentifier,
        serverIdentifier,
        fileName: buildIsolatedFileName(
          ordinal,
          serverIdentifier,
          serverName || serverIdentifier,
          ba.name || generatedName,
          createdStr
        ),
        sizeBytes: Number(ba.bytes) || 0,
        checksum: ba.checksum || 'sha256:processing-on-wings',
        createdAt: createdStr,
        completedAt: ba.completed_at || null,
        status: ba.is_successful === false ? 'failed' : ba.completed_at ? 'completed' : 'in_progress',
        isLocked: Boolean(ba.is_locked),
        triggerType: 'manual_single',
        ignoredFiles: ba.ignored_files ? String(ba.ignored_files) : '',
      };

      res.status(200).json({
        ok: true,
        backup: createdBackup,
        deletedBackupUuids,
        deletedBackupNames,
      });
      return;
    }

    // =========================================================================
    // 3. POST /api/pterodactyl/backup/download
    // =========================================================================
    if (routeKey.includes('backup/download')) {
      const { domain, pltsKey, serverIdentifier, backupUuid } = body;
      const baseUrl = cleanDomain(domain);
      const plts = (pltsKey || '').trim();

      const response = await fetchWithTimeout(
        `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}/download`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${plts}` },
        }
      );

      if (!response.ok) {
        res.status(response.status).json({
          ok: false,
          error: `Gagal mengambil link unduhan backup dari panel (HTTP ${response.status}).`,
        });
        return;
      }

      const data = (await response.json()) as any;
      const downloadUrl = data?.attributes?.url || data?.url;
      res.status(200).json({ ok: true, downloadUrl });
      return;
    }

    // =========================================================================
    // 4. POST /api/pterodactyl/backup/lock
    // =========================================================================
    if (routeKey.includes('backup/lock')) {
      const { domain, pltsKey, serverIdentifier, backupUuid } = body;
      const baseUrl = cleanDomain(domain);
      const plts = (pltsKey || '').trim();

      const response = await fetchWithTimeout(
        `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}/lock`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${plts}` },
        }
      );

      if (!response.ok) {
        res.status(response.status).json({
          ok: false,
          error: `Gagal mengubah status kunci backup (HTTP ${response.status}).`,
        });
        return;
      }

      const data = (await response.json()) as any;
      res.status(200).json({ ok: true, isLocked: Boolean(data?.attributes?.is_locked) });
      return;
    }

    // =========================================================================
    // 5. POST /api/pterodactyl/backup/delete
    // =========================================================================
    if (routeKey.includes('backup/delete')) {
      const { domain, pltsKey, serverIdentifier, backupUuid } = body;
      const baseUrl = cleanDomain(domain);
      const plts = (pltsKey || '').trim();

      const response = await fetchWithTimeout(
        `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${plts}` },
        }
      );

      if (!response.ok && response.status !== 204) {
        res.status(response.status).json({
          ok: false,
          error: `Gagal menghapus backup dari panel (HTTP ${response.status}).`,
        });
        return;
      }

      res.status(200).json({ ok: true });
      return;
    }

    // =========================================================================
    // 6. POST /api/pterodactyl/backup/upload-to-drive
    // =========================================================================
    if (routeKey.includes('backup/upload-to-drive')) {
      const authHeader = req.headers?.authorization;
      const googleAccessToken =
        authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

      const {
        domain,
        pltsKey,
        serverIdentifier,
        backupUuid,
        fileName,
        driveFolderId,
        appsScriptUrl,
        targetFolderId,
        serverFolderName,
      } = body;

      const baseUrl = cleanDomain(domain);
      const plts = (pltsKey || '').trim();
      const scriptBridgeUrl = String(appsScriptUrl || '').trim();

      let isReady = false;
      let finalBytes = 0;
      let finalChecksum = '';
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const checkRes = await fetchWithTimeout(
            `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}`,
            {
              method: 'GET',
              headers: { Authorization: `Bearer ${plts}` },
            },
            6000
          );
          if (checkRes.ok) {
            const checkData = (await checkRes.json()) as any;
            const attr = checkData?.attributes || {};
            if (attr.completed_at) {
              isReady = true;
              finalBytes = Number(attr.bytes) || 0;
              finalChecksum = attr.checksum || '';
              break;
            }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 1500));
      }

      let signedWingsUrl: string | null = null;
      if (isReady) {
        const dlRes = await fetchWithTimeout(
          `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}/download`,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${plts}` },
          },
          8000
        );
        if (dlRes.ok) {
          const dlData = (await dlRes.json()) as any;
          signedWingsUrl = dlData?.attributes?.url || dlData?.url || null;
        }
      }

      const targetFileName = fileName || `backup_${serverIdentifier}_${backupUuid}.tar.gz`;

      if (scriptBridgeUrl) {
        const fallbackJson = JSON.stringify({
          pterodactyl_backup: {
            server_identifier: serverIdentifier,
            backup_uuid: backupUuid,
            filename: targetFileName,
            size_bytes: finalBytes,
            checksum: finalChecksum,
            panel_domain: baseUrl,
          },
        });

        const bridgeRes = await fetchWithTimeout(
          scriptBridgeUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              action: 'upload',
              targetFolderId: targetFolderId || '',
              rootFolderName: 'PteroVault_Backups',
              serverFolderName: serverFolderName || `Server_${serverIdentifier}`,
              fileName: targetFileName,
              signedWingsUrl,
              base64Payload: Buffer.from(fallbackJson, 'utf-8').toString('base64'),
              mimeType: 'application/gzip',
            }),
          },
          30000
        );

        const bridgeData = (await bridgeRes.json().catch(() => ({}))) as any;
        const createdId = bridgeData.fileId || `gdrive-${Date.now()}`;
        res.status(200).json({
          ok: true,
          driveFileId: createdId,
          webViewLink: bridgeData.webViewLink || `https://drive.google.com/file/d/${createdId}/view`,
          folderName: bridgeData.folderName || `PteroVault_Backups/${serverFolderName || serverIdentifier}`,
          sizeBytes: bridgeData.sizeBytes || finalBytes,
          status: isReady ? 'completed' : undefined,
        });
        return;
      }

      res.status(400).json({ ok: false, error: 'Gunakan Tautan Google Script Bridge untuk upload di Vercel.' });
      return;
    }

    res.status(404).json({ ok: false, error: `Endpoint tidak ditemukan: ${routeKey}` });
  } catch (err: any) {
    res.status(502).json({
      ok: false,
      error: `Gagal menghubungi panel Pterodactyl: ${err?.message || 'Network error'}`,
    });
  }
}
