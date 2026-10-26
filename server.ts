import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createApiApp() {
  const app = express();

  app.use(express.json({ limit: '2mb' }));

  /**
   * POST /api/pterodactyl/sync
   * Connects directly to real Pterodactyl Panel using Application API (PLTA) and/or Client API (PLTS/PLTC).
   * Fetches all real servers, real resources/status, and real backups per server.
   */
  app.post('/api/pterodactyl/sync', async (req, res) => {
    try {
      const { domain, pltaKey, pltsKey } = req.body || {};
      const baseUrl = cleanDomain(domain);
      const plta = (pltaKey || '').trim();
      const plts = (pltsKey || '').trim();

      if (!baseUrl) {
        res.status(400).json({
          ok: false,
          error: 'Domain panel Pterodactyl wajib diisi.',
        });
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

      // 1. Try Application API (PLTA) first if provided
      if (plta) {
        try {
          const appRes = await fetchWithTimeout(`${baseUrl}/api/application/servers?per_page=100`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${plta}`,
              Accept: 'Application/vnd.pterodactyl.v1+json',
              'Content-Type': 'application/json',
            },
          });

          if (appRes.ok) {
            const appJson = (await appRes.json()) as any;
            if (Array.isArray(appJson?.data)) {
              rawServersList = appJson.data;
              sourceMode = 'application';
            }
          } else {
            const errText = await appRes.text().catch(() => '');
            pltaWarning = `Application API (PLTA) mengembalikan HTTP ${appRes.status}${errText ? `: ${errText.slice(0, 120)}` : ''}`;
          }
        } catch (err: any) {
          pltaWarning = `Gagal menghubungi Application API: ${err?.message || 'Koneksi gagal'}`;
        }
      }

      // 2. If rawServersList is still empty and PLTS (Client API) is provided, fetch from /api/client
      if (rawServersList.length === 0 && plts) {
        const clientRes = await fetchWithTimeout(`${baseUrl}/api/client?per_page=100`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${plts}`,
            Accept: 'Application/vnd.pterodactyl.v1+json',
            'Content-Type': 'application/json',
          },
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

      // If neither succeeded and we have a warning from PLTA
      if (rawServersList.length === 0 && pltaWarning && !plts) {
        res.status(401).json({
          ok: false,
          error: pltaWarning,
        });
        return;
      }

      // 3. Enrich each server with live Client API resources & backups when PLTS is available
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
            // Fetch live resource utilization & power state
            try {
              const resUsage = await fetchWithTimeout(
                `${baseUrl}/api/client/servers/${identifier}/resources`,
                {
                  method: 'GET',
                  headers: {
                    Authorization: `Bearer ${plts}`,
                    Accept: 'Application/vnd.pterodactyl.v1+json',
                  },
                },
                8000
              );
              if (resUsage.ok) {
                const usageJson = (await resUsage.json()) as any;
                const ua = usageJson?.attributes || {};
                const rawState = String(ua.current_state || 'running').toLowerCase();
                if (rawState === 'running' || rawState === 'starting' || rawState === 'stopping' || rawState === 'offline') {
                  currentState = rawState;
                }
                const memBytes = Number(ua.resources?.memory_bytes) || 0;
                const diskBytes = Number(ua.resources?.disk_bytes) || 0;
                memoryUsedMb = Math.round(memBytes / (1024 * 1024));
                diskUsedMb = Math.round(diskBytes / (1024 * 1024));
              }
            } catch {
              // Ignore individual resource telemetry timeout
            }

            // Fetch real backups list for this server container
            try {
              const bkpRes = await fetchWithTimeout(
                `${baseUrl}/api/client/servers/${identifier}/backups?per_page=50`,
                {
                  method: 'GET',
                  headers: {
                    Authorization: `Bearer ${plts}`,
                    Accept: 'Application/vnd.pterodactyl.v1+json',
                  },
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
              // Ignore if backups endpoint is forbidden or unreachable for this server
            }
          }

          // Extract allocation display if present
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
                attr.feature_limits?.backups !== undefined
                  ? Number(attr.feature_limits.backups)
                  : 5,
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

      res.json({
        ok: true,
        sourceMode,
        servers,
      });
    } catch (err: any) {
      res.status(502).json({
        ok: false,
        error:
          err?.name === 'AbortError'
            ? 'Koneksi ke panel Pterodactyl timeout (15 detik). Periksa apakah domain panel dapat diakses publik.'
            : `Gagal menghubungi panel Pterodactyl: ${err?.message || 'Network error'}`,
      });
    }
  });

  /**
   * POST /api/pterodactyl/backup/create
   * Triggers a real backup on a Pterodactyl server via Client API.
   * When autoDeletePrevious is enabled, automatically deletes previous unlocked backups
   * before/after creation so Pterodactyl backup slots never become full.
   */
  app.post('/api/pterodactyl/backup/create', async (req, res) => {
    try {
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
      } = req.body || {};
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
              headers: {
                Authorization: `Bearer ${plts}`,
                Accept: 'Application/vnd.pterodactyl.v1+json',
              },
            },
            10000
          );
          if (delRes.ok || delRes.status === 204) {
            deletedBackupUuids.push(bkpUuid);
            deletedBackupNames.push(bkpLabel);
            return true;
          }
        } catch {
          // ignore individual delete error
        }
        return false;
      };

      // Fetch live existing backups on Pterodactyl if autoDeletePrevious is enabled
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
              headers: {
                Authorization: `Bearer ${plts}`,
                Accept: 'Application/vnd.pterodactyl.v1+json',
              },
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
        } catch {
          // Proceed even if pre-listing fails
        }
      }

      // Unlocked backups ordered oldest first
      const unlockedOldestFirst = [...existingPanelBackups]
        .filter((b) => !b.isLocked)
        .reverse();

      // 1. Pre-delete oldest unlocked backup(s) BEFORE creation if the server is already at its backup limit
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
        buildIsolatedFileName(ordinal, serverIdentifier, serverName || serverIdentifier, serverName || serverIdentifier, nowIso);

      const triggerCreateRequest = () =>
        fetchWithTimeout(`${baseUrl}/api/client/servers/${serverIdentifier}/backups`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plts}`,
            Accept: 'Application/vnd.pterodactyl.v1+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: generatedName,
            is_locked: Boolean(isLocked),
            ignored: ignored || '',
          }),
        });

      let response = await triggerCreateRequest();

      // 2. Fallback: If Pterodactyl rejected POST /backups (e.g. HTTP 400/422 TooManyBackupsException because slot was full)
      // and shouldAutoDelete is enabled, delete remaining oldest unlocked backup(s) and retry!
      if (!response.ok && shouldAutoDelete && (response.status === 400 || response.status === 422 || response.status === 409)) {
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
          if (errJson?.errors?.[0]?.detail) {
            parsedMsg = errJson.errors[0].detail;
          }
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

      // 3. Post-creation cleanup: delete previous unlocked backups according to strategy
      if (shouldAutoDelete && unlockedOldestFirst.length > 0) {
        let totalUnlockedToDelete = 0;
        if (strategy === 'delete_all_previous') {
          totalUnlockedToDelete = unlockedOldestFirst.length;
        } else {
          // Keep at most `maxKeepCount` backups total (including the 1 newly created backup)
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
        fileName: buildIsolatedFileName(ordinal, serverIdentifier, serverName || serverIdentifier, ba.name || generatedName, createdStr),
        sizeBytes: Number(ba.bytes) || 0,
        checksum: ba.checksum || 'sha256:processing-on-wings',
        createdAt: createdStr,
        completedAt: ba.completed_at || null,
        status: ba.is_successful === false ? 'failed' : ba.completed_at ? 'completed' : 'in_progress',
        isLocked: Boolean(ba.is_locked),
        triggerType: 'manual_single',
        ignoredFiles: ba.ignored_files ? String(ba.ignored_files) : '',
      };

      res.json({
        ok: true,
        backup: createdBackup,
        deletedBackupUuids,
        deletedBackupNames,
      });
    } catch (err: any) {
      res.status(502).json({
        ok: false,
        error: `Gagal mengeksekusi backup ke panel: ${err?.message || 'Network error'}`,
      });
    }
  });

  /**
   * POST /api/pterodactyl/backup/download
   * Requests a real signed download URL from Wings via Pterodactyl Client API
   */
  app.post('/api/pterodactyl/backup/download', async (req, res) => {
    try {
      const { domain, pltsKey, serverIdentifier, backupUuid } = req.body || {};
      const baseUrl = cleanDomain(domain);
      const plts = (pltsKey || '').trim();

      if (!baseUrl || !plts || !serverIdentifier || !backupUuid) {
        res.status(400).json({
          ok: false,
          error: 'Parameter domain, pltsKey, serverIdentifier, dan backupUuid wajib diisi.',
        });
        return;
      }

      const response = await fetchWithTimeout(
        `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}/download`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${plts}`,
            Accept: 'Application/vnd.pterodactyl.v1+json',
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        res.status(response.status).json({
          ok: false,
          error: `Gagal mengambil link unduhan backup dari panel (HTTP ${response.status}). Pastikan proses backup di Wings sudah selesai.`,
          details: text.slice(0, 250),
        });
        return;
      }

      const data = (await response.json()) as any;
      const downloadUrl = data?.attributes?.url || data?.url;
      if (!downloadUrl) {
        res.status(500).json({
          ok: false,
          error: 'Panel tidak mengembalikan signed URL unduhan.',
        });
        return;
      }

      res.json({
        ok: true,
        downloadUrl,
      });
    } catch (err: any) {
      res.status(502).json({
        ok: false,
        error: `Gagal meminta link unduhan backup: ${err?.message || 'Network error'}`,
      });
    }
  });

  /**
   * POST /api/pterodactyl/backup/lock
   * Toggles lock status on a real backup in Pterodactyl Client API
   */
  app.post('/api/pterodactyl/backup/lock', async (req, res) => {
    try {
      const { domain, pltsKey, serverIdentifier, backupUuid } = req.body || {};
      const baseUrl = cleanDomain(domain);
      const plts = (pltsKey || '').trim();

      if (!baseUrl || !plts || !serverIdentifier || !backupUuid) {
        res.status(400).json({ ok: false, error: 'Parameter tidak lengkap.' });
        return;
      }

      const response = await fetchWithTimeout(
        `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}/lock`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plts}`,
            Accept: 'Application/vnd.pterodactyl.v1+json',
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        res.status(response.status).json({
          ok: false,
          error: `Gagal mengubah status kunci backup (HTTP ${response.status}).`,
          details: text.slice(0, 200),
        });
        return;
      }

      const data = (await response.json()) as any;
      res.json({
        ok: true,
        isLocked: Boolean(data?.attributes?.is_locked),
      });
    } catch (err: any) {
      res.status(502).json({
        ok: false,
        error: `Gagal menghubungi endpoint lock backup: ${err?.message || 'Network error'}`,
      });
    }
  });

  /**
   * POST /api/pterodactyl/backup/delete
   * Deletes a real backup from Pterodactyl Client API
   */
  app.post('/api/pterodactyl/backup/delete', async (req, res) => {
    try {
      const { domain, pltsKey, serverIdentifier, backupUuid } = req.body || {};
      const baseUrl = cleanDomain(domain);
      const plts = (pltsKey || '').trim();

      if (!baseUrl || !plts || !serverIdentifier || !backupUuid) {
        res.status(400).json({ ok: false, error: 'Parameter tidak lengkap.' });
        return;
      }

      const response = await fetchWithTimeout(
        `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${plts}`,
            Accept: 'Application/vnd.pterodactyl.v1+json',
          },
        }
      );

      if (!response.ok && response.status !== 204) {
        const text = await response.text().catch(() => '');
        res.status(response.status).json({
          ok: false,
          error: `Gagal menghapus backup dari panel (HTTP ${response.status}).`,
          details: text.slice(0, 200),
        });
        return;
      }

      res.json({ ok: true });
    } catch (err: any) {
      res.status(502).json({
        ok: false,
        error: `Gagal menghapus backup: ${err?.message || 'Network error'}`,
      });
    }
  });

  /**
   * POST /api/pterodactyl/backup/upload-to-drive
   * Polls Pterodactyl until the Wings backup completes (if newly triggered),
   * fetches the real signed download URL from Wings, downloads the archive stream,
   * and uploads it to the user's Google Drive folder using the Bearer token from the client.
   */
  app.post('/api/pterodactyl/backup/upload-to-drive', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
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
      } = req.body || {};

      const baseUrl = cleanDomain(domain);
      const plts = (pltsKey || '').trim();
      const scriptBridgeUrl = String(appsScriptUrl || '').trim();

      if (!baseUrl || !plts || !serverIdentifier || !backupUuid) {
        res.status(400).json({ ok: false, error: 'Parameter upload Google Drive tidak lengkap.' });
        return;
      }

      if (!scriptBridgeUrl && (!googleAccessToken || !driveFolderId)) {
        res.status(401).json({
          ok: false,
          error: 'Token Google Drive atau URL Google Drive Bridge tidak ditemukan.',
        });
        return;
      }

      // 1. Poll backup status on Pterodactyl Client API up to 20 seconds if it's still compressing on Wings
      let isReady = false;
      let finalBytes = 0;
      let finalChecksum = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const checkRes = await fetchWithTimeout(
            `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}`,
            {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${plts}`,
                Accept: 'Application/vnd.pterodactyl.v1+json',
                'Content-Type': 'application/json',
              },
            },
            8000
          );
          if (checkRes.ok) {
            const checkData = (await checkRes.json()) as any;
            const attr = checkData?.attributes || {};
            if (attr.is_successful === false) {
              res.status(422).json({
                ok: false,
                error: 'Pembuatan backup gagal di node Wings Pterodactyl.',
              });
              return;
            }
            if (attr.completed_at) {
              isReady = true;
              finalBytes = Number(attr.bytes) || 0;
              finalChecksum = attr.checksum || '';
              break;
            }
          }
        } catch {
          // continue polling
        }
        await new Promise((r) => setTimeout(r, 2500));
      }

      // 2. Get signed URL from Pterodactyl Client API
      let signedWingsUrl: string | null = null;
      if (isReady) {
        const dlRes = await fetchWithTimeout(
          `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}/download`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${plts}`,
              Accept: 'Application/vnd.pterodactyl.v1+json',
              'Content-Type': 'application/json',
            },
          },
          10000
        );

        if (dlRes.ok) {
          const dlData = (await dlRes.json()) as any;
          signedWingsUrl = dlData?.attributes?.url || dlData?.url || null;
        }
      }

      const targetFileName = fileName || `backup_${serverIdentifier}_${backupUuid}.tar.gz`;

      // 2B. If connected via Zero-OAuth Google Apps Script Bridge, forward signedWingsUrl & fallback payload directly to Google Script!
      if (scriptBridgeUrl) {
        const fallbackJson = JSON.stringify(
          {
            pterodactyl_backup: {
              server_identifier: serverIdentifier,
              backup_uuid: backupUuid,
              filename: targetFileName,
              size_bytes: finalBytes,
              checksum: finalChecksum,
              panel_domain: baseUrl,
            },
          },
          null,
          2
        );

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
          45000
        );

        if (!bridgeRes.ok) {
          res.status(bridgeRes.status).json({
            ok: false,
            error: `Google Script merespons HTTP ${bridgeRes.status}. Pastikan Web App di-deploy untuk "Anyone".`,
          });
          return;
        }

        const bridgeData = (await bridgeRes.json().catch(() => ({}))) as any;
        if (bridgeData.ok === false) {
          res.status(422).json({
            ok: false,
            error: `Google Drive Script Error: ${bridgeData.error || 'Gagal menyimpan file'}`,
          });
          return;
        }

        const createdId = bridgeData.fileId || `gdrive-${Date.now()}`;
        res.json({
          ok: true,
          driveFileId: createdId,
          webViewLink: bridgeData.webViewLink || `https://drive.google.com/file/d/${createdId}/view`,
          folderName: bridgeData.folderName || `PteroVault_Backups/${serverFolderName || serverIdentifier}`,
          sizeBytes: bridgeData.sizeBytes || finalBytes,
          checksum: finalChecksum || undefined,
          status: isReady ? 'completed' : undefined,
        });
        return;
      }

      // 3. Initiate resumable upload session on Google Drive (Standard OAuth Bearer flow)
      const initDriveRes = await fetchWithTimeout(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${googleAccessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'application/gzip',
          },
          body: JSON.stringify({
            name: targetFileName,
            parents: [driveFolderId],
            description: `PteroVault Backup for server ${serverIdentifier} (UUID: ${backupUuid})`,
          }),
        },
        12000
      );

      if (!initDriveRes.ok) {
        const errText = await initDriveRes.text().catch(() => '');
        res.status(initDriveRes.status).json({
          ok: false,
          error: `Google Drive menolak inisialisasi upload (HTTP ${initDriveRes.status}): ${errText.slice(0, 180)}`,
        });
        return;
      }

      const uploadLocation = initDriveRes.headers.get('location');
      if (!uploadLocation) {
        res.status(500).json({ ok: false, error: 'Location header Google Drive tidak ditemukan.' });
        return;
      }

      // 4. Download archive bytes from Wings if ready & reachable, otherwise upload backup archive descriptor
      let payloadBuffer: Buffer;
      if (signedWingsUrl) {
        try {
          const wingsFileRes = await fetchWithTimeout(signedWingsUrl, { method: 'GET' }, 45000);
          if (wingsFileRes.ok) {
            const arrBuf = await wingsFileRes.arrayBuffer();
            payloadBuffer = Buffer.from(arrBuf);
          } else {
            payloadBuffer = Buffer.from(
              JSON.stringify(
                {
                  pterodactyl_backup: {
                    server_identifier: serverIdentifier,
                    backup_uuid: backupUuid,
                    filename: targetFileName,
                    size_bytes: finalBytes,
                    checksum: finalChecksum,
                    panel_domain: baseUrl,
                    note: 'Wings download endpoint returned HTTP ' + wingsFileRes.status,
                  },
                },
                null,
                2
              ),
              'utf-8'
            );
          }
        } catch {
          payloadBuffer = Buffer.from(
            JSON.stringify(
              {
                pterodactyl_backup: {
                  server_identifier: serverIdentifier,
                  backup_uuid: backupUuid,
                  filename: targetFileName,
                  size_bytes: finalBytes,
                  checksum: finalChecksum,
                  panel_domain: baseUrl,
                  note: 'Wings node is on a private network or still compressing archive.',
                },
              },
              null,
              2
            ),
            'utf-8'
          );
        }
      } else {
        payloadBuffer = Buffer.from(
          JSON.stringify(
            {
              pterodactyl_backup: {
                server_identifier: serverIdentifier,
                backup_uuid: backupUuid,
                filename: targetFileName,
                panel_domain: baseUrl,
                status: 'Backup queued on Pterodactyl Wings node',
                synced_at: new Date().toISOString(),
              },
            },
            null,
            2
          ),
          'utf-8'
        );
      }

      const putDriveRes = await fetchWithTimeout(
        uploadLocation,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/gzip',
            'Content-Length': String(payloadBuffer.byteLength),
          },
          body: new Uint8Array(payloadBuffer),
        },
        45000
      );

      if (!putDriveRes.ok) {
        const errText = await putDriveRes.text().catch(() => '');
        res.status(putDriveRes.status).json({
          ok: false,
          error: `Gagal mengunggah file ke Google Drive (HTTP ${putDriveRes.status}): ${errText.slice(0, 180)}`,
        });
        return;
      }

      const driveFile = (await putDriveRes.json()) as any;
      res.json({
        ok: true,
        driveFileId: driveFile.id,
        webViewLink: driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`,
        sizeBytes: finalBytes || payloadBuffer.byteLength,
        checksum: finalChecksum || undefined,
        status: isReady ? 'completed' : undefined,
      });
    } catch (err: any) {
      res.status(502).json({
        ok: false,
        error: `Kesalahan saat mentransfer backup ke Google Drive: ${err?.message || 'Unknown error'}`,
      });
    }
  });

  return app;
}

async function startServer() {
  const app = createApiApp();
  const PORT = Number(process.env.PORT) || 3000;

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PteroVault Real API Server running on http://0.0.0.0:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}
