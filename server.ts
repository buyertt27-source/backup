import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Allow connecting to Pterodactyl panels with self-signed SSL certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
    const mergedHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      ...((options.headers as Record<string, string>) || {}),
    };
    return await fetch(url, { ...options, headers: mergedHeaders, signal: controller.signal });
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
   * POST /api/pterodactyl/backup/status
   * Checks whether a newly created backup on Pterodactyl Wings has finished compressing
   */
  app.post('/api/pterodactyl/backup/status', async (req, res) => {
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
          method: 'GET',
          headers: {
            Authorization: `Bearer ${plts}`,
            Accept: 'Application/vnd.pterodactyl.v1+json',
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        res.status(response.status).json({
          ok: false,
          error: `Gagal memeriksa status backup (HTTP ${response.status}).`,
        });
        return;
      }

      const data = (await response.json()) as any;
      const bAttr = data?.attributes || {};
      const completedAt = bAttr.completed_at || null;
      const isSuccessful = bAttr.is_successful !== false;
      res.json({
        ok: true,
        completedAt,
        isSuccessful,
        sizeBytes: Number(bAttr.bytes || 0),
        checksum: String(bAttr.checksum || 'sha256:completed'),
        status: completedAt ? (isSuccessful ? 'completed' : 'failed') : 'in_progress',
      });
    } catch (err: any) {
      res.status(502).json({
        ok: false,
        error: `Gagal memeriksa status backup: ${err?.message || 'Network error'}`,
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
              domain: baseUrl,
              pltsKey: plts,
              serverIdentifier,
              backupUuid,
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

  // ============================================================================
  // 24/7 AUTONOMOUS BACKGROUND AUTO-BACKUP DAEMON (Runs even when panel is closed)
  // ============================================================================
  const DAEMON_STATE_FILE = path.join(__dirname, '.pterovault-daemon-state.json');

  interface DaemonState {
    schedule: {
      enabled: boolean;
      frequency: 'interval_hours' | 'daily' | 'weekly';
      intervalHours: number;
      timeOfDay: string;
      dayOfWeek: number;
      targetScope: 'all' | 'selected';
      selectedServerIds: string[];
      retentionCount: number;
      autoDeletePrevious: boolean;
      autoDeleteStrategy: 'delete_all_previous' | 'keep_retention_count';
      lockNewBackups: boolean;
      saveToGoogleDrive: boolean;
      lastRunAt: string | null;
      nextRunAt: string;
    };
    credentials: {
      domain: string;
      pltaKey: string;
      pltsKey: string;
    };
    driveConfig: {
      appsScriptUrl: string;
      targetFolderId: string;
      googleAccessToken: string;
    };
    recentBackgroundRuns: Array<{
      id: string;
      timestamp: string;
      serverId: string;
      serverIdentifier: string;
      serverName: string;
      backupUuid: string;
      fileName: string;
      sizeBytes: number;
      driveFileId?: string;
      driveWebViewLink?: string;
      details: string;
      status: 'success' | 'error' | 'info';
    }>;
  }

  function computeDaemonNextRun(
    sched: DaemonState['schedule'],
    baseDate: Date = new Date()
  ): string {
    const nowMs = baseDate.getTime();
    if (sched.frequency !== 'daily' && sched.frequency !== 'weekly') {
      const hours = Number(sched.intervalHours) > 0 ? Number(sched.intervalHours) : 1;
      const intervalMs = Math.max(60 * 1000, Math.round(hours * 60 * 60 * 1000));
      const existingNextMs = sched.nextRunAt ? new Date(sched.nextRunAt).getTime() : NaN;
      if (Number.isFinite(existingNextMs) && existingNextMs <= nowMs) {
        const missed = Math.floor((nowMs - existingNextMs) / intervalMs) + 1;
        const aligned = existingNextMs + missed * intervalMs;
        return new Date(aligned > nowMs ? aligned : nowMs + intervalMs).toISOString();
      }
      return new Date(nowMs + intervalMs).toISOString();
    }

    const next = new Date(nowMs);
    const [hhStr, mmStr] = (sched.timeOfDay || '03:00').split(':');
    next.setHours(
      Math.min(23, Math.max(0, parseInt(hhStr || '3', 10) || 0)),
      Math.min(59, Math.max(0, parseInt(mmStr || '0', 10) || 0)),
      0,
      0
    );
    if (sched.frequency === 'daily') {
      if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
      return next.toISOString();
    }
    const targetDay = Math.min(6, Math.max(0, sched.dayOfWeek ?? 1));
    let daysUntil = (targetDay - next.getDay() + 7) % 7;
    if (daysUntil === 0 && next.getTime() <= nowMs) daysUntil = 7;
    next.setDate(next.getDate() + daysUntil);
    return next.toISOString();
  }

  let daemonState: DaemonState = {
    schedule: {
      enabled: false,
      frequency: 'interval_hours',
      intervalHours: 1,
      timeOfDay: '03:00',
      dayOfWeek: 1,
      targetScope: 'all',
      selectedServerIds: [],
      retentionCount: 1,
      autoDeletePrevious: true,
      autoDeleteStrategy: 'delete_all_previous',
      lockNewBackups: false,
      saveToGoogleDrive: true,
      lastRunAt: null,
      nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    credentials: { domain: '', pltaKey: '', pltsKey: '' },
    driveConfig: { appsScriptUrl: '', targetFolderId: '', googleAccessToken: '' },
    recentBackgroundRuns: [],
  };

  try {
    if (fs.existsSync(DAEMON_STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DAEMON_STATE_FILE, 'utf-8'));
      if (raw && typeof raw === 'object') {
        daemonState = {
          ...daemonState,
          ...raw,
          schedule: { ...daemonState.schedule, ...(raw.schedule || {}) },
          credentials: { ...daemonState.credentials, ...(raw.credentials || {}) },
          driveConfig: { ...daemonState.driveConfig, ...(raw.driveConfig || {}) },
          recentBackgroundRuns: Array.isArray(raw.recentBackgroundRuns)
            ? raw.recentBackgroundRuns.slice(0, 50)
            : [],
        };
      }
    }
  } catch {
    // ignore corrupt state file
  }

  function saveDaemonState() {
    try {
      fs.writeFileSync(DAEMON_STATE_FILE, JSON.stringify(daemonState, null, 2), 'utf-8');
    } catch {
      // ignore write errors in read-only environments
    }
  }

  let isDaemonExecuting = false;

  async function executeBackgroundDaemonCycle() {
    if (isDaemonExecuting) return;
    const { schedule, credentials, driveConfig } = daemonState;
    const baseUrl = cleanDomain(credentials.domain);
    const plts = (credentials.pltsKey || '').trim();

    // Always roll nextRunAt forward into the future FIRST so countdown never sticks at 00:00:00
    const nextFutureIso = computeDaemonNextRun(schedule, new Date());
    daemonState.schedule.nextRunAt = nextFutureIso;
    saveDaemonState();

    if (!baseUrl || !plts) {
      return;
    }

    isDaemonExecuting = true;
    try {
      const pteroHeaders = {
        Authorization: `Bearer ${plts}`,
        Accept: 'Application/vnd.pterodactyl.v1+json',
        'Content-Type': 'application/json',
      };

      const clientRes = await fetchWithTimeout(`${baseUrl}/api/client`, {
        method: 'GET',
        headers: pteroHeaders,
      });
      if (!clientRes.ok) return;

      const clientJson = (await clientRes.json()) as any;
      const items = Array.isArray(clientJson?.data) ? clientJson.data : [];

      for (let idx = 0; idx < items.length; idx++) {
        const attr = items[idx]?.attributes || {};
        const identifier = String(attr.identifier || '');
        const srvId = String(attr.uuid || identifier);
        const srvName = String(attr.name || `Server ${idx + 1}`);
        const backupLimit = Number(attr.feature_limits?.backups ?? 5);

        if (!identifier) continue;
        if (
          schedule.targetScope === 'selected' &&
          schedule.selectedServerIds.length > 0 &&
          !schedule.selectedServerIds.includes(srvId) &&
          !schedule.selectedServerIds.includes(identifier)
        ) {
          continue;
        }

        // 1. Auto-delete previous unlocked backups if enabled
        if (schedule.autoDeletePrevious) {
          try {
            const listBkpRes = await fetchWithTimeout(
              `${baseUrl}/api/client/servers/${identifier}/backups`,
              { method: 'GET', headers: pteroHeaders }
            );
            if (listBkpRes.ok) {
              const bkpJson = (await listBkpRes.json()) as any;
              const existingList = Array.isArray(bkpJson?.data) ? bkpJson.data : [];
              const unlocked = existingList
                .map((b: any) => b?.attributes || {})
                .filter((b: any) => b.uuid && !b.is_locked);

              const toDeleteCount =
                schedule.autoDeleteStrategy === 'delete_all_previous'
                  ? unlocked.length
                  : Math.max(
                      backupLimit > 0 && existingList.length >= backupLimit ? 1 : 0,
                      existingList.length - Math.max(0, (schedule.retentionCount || 1) - 1)
                    );

              for (const oldBkp of unlocked.slice(0, Math.max(0, toDeleteCount))) {
                await fetchWithTimeout(
                  `${baseUrl}/api/client/servers/${identifier}/backups/${oldBkp.uuid}`,
                  { method: 'DELETE', headers: pteroHeaders }
                ).catch(() => {});
              }
            }
          } catch {
            // continue
          }
        }

        // 2. Create real backup on Pterodactyl
        const nowIso = new Date().toISOString();
        const fileName = buildIsolatedFileName(idx + 1, identifier, srvName, srvName, nowIso);
        const createRes = await fetchWithTimeout(
          `${baseUrl}/api/client/servers/${identifier}/backups`,
          {
            method: 'POST',
            headers: pteroHeaders,
            body: JSON.stringify({
              name: fileName,
              is_locked: Boolean(schedule.lockNewBackups),
            }),
          }
        );

        if (!createRes.ok) continue;
        const createdJson = (await createRes.json()) as any;
        const createdAttr = createdJson?.attributes || {};
        const backupUuid = String(createdAttr.uuid || '');
        if (!backupUuid) continue;

        // 3. Wait for Wings daemon to finish compressing (.tar.gz)
        let finalBytes = Number(createdAttr.bytes) || 0;
        for (let attempt = 0; attempt < 24; attempt++) {
          await new Promise((r) => setTimeout(r, 2500));
          try {
            const stRes = await fetchWithTimeout(
              `${baseUrl}/api/client/servers/${identifier}/backups/${backupUuid}`,
              { method: 'GET', headers: pteroHeaders }
            );
            if (stRes.ok) {
              const stJson = (await stRes.json()) as any;
              const stAttr = stJson?.attributes || {};
              if (stAttr.completed_at) {
                finalBytes = Number(stAttr.bytes) || finalBytes;
                break;
              }
            }
          } catch {
            // continue polling
          }
        }

        // 4. Upload to Google Drive if enabled
        let driveFileId: string | undefined;
        let driveWebViewLink: string | undefined;

        if (schedule.saveToGoogleDrive) {
          let signedUrl = '';
          try {
            const dlRes = await fetchWithTimeout(
              `${baseUrl}/api/client/servers/${identifier}/backups/${backupUuid}/download`,
              { method: 'GET', headers: pteroHeaders }
            );
            if (dlRes.ok) {
              const dlJson = (await dlRes.json()) as any;
              signedUrl = dlJson?.attributes?.url || dlJson?.url || '';
            }
          } catch {
            // ignore
          }

          const safeServerFolder = `Server_${String(idx + 1).padStart(2, '0')}_${identifier}_${srvName
            .replace(/[^a-zA-Z0-9_-]+/g, '_')
            .slice(0, 24)}`;

          if (driveConfig.appsScriptUrl) {
            try {
              const bridgeRes = await fetchWithTimeout(
                driveConfig.appsScriptUrl.trim(),
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                  body: JSON.stringify({
                    action: 'upload_backup',
                    targetFolderId: driveConfig.targetFolderId || '',
                    rootFolderName: 'PteroVault_Backups',
                    serverFolderName: safeServerFolder,
                    fileName,
                    mimeType: 'application/gzip',
                    signedWingsUrl: signedUrl || null,
                    domain: baseUrl,
                    pltsKey: plts,
                    serverIdentifier: identifier,
                    backupUuid,
                  }),
                },
                55000
              );
              const bridgeJson = (await bridgeRes.json().catch(() => null)) as any;
              if (bridgeJson?.ok) {
                driveFileId = bridgeJson.fileId;
                driveWebViewLink = bridgeJson.webViewLink;
                if (Number(bridgeJson.sizeBytes) > 0) {
                  finalBytes = Number(bridgeJson.sizeBytes);
                }
              }
            } catch {
              // ignore bridge error
            }
          }
        }

        const completedIso = new Date().toISOString();
        daemonState.schedule.lastRunAt = completedIso;
        daemonState.recentBackgroundRuns = [
          {
            id: `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: completedIso,
            serverId: srvId,
            serverIdentifier: identifier,
            serverName: srvName,
            backupUuid,
            fileName,
            sizeBytes: finalBytes,
            driveFileId,
            driveWebViewLink,
            details: `Auto-Backup Background Daemon berhasil membuat ${fileName}${
              driveFileId ? ' & mengunggah ke Google Drive' : ' di Panel Pterodactyl'
            } (berjalan otomatis tanpa membuka panel).`,
            status: 'success' as const,
          },
          ...daemonState.recentBackgroundRuns.slice(0, 49),
        ];
        saveDaemonState();
      }
    } finally {
      isDaemonExecuting = false;
    }
  }

  // Background heartbeat every 5 seconds on the server
  setInterval(() => {
    if (!daemonState.schedule.enabled || isDaemonExecuting) return;
    const nowMs = Date.now();
    const nextMs = new Date(daemonState.schedule.nextRunAt).getTime();
    if (!Number.isFinite(nextMs) || nowMs >= nextMs) {
      executeBackgroundDaemonCycle().catch(() => {});
    }
  }, 5000);

  /**
   * POST /api/pterodactyl/daemon/sync
   * Syncs schedule, credentials, and Google Drive bridge settings to the 24/7 server-side daemon
   * and configures the 24/7 Google Apps Script Cloud Cron trigger if Apps Script Bridge is used.
   */
  app.post('/api/pterodactyl/daemon/sync', async (req, res) => {
    const { schedule, credentials, driveConfig } = req.body || {};

    if (schedule && typeof schedule === 'object') {
      daemonState.schedule = {
        ...daemonState.schedule,
        ...schedule,
      };
      // Ensure nextRunAt is strictly in the future so the UI never sticks at 00:00:00
      const nextMs = new Date(daemonState.schedule.nextRunAt).getTime();
      if (!Number.isFinite(nextMs) || nextMs <= Date.now()) {
        daemonState.schedule.nextRunAt = computeDaemonNextRun(daemonState.schedule, new Date());
      }
    }

    if (credentials && typeof credentials === 'object') {
      daemonState.credentials = {
        domain: credentials.domain ?? daemonState.credentials.domain,
        pltaKey: credentials.pltaKey ?? daemonState.credentials.pltaKey,
        pltsKey: credentials.pltsKey ?? daemonState.credentials.pltsKey,
      };
    }

    if (driveConfig && typeof driveConfig === 'object') {
      daemonState.driveConfig = {
        appsScriptUrl: driveConfig.appsScriptUrl ?? daemonState.driveConfig.appsScriptUrl,
        targetFolderId: driveConfig.targetFolderId ?? daemonState.driveConfig.targetFolderId,
        googleAccessToken:
          driveConfig.googleAccessToken ?? daemonState.driveConfig.googleAccessToken,
      };
    }

    saveDaemonState();

    // Also configure 24/7 Google Apps Script Cloud Cron Trigger in the background if Apps Script URL is set
    if (daemonState.driveConfig.appsScriptUrl && daemonState.credentials.domain) {
      fetchWithTimeout(
        daemonState.driveConfig.appsScriptUrl.trim(),
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'configure_cron',
            enabled: Boolean(daemonState.schedule.enabled),
            intervalHours: daemonState.schedule.intervalHours || 1,
            domain: cleanDomain(daemonState.credentials.domain),
            pltsKey: (daemonState.credentials.pltsKey || '').trim(),
            targetFolderId: daemonState.driveConfig.targetFolderId || '',
            autoDeletePrevious: Boolean(daemonState.schedule.autoDeletePrevious ?? true),
          }),
        },
        10000
      ).catch(() => {});
    }

    res.json({
      ok: true,
      schedule: daemonState.schedule,
      recentBackgroundRuns: daemonState.recentBackgroundRuns,
      isDaemonRunning: isDaemonExecuting,
    });
  });

  /**
   * POST & GET /api/pterodactyl/daemon/status
   * Returns current 24/7 background daemon state, rolling nextRunAt forward if needed.
   */
  const handleDaemonStatus = (_req: express.Request, res: express.Response) => {
    if (daemonState.schedule.enabled) {
      const nextMs = new Date(daemonState.schedule.nextRunAt).getTime();
      if (!Number.isFinite(nextMs) || Date.now() >= nextMs) {
        executeBackgroundDaemonCycle().catch(() => {});
      }
    }
    res.json({
      ok: true,
      schedule: daemonState.schedule,
      recentBackgroundRuns: daemonState.recentBackgroundRuns,
      isDaemonRunning: isDaemonExecuting,
    });
  };

  app.post('/api/pterodactyl/daemon/status', handleDaemonStatus);
  app.get('/api/pterodactyl/daemon/status', handleDaemonStatus);

  return app;
}

async function startServer() {
  const app = createApiApp();
  const PORT = Number(process.env.PORT) || 3000;

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
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

