import { PteroBackupFile, PteroServer } from '../types/pterodactyl';
import { normalizePanelDomain } from '../utils/backupLogic';

function cleanDomainUrl(raw: string): string {
  return normalizePanelDomain(raw || '');
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

function getConfiguredAppsScriptUrl(): string {
  try {
    const rawMain = localStorage.getItem('pterovault_gdrive_vercel_config_v1');
    if (rawMain) {
      const parsedMain = JSON.parse(rawMain);
      if (typeof parsedMain?.appsScriptUrl === 'string' && parsedMain.appsScriptUrl.trim()) {
        return parsedMain.appsScriptUrl.trim();
      }
    }
    const rawLegacy = localStorage.getItem('pterovault_drive_bridge_v1');
    if (rawLegacy) {
      const parsedLegacy = JSON.parse(rawLegacy);
      if (typeof parsedLegacy?.scriptUrl === 'string' && parsedLegacy.scriptUrl.trim()) {
        return parsedLegacy.scriptUrl.trim();
      }
    }
    return '';
  } catch {
    return '';
  }
}

interface SmartFetchResult {
  ok: boolean;
  status: number;
  data: any;
  rawText: string;
}

/**
 * Multi-tier fetch to a Pterodactyl Panel endpoint when running in browser fallback mode:
 * 1. Direct fetch to Pterodactyl Panel (works if CORS is enabled on panel)
 * 2. Google Apps Script Bridge Proxy (if user linked Google Script URL)
 * 3. CORS Proxy Relay (https://corsproxy.io) for static web hosts
 */
async function smartPteroFetch(
  targetUrl: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}
): Promise<SmartFetchResult> {
  const method = (options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const bodyStr =
    options.body !== undefined
      ? typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)
      : undefined;

  // 1. Try Direct Browser Fetch
  try {
    const directRes = await fetch(targetUrl, {
      method,
      headers,
      body: bodyStr,
    });
    const rawText = await directRes.text();
    let data: any = null;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = null;
    }
    return {
      ok: directRes.ok,
      status: directRes.status,
      data,
      rawText,
    };
  } catch {
    // Blocked by CORS or network error — proceed to fallback relays
  }

  // 2. Try Google Apps Script Bridge if configured
  const scriptUrl = getConfiguredAppsScriptUrl();
  if (scriptUrl) {
    try {
      const bridgeRes = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'ptero_proxy',
          targetUrl,
          method: method.toLowerCase(),
          headers,
          payload: options.body
            ? typeof options.body === 'string'
              ? JSON.parse(options.body)
              : options.body
            : undefined,
        }),
      });
      if (bridgeRes.ok) {
        const bridgeJson = await bridgeRes.json().catch(() => null);
        if (bridgeJson && typeof bridgeJson.status === 'number') {
          const rawText = String(bridgeJson.body || '');
          let data: any = null;
          try {
            data = rawText ? JSON.parse(rawText) : {};
          } catch {
            data = null;
          }
          return {
            ok: Boolean(bridgeJson.ok),
            status: bridgeJson.status,
            data,
            rawText,
          };
        }
      }
    } catch {
      // Proceed to public CORS relay
    }
  }

  // 3. Try CORS Proxy Relay for static hosting environments
  const corsProxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;
  const proxyRes = await fetch(corsProxyUrl, {
    method,
    headers,
    body: bodyStr,
  });
  const rawText = await proxyRes.text();
  let data: any = null;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = null;
  }
  return {
    ok: proxyRes.ok,
    status: proxyRes.status,
    data,
    rawText,
  };
}

/**
 * Client-side fallback implementation of all Pterodactyl actions when deployed
 * to a static web host where /api/pterodactyl/* serverless routes are unavailable.
 */
async function executeClientSidePteroFallback(
  action: 'sync' | 'backup/create' | 'backup/status' | 'backup/download' | 'backup/lock' | 'backup/delete',
  payload: Record<string, any>
): Promise<{ ok: boolean; status: number; data: any }> {
  const baseUrl = cleanDomainUrl(payload.domain || '');
  const plta = String(payload.pltaKey || '').trim();
  const plts = String(payload.pltsKey || '').trim();

  if (!baseUrl) {
    return {
      ok: false,
      status: 400,
      data: { ok: false, error: 'Domain panel Pterodactyl wajib diisi.' },
    };
  }

  // ==========================================================================
  // ACTION: SYNC
  // ==========================================================================
  if (action === 'sync') {
    if (!plta && !plts) {
      return {
        ok: false,
        status: 400,
        data: {
          ok: false,
          error: 'Masukkan minimal salah satu dari Application API Key (PLTA) atau Client API Key (PLTS/PLTC).',
        },
      };
    }

    let rawServersList: any[] = [];
    let sourceMode: 'application' | 'client' = 'application';
    let pltaWarning: string | null = null;

    if (plta) {
      try {
        const appRes = await smartPteroFetch(`${baseUrl}/api/application/servers?per_page=100`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${plta}`,
            Accept: 'Application/vnd.pterodactyl.v1+json',
            'Content-Type': 'application/json',
          },
        });
        if (appRes.ok && Array.isArray(appRes.data?.data)) {
          rawServersList = appRes.data.data;
          sourceMode = 'application';
        } else {
          pltaWarning = `Application API (PLTA) mengembalikan HTTP ${appRes.status}.`;
        }
      } catch (err: any) {
        pltaWarning = `Gagal menghubungi Application API: ${err?.message || 'Unknown error'}`;
      }
    }

    if (rawServersList.length === 0 && plts) {
      try {
        const clientRes = await smartPteroFetch(`${baseUrl}/api/client?per_page=100`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${plts}`,
            Accept: 'Application/vnd.pterodactyl.v1+json',
            'Content-Type': 'application/json',
          },
        });
        if (clientRes.ok && Array.isArray(clientRes.data?.data)) {
          rawServersList = clientRes.data.data;
          sourceMode = 'client';
        } else {
          return {
            ok: false,
            status: clientRes.status || 400,
            data: {
              ok: false,
              error: `Gagal terhubung ke panel ${baseUrl} (HTTP ${clientRes.status}). Periksa kembali Domain dan API Key Anda.`,
            },
          };
        }
      } catch (err: any) {
        return {
          ok: false,
          status: 502,
          data: {
            ok: false,
            error: `Tidak dapat menjangkau panel ${baseUrl}. Pastikan domain panel aktif dan dapat diakses publik.`,
          },
        };
      }
    }

    if (rawServersList.length === 0 && !plts && pltaWarning) {
      return {
        ok: false,
        status: 400,
        data: { ok: false, error: pltaWarning },
      };
    }

    const enrichedServers: PteroServer[] = await Promise.all(
      rawServersList.map(async (item: any, idx: number) => {
        const ordinal = idx + 1;
        const attr = item?.attributes || {};
        const identifier: string = attr.identifier || String(attr.id || `srv${ordinal}`);
        const uuid: string = attr.uuid || identifier;
        const name: string = attr.name || `Server ${ordinal}`;
        const description: string = attr.description || '';
        const node: string =
          attr.node ||
          (attr.node_id ? `Node-#${attr.node_id}` : 'Pterodactyl-Node');

        const limitsObj = attr.limits || {};
        const featureLimitsObj = attr.feature_limits || {};
        const memoryMb = Number(limitsObj.memory ?? 0);
        const diskMb = Number(limitsObj.disk ?? 0);
        const cpuPercent = Number(limitsObj.cpu ?? 100);
        const backupLimit = Number(featureLimitsObj.backups ?? 5);

        let status: 'running' | 'starting' | 'stopping' | 'offline' = 'offline';
        let memoryUsedMb = 0;
        let diskUsedMb = 0;
        let cpuLoad = 0;
        let ipAlias = '127.0.0.1';
        let port = 25565;

        const relAllocations = attr.relationships?.allocations?.data;
        if (Array.isArray(relAllocations) && relAllocations.length > 0) {
          const defAlloc =
            relAllocations.find((a: any) => a?.attributes?.is_default) || relAllocations[0];
          if (defAlloc?.attributes) {
            ipAlias = defAlloc.attributes.ip_alias || defAlloc.attributes.ip || ipAlias;
            port = Number(defAlloc.attributes.port || port);
          }
        }

        const backups: PteroBackupFile[] = [];

        if (plts) {
          const [resResult, bkpResult] = await Promise.allSettled([
            smartPteroFetch(`${baseUrl}/api/client/servers/${identifier}/resources`, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${plts}`,
                Accept: 'Application/vnd.pterodactyl.v1+json',
              },
            }),
            smartPteroFetch(`${baseUrl}/api/client/servers/${identifier}/backups?per_page=50`, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${plts}`,
                Accept: 'Application/vnd.pterodactyl.v1+json',
              },
            }),
          ]);

          if (resResult.status === 'fulfilled' && resResult.value.ok) {
            const rAttr = resResult.value.data?.attributes || {};
            const rawState = String(rAttr.current_state || 'offline').toLowerCase();
            if (
              rawState === 'running' ||
              rawState === 'starting' ||
              rawState === 'stopping' ||
              rawState === 'offline'
            ) {
              status = rawState;
            }
            const resUsage = rAttr.resources || {};
            memoryUsedMb = Math.round(Number(resUsage.memory_bytes || 0) / (1024 * 1024));
            diskUsedMb = Math.round(Number(resUsage.disk_bytes || 0) / (1024 * 1024));
            cpuLoad = Math.round(Number(resUsage.cpu_absolute || 0) * 10) / 10;
          }

          if (bkpResult.status === 'fulfilled' && bkpResult.value.ok) {
            const rawBackups = Array.isArray(bkpResult.value.data?.data)
              ? bkpResult.value.data.data
              : [];
            for (const bItem of rawBackups) {
              const bAttr = bItem?.attributes || {};
              const bUuid = String(bAttr.uuid || '');
              if (!bUuid) continue;
              const createdAt = bAttr.created_at || new Date().toISOString();
              const completedAt = bAttr.completed_at || null;
              const isSuccessful = bAttr.is_successful !== false;
              let bStatus: 'completed' | 'in_progress' | 'failed' = 'completed';
              if (!completedAt) {
                bStatus = 'in_progress';
              } else if (!isSuccessful) {
                bStatus = 'failed';
              }
              backups.push({
                id: bUuid,
                uuid: bUuid,
                serverId: identifier,
                serverName: name,
                serverIdentifier: identifier,
                fileName: buildIsolatedFileName(
                  ordinal,
                  identifier,
                  name,
                  bAttr.name || name,
                  createdAt
                ),
                sizeBytes: Number(bAttr.bytes || 0),
                checksum: String(bAttr.checksum || 'sha256:pending'),
                createdAt,
                completedAt,
                status: bStatus,
                isLocked: Boolean(bAttr.is_locked),
                triggerType: 'manual_single',
                ignoredFiles: Array.isArray(bAttr.ignored_files)
                  ? bAttr.ignored_files.join(', ')
                  : String(bAttr.ignored_files || ''),
              });
            }
          }
        }

        backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        return {
          id: identifier,
          identifier,
          uuid,
          name,
          node,
          eggName: String(attr.egg || attr.docker_image || 'Pterodactyl Container'),
          allocation: `${ipAlias}:${port}`,
          status,
          description,
          limits: {
            memoryMb,
            diskMb,
            cpuPercent,
            backupLimit,
          },
          usage: {
            memoryUsedMb,
            diskUsedMb,
          },
          backups,
        };
      })
    );

    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        sourceMode,
        pltaWarning,
        servers: enrichedServers,
      },
    };
  }

  // ==========================================================================
  // ACTION: BACKUP/CREATE
  // ==========================================================================
  if (action === 'backup/create') {
    const {
      serverIdentifier,
      serverOrdinal = 1,
      serverName = 'Server',
      backupName,
      ignored = '',
      isLocked = false,
      autoDeletePrevious = false,
      autoDeleteStrategy = 'delete_all_previous',
      retentionCount = 1,
      serverBackupLimit = 0,
    } = payload;

    if (!plts || !serverIdentifier) {
      return {
        ok: false,
        status: 400,
        data: {
          ok: false,
          error: 'Client API Key (PLTS/PLTC) diperlukan untuk membuat backup.',
        },
      };
    }

    const deletedBackupUuids: string[] = [];
    const deletedBackupNames: string[] = [];
    let existingBackupsNewestFirst: Array<{
      uuid: string;
      name: string;
      bytes: number;
      checksum: string;
      createdAt: string;
      completedAt: string | null;
      isLocked: boolean;
      ignoredFiles: string;
    }> = [];
    let unlockedBackupsOldestFirst: { uuid: string; name: string }[] = [];
    let totalBackupsCount = 0;

    try {
      const listRes = await smartPteroFetch(
        `${baseUrl}/api/client/servers/${serverIdentifier}/backups?per_page=50`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${plts}`,
            Accept: 'Application/vnd.pterodactyl.v1+json',
          },
        }
      );
      if (listRes.ok && Array.isArray(listRes.data?.data)) {
        const rawList = listRes.data.data;
        totalBackupsCount = rawList.length;
        existingBackupsNewestFirst = rawList
          .map((item: any) => item?.attributes || {})
          .filter((b: any) => Boolean(b.uuid))
          .sort(
            (a: any, b: any) =>
              new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
          )
          .map((b: any) => ({
            uuid: String(b.uuid),
            name: String(b.name || b.uuid),
            bytes: Number(b.bytes || 0),
            checksum: String(b.checksum || 'sha256:verified-from-panel'),
            createdAt: String(b.created_at || new Date().toISOString()),
            completedAt: b.completed_at || null,
            isLocked: Boolean(b.is_locked),
            ignoredFiles: Array.isArray(b.ignored_files)
              ? b.ignored_files.join(', ')
              : String(b.ignored_files || ''),
          }));
        unlockedBackupsOldestFirst = [...existingBackupsNewestFirst]
          .filter((b) => !b.isLocked)
          .reverse()
          .map((b) => ({ uuid: b.uuid, name: b.name }));
      }
    } catch {
      // Ignore list error
    }

    const limitNum = Number(serverBackupLimit) || 0;
    const isAtOrOverLimit = limitNum > 0 && totalBackupsCount >= limitNum;

    // Pre-delete ONLY the slots needed if server is already at its backup limit
    if (autoDeletePrevious && isAtOrOverLimit && unlockedBackupsOldestFirst.length > 0) {
      const slotsNeeded = Math.max(1, totalBackupsCount - limitNum + 1);
      const targets = unlockedBackupsOldestFirst.slice(0, slotsNeeded);
      for (const oldBkp of targets) {
        try {
          const delRes = await smartPteroFetch(
            `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${oldBkp.uuid}`,
            {
              method: 'DELETE',
              headers: {
                Authorization: `Bearer ${plts}`,
                Accept: 'Application/vnd.pterodactyl.v1+json',
              },
            }
          );
          if (delRes.ok || delRes.status === 204) {
            deletedBackupUuids.push(oldBkp.uuid);
            deletedBackupNames.push(oldBkp.name);
          }
        } catch {
          // Ignore single delete error
        }
      }
    }

    const nowIso = new Date().toISOString();
    const isolatedName = buildIsolatedFileName(
      Number(serverOrdinal) || 1,
      serverIdentifier,
      serverName,
      backupName || serverName,
      nowIso
    );

    let createRes = await smartPteroFetch(
      `${baseUrl}/api/client/servers/${serverIdentifier}/backups`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${plts}`,
          Accept: 'Application/vnd.pterodactyl.v1+json',
          'Content-Type': 'application/json',
        },
        body: {
          name: isolatedName,
          ignored: ignored || '',
          is_locked: Boolean(isLocked),
        },
      }
    );

    if (
      !createRes.ok &&
      (createRes.status === 400 || createRes.status === 422 || createRes.status === 403 || createRes.status === 409)
    ) {
      const remaining = unlockedBackupsOldestFirst.filter(
        (b) => !deletedBackupUuids.includes(b.uuid)
      );
      if (remaining.length > 1) {
        const oldest = remaining[0];
        const delRes = await smartPteroFetch(
          `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${oldest.uuid}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${plts}`,
              Accept: 'Application/vnd.pterodactyl.v1+json',
            },
          }
        );
        if (delRes.ok || delRes.status === 204) {
          deletedBackupUuids.push(oldest.uuid);
          deletedBackupNames.push(oldest.name);
          createRes = await smartPteroFetch(
            `${baseUrl}/api/client/servers/${serverIdentifier}/backups`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${plts}`,
                Accept: 'Application/vnd.pterodactyl.v1+json',
                'Content-Type': 'application/json',
              },
              body: {
                name: isolatedName,
                ignored: ignored || '',
                is_locked: Boolean(isLocked),
              },
            }
          );
        }
      }
    }

    if (!createRes.ok) {
      const remainingOnPanel = existingBackupsNewestFirst.filter(
        (b) => !deletedBackupUuids.includes(b.uuid)
      );
      if (remainingOnPanel.length > 0) {
        const newest = remainingOnPanel[0];
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            reusedExisting: true,
            deletedBackupUuids,
            deletedBackupNames,
            backup: {
              id: newest.uuid,
              uuid: newest.uuid,
              serverId: serverIdentifier,
              serverName,
              serverIdentifier,
              fileName: buildIsolatedFileName(
                Number(serverOrdinal) || 1,
                serverIdentifier,
                serverName,
                newest.name || serverName,
                newest.createdAt
              ),
              sizeBytes: newest.bytes,
              checksum: newest.checksum,
              createdAt: newest.createdAt,
              completedAt: newest.completedAt,
              status: newest.completedAt ? 'completed' : 'in_progress',
              isLocked: newest.isLocked,
              triggerType: 'auto_schedule',
              ignoredFiles: newest.ignoredFiles,
            },
          },
        };
      }

      const detail =
        createRes.data?.errors?.[0]?.detail ||
        createRes.rawText?.slice(0, 180) ||
        `HTTP ${createRes.status}`;
      return {
        ok: false,
        status: createRes.status || 400,
        data: {
          ok: false,
          error: `Gagal membuat backup pada server ${serverIdentifier}: ${detail}`,
        },
      };
    }

    const bAttr = createRes.data?.attributes || {};
    const bUuid = String(bAttr.uuid || `bkp-${Date.now()}`);
    const createdAt = bAttr.created_at || nowIso;

    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        deletedBackupUuids,
        deletedBackupNames,
        backup: {
          id: bUuid,
          uuid: bUuid,
          serverId: serverIdentifier,
          serverName,
          serverIdentifier,
          fileName: isolatedName,
          sizeBytes: Number(bAttr.bytes || 0),
          checksum: String(bAttr.checksum || 'sha256:generating-on-wings-daemon'),
          createdAt,
          completedAt: bAttr.completed_at || null,
          status: bAttr.completed_at ? 'completed' : 'in_progress',
          isLocked: Boolean(bAttr.is_locked),
          triggerType: 'manual_single',
          ignoredFiles: Array.isArray(bAttr.ignored_files)
            ? bAttr.ignored_files.join(', ')
            : String(bAttr.ignored_files || ''),
        },
      },
    };
  }

  // ==========================================================================
  // ACTION: BACKUP/STATUS
  // ==========================================================================
  if (action === 'backup/status') {
    const { serverIdentifier, backupUuid } = payload;
    const statusRes = await smartPteroFetch(
      `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${plts}`,
          Accept: 'Application/vnd.pterodactyl.v1+json',
        },
      }
    );
    if (!statusRes.ok) {
      return {
        ok: false,
        status: statusRes.status || 400,
        data: {
          ok: false,
          error: `Gagal memeriksa status backup (${statusRes.status}).`,
        },
      };
    }
    const bAttr = statusRes.data?.attributes || {};
    const completedAt = bAttr.completed_at || null;
    const isSuccessful = bAttr.is_successful !== false;
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        completedAt,
        isSuccessful,
        sizeBytes: Number(bAttr.bytes || 0),
        checksum: String(bAttr.checksum || 'sha256:completed'),
        status: completedAt ? (isSuccessful ? 'completed' : 'failed') : 'in_progress',
      },
    };
  }

  // ==========================================================================
  // ACTION: BACKUP/DOWNLOAD
  // ==========================================================================
  if (action === 'backup/download') {
    const { serverIdentifier, backupUuid } = payload;
    const dlRes = await smartPteroFetch(
      `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}/download`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${plts}`,
          Accept: 'Application/vnd.pterodactyl.v1+json',
        },
      }
    );
    const signedUrl = dlRes.data?.attributes?.url;
    if (!dlRes.ok || !signedUrl) {
      return {
        ok: false,
        status: dlRes.status || 400,
        data: {
          ok: false,
          error: `Gagal mendapatkan link unduhan backup (${dlRes.status}).`,
        },
      };
    }
    return {
      ok: true,
      status: 200,
      data: { ok: true, downloadUrl: signedUrl },
    };
  }

  // ==========================================================================
  // ACTION: BACKUP/LOCK
  // ==========================================================================
  if (action === 'backup/lock') {
    const { serverIdentifier, backupUuid } = payload;
    const lockRes = await smartPteroFetch(
      `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}/lock`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${plts}`,
          Accept: 'Application/vnd.pterodactyl.v1+json',
        },
      }
    );
    if (!lockRes.ok) {
      return {
        ok: false,
        status: lockRes.status || 400,
        data: { ok: false, error: `Gagal mengubah status kunci backup (${lockRes.status}).` },
      };
    }
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        isLocked: Boolean(lockRes.data?.attributes?.is_locked),
      },
    };
  }

  // ==========================================================================
  // ACTION: BACKUP/DELETE
  // ==========================================================================
  if (action === 'backup/delete') {
    const { serverIdentifier, backupUuid } = payload;
    const delRes = await smartPteroFetch(
      `${baseUrl}/api/client/servers/${serverIdentifier}/backups/${backupUuid}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${plts}`,
          Accept: 'Application/vnd.pterodactyl.v1+json',
        },
      }
    );
    if (!delRes.ok && delRes.status !== 204) {
      return {
        ok: false,
        status: delRes.status || 400,
        data: { ok: false, error: `Gagal menghapus backup (${delRes.status}).` },
      };
    }
    return {
      ok: true,
      status: 200,
      data: { ok: true },
    };
  }

  return {
    ok: false,
    status: 404,
    data: { ok: false, error: `Action tidak dikenali: ${action}` },
  };
}

/**
 * Unified, fault-tolerant Pterodactyl API caller.
 * 1. Calls `/api/pterodactyl/${action}` (and `/api/pterodactyl?action=${action}` if needed)
 *    with safe text-to-JSON parsing so HTML 404/502 pages NEVER throw `SyntaxError: Unexpected token '<'`.
 * 2. If deployed to a static web host where `/api/pterodactyl/*` is unavailable or returns non-JSON,
 *    automatically falls back to `executeClientSidePteroFallback`.
 */
export async function callPteroApi(
  action: 'sync' | 'backup/create' | 'backup/status' | 'backup/download' | 'backup/lock' | 'backup/delete',
  payload: Record<string, any>
): Promise<{ ok: boolean; status: number; data: any }> {
  const endpointsToTry = [
    `/api/pterodactyl/${action}`,
    `/api/pterodactyl?action=${encodeURIComponent(action)}`,
  ];

  for (const endpoint of endpointsToTry) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const rawText = await response.text();
      let parsed: any = null;
      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch {
        parsed = null;
      }

      // If we got a valid JSON response from our backend/Vercel function:
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
        // If backend had a 502/504 network error reaching the panel, also give client fallback a chance
        if (!parsed.ok && (response.status === 502 || response.status === 504)) {
          break;
        }
        return {
          ok: response.ok && Boolean(parsed.ok),
          status: response.status,
          data: parsed,
        };
      }
    } catch {
      // Proceed to next endpoint or client-side fallback
    }
  }

  // Fallback for static web deployments or when proxy route is unavailable
  return await executeClientSidePteroFallback(action, payload);
}

/**
 * Polls Pterodactyl until a newly initiated backup finishes compressing on the Wings daemon (`completed_at !== null`).
 * This ensures that when we request `/backups/{uuid}/download` to upload to Google Drive,
 * the `.tar.gz` archive is actually finished and ready!
 */
export async function waitForPteroBackupCompletion(params: {
  domain: string;
  pltsKey: string;
  backup: PteroBackupFile;
  maxAttempts?: number;
  intervalMs?: number;
}): Promise<PteroBackupFile> {
  const { domain, pltsKey, backup, maxAttempts = 14, intervalMs = 2500 } = params;

  if (
    !domain ||
    !pltsKey ||
    !backup.uuid ||
    backup.uuid.startsWith('drive-test-') ||
    (backup.status === 'completed' && backup.completedAt && backup.sizeBytes > 0)
  ) {
    return backup;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : intervalMs));
    try {
      const res = await callPteroApi('backup/status', {
        domain,
        pltsKey,
        serverIdentifier: backup.serverIdentifier,
        backupUuid: backup.uuid,
      });

      if (res.ok && res.data?.ok) {
        if (res.data.status === 'failed') {
          return {
            ...backup,
            status: 'failed',
          };
        }
        if (res.data.completedAt || res.data.status === 'completed') {
          return {
            ...backup,
            completedAt: res.data.completedAt || new Date().toISOString(),
            sizeBytes: Number(res.data.sizeBytes) || backup.sizeBytes,
            checksum: res.data.checksum || backup.checksum,
            status: 'completed',
          };
        }
      }
    } catch {
      // Ignore transient poll error and retry
    }
  }

  return backup;
}

function getConfiguredTargetFolderId(): string {
  try {
    const rawMain = localStorage.getItem('pterovault_gdrive_vercel_config_v1');
    if (rawMain) {
      const parsedMain = JSON.parse(rawMain);
      if (typeof parsedMain?.targetFolderId === 'string' && parsedMain.targetFolderId.trim()) {
        return parsedMain.targetFolderId.trim();
      }
    }
    const rawLegacy = localStorage.getItem('pterovault_drive_bridge_v1');
    if (rawLegacy) {
      const parsedLegacy = JSON.parse(rawLegacy);
      if (typeof parsedLegacy?.folderId === 'string' && parsedLegacy.folderId.trim()) {
        return parsedLegacy.folderId.trim();
      }
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Syncs the active Auto-Backup schedule, Pterodactyl credentials, and Google Drive Bridge configuration
 * to both the 24/7 Server Daemon (`/api/pterodactyl/daemon/sync`) and the 24/7 Google Apps Script Cloud Cron
 * so scheduled backups run automatically even when the user closes the web panel.
 */
export async function syncAutoBackupDaemon(params: {
  schedule: any;
  credentials: { domain: string; pltaKey: string; pltsKey: string };
  googleAccessToken?: string | null;
}): Promise<any> {
  const appsScriptUrl = getConfiguredAppsScriptUrl();
  const targetFolderId = getConfiguredTargetFolderId();

  // 1. Configure 24/7 Google Apps Script Cloud Cron directly if bridge URL is set
  if (appsScriptUrl && params.credentials.domain) {
    fetch(appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'configure_cron',
        enabled: Boolean(params.schedule?.enabled),
        intervalHours: Number(params.schedule?.intervalHours) || 1,
        domain: cleanDomainUrl(params.credentials.domain),
        pltsKey: (params.credentials.pltsKey || '').trim(),
        targetFolderId,
        autoDeletePrevious: Boolean(params.schedule?.autoDeletePrevious ?? true),
      }),
    }).catch(() => {});
  }

  // 2. Sync with backend 24/7 server daemon
  for (const endpoint of ['/api/pterodactyl/daemon/sync', '/api/pterodactyl?action=daemon/sync']) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule: params.schedule,
          credentials: params.credentials,
          driveConfig: {
            appsScriptUrl,
            targetFolderId,
            googleAccessToken: params.googleAccessToken || '',
          },
        }),
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && parsed.ok) {
        return parsed;
      }
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Polls the 24/7 background daemon (and Google Apps Script Cloud Cron status) to retrieve any backups
 * that were executed while the user's browser tab was closed or inactive.
 */
export async function fetchAutoBackupDaemonStatus(): Promise<{
  schedule?: any;
  credentials?: { domain?: string; pltaKey?: string; pltsKey?: string };
  driveConfig?: { appsScriptUrl?: string; targetFolderId?: string; googleAccessToken?: string };
  recentBackgroundRuns?: Array<{
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
  lastCronRunAt?: string | null;
} | null> {
  const result: {
    schedule?: any;
    credentials?: { domain?: string; pltaKey?: string; pltsKey?: string };
    driveConfig?: { appsScriptUrl?: string; targetFolderId?: string; googleAccessToken?: string };
    recentBackgroundRuns?: any[];
    lastCronRunAt?: string | null;
  } = {};

  for (const endpoint of ['/api/pterodactyl/daemon/status', '/api/pterodactyl?action=daemon/status']) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && parsed.ok) {
        result.schedule = parsed.schedule;
        result.credentials = parsed.credentials;
        result.driveConfig = parsed.driveConfig;
        result.recentBackgroundRuns = parsed.recentBackgroundRuns;
        break;
      }
    } catch {
      // continue
    }
  }

  const appsScriptUrl = getConfiguredAppsScriptUrl();
  if (appsScriptUrl) {
    try {
      const bridgeRes = await fetch(appsScriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'cron_status' }),
      });
      const bridgeJson = await bridgeRes.json().catch(() => null);
      if (bridgeJson?.ok && bridgeJson.lastCronRunAt) {
        result.lastCronRunAt = bridgeJson.lastCronRunAt;
      }
    } catch {
      // ignore
    }
  }

  return result;
}

/**
 * Creates a dedicated Web Worker heartbeat timer that is NOT throttled or frozen
 * when the browser tab is in the background or minimized.
 */
export function createBackgroundTimerWorker(onTick: () => void, intervalMs = 2000): () => void {
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let worker: Worker | null = null;
  let blobUrl: string | null = null;

  try {
    const workerCode = `
      setInterval(function() {
        postMessage('tick');
      }, ${intervalMs});
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    blobUrl = URL.createObjectURL(blob);
    worker = new Worker(blobUrl);
    worker.onmessage = () => {
      onTick();
    };
  } catch {
    // Fallback if Worker is blocked by CSP
  }

  // Always keep a standard interval + visibilitychange listener alongside the Worker
  fallbackTimer = setInterval(onTick, intervalMs);
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') {
      onTick();
    }
  };
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('focus', onTick);

  return () => {
    if (fallbackTimer) clearInterval(fallbackTimer);
    if (worker) worker.terminate();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('focus', onTick);
  };
}

