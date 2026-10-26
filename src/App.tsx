import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  PteroServer,
  PteroCredentials,
  PteroBackupFile,
  AutoBackupSchedule,
  ActivityLog,
  ThemeMode,
} from './types/pterodactyl';
import { INITIAL_SERVERS, INITIAL_SCHEDULE, INITIAL_LOGS } from './data/initialServers';
import {
  formatBytes,
  calculateNextScheduleRun,
  selectBackupsToAutoDelete,
  buildGoogleAppsScriptCode,
} from './utils/backupLogic';
import {
  initAuth,
  googleSignIn,
  getAccessToken,
  logoutGoogle,
  GoogleDriveUser,
  connectWithAppsScriptBridge,
} from './services/googleDriveAuth';
import { uploadBackupToGoogleDrive } from './services/googleDriveService';
import { callPteroApi } from './services/pterodactylClient';
import { ApiKeyConfigModal } from './components/ApiKeyConfigModal';
import { GoogleDriveConfigModal } from './components/GoogleDriveConfigModal';
import { ServerBackupCard } from './components/ServerBackupCard';
import { AutoBackupSchedulerPanel } from './components/AutoBackupSchedulerPanel';
import {
  Sun,
  Moon,
  KeyRound,
  Server,
  Clock,
  Search,
  Download,
  CheckCircle2,
  FolderSync,
  RefreshCw,
  AlertCircle,
  ShieldAlert,
  CloudUpload,
  ExternalLink,
  LogOut,
  Trash2,
  Settings,
} from 'lucide-react';

const STORAGE_KEYS = {
  THEME: 'pterovault_theme_v2',
  SERVERS: 'pterovault_real_servers_v2',
  CREDS: 'pterovault_real_credentials_v2',
  SCHEDULE: 'pterovault_real_schedule_v2',
  LOGS: 'pterovault_real_logs_v2',
  MANUAL_DRIVE_PREF: 'pterovault_manual_drive_pref_v2',
};

export function App() {
  // Theme state: 'dark' = Hitam & Merah (default), 'light' = Putih & Biru (White Mode)
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.THEME);
    return saved === 'light' || saved === 'dark' ? saved : 'dark';
  });

  // Real credentials state: starts empty until user inputs their real Domain, PLTA, and PLTS
  const [credentials, setCredentials] = useState<PteroCredentials>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.CREDS);
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return { domain: '', pltaKey: '', pltsKey: '' };
  });

  // Real servers state: only contains servers fetched from the user's real Pterodactyl Panel
  const [servers, setServers] = useState<PteroServer[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SERVERS);
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return INITIAL_SERVERS;
  });

  const [schedule, setSchedule] = useState<AutoBackupSchedule>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SCHEDULE);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          ...INITIAL_SCHEDULE,
          ...parsed,
          autoDeletePrevious: parsed.autoDeletePrevious ?? true,
          autoDeleteStrategy: parsed.autoDeleteStrategy || 'delete_all_previous',
        };
      }
    } catch {
      // ignore
    }
    return INITIAL_SCHEDULE;
  });

  const [logs, setLogs] = useState<ActivityLog[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.LOGS);
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return INITIAL_LOGS;
  });

  // Whether manual backups (single / batch) should also be saved to Google Drive automatically
  const [saveManualToDrive, setSaveManualToDrive] = useState<boolean>(() => {
    return localStorage.getItem(STORAGE_KEYS.MANUAL_DRIVE_PREF) === 'true';
  });

  // Google Drive OAuth state (supports Firebase Popup, GIS Client ID, and Direct Token / Refresh Token for Vercel)
  const [googleUser, setGoogleUser] = useState<GoogleDriveUser | null>(null);
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [isSigningInGoogle, setIsSigningInGoogle] = useState<boolean>(false);
  const [uploadingDriveIds, setUploadingDriveIds] = useState<string[]>([]);
  const [isDriveConfigModalOpen, setIsDriveConfigModalOpen] = useState<boolean>(false);
  const [driveModalAutoReason, setDriveModalAutoReason] = useState<string | null>(null);
  const [quickBridgeUrl, setQuickBridgeUrl] = useState<string>('');
  const [quickFolderUrl, setQuickFolderUrl] = useState<string>('');
  const [copiedQuickScript, setCopiedQuickScript] = useState<boolean>(false);

  // Explicit confirmation modal for destructive delete action
  const [pendingDelete, setPendingDelete] = useState<{
    serverId: string;
    serverName: string;
    backup: PteroBackupFile;
  } | null>(null);

  const [activeSection, setActiveSection] = useState<'servers' | 'vault' | 'scheduler' | 'logs'>('servers');
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([]);
  const [quickSingleServerId, setQuickSingleServerId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [vaultServerFilter, setVaultServerFilter] = useState<string>('all');
  const [isApiModalOpen, setIsApiModalOpen] = useState<boolean>(false);
  const [backingUpIds, setBackingUpIds] = useState<string[]>([]);
  const [isSyncingPanel, setIsSyncingPanel] = useState<boolean>(false);
  const [bannerNotice, setBannerNotice] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        setGoogleUser(user);
        setGoogleToken(token);
      },
      () => {
        setGoogleUser(null);
        setGoogleToken(null);
      }
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.MANUAL_DRIVE_PREF, String(saveManualToDrive));
  }, [saveManualToDrive]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.SERVERS, JSON.stringify(servers));
    if (servers.length > 0 && !quickSingleServerId) {
      setQuickSingleServerId(servers[1]?.id || servers[0].id);
    }
  }, [servers, quickSingleServerId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.CREDS, JSON.stringify(credentials));
  }, [credentials]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.SCHEDULE, JSON.stringify(schedule));
  }, [schedule]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(logs));
  }, [logs]);

  const isDark = theme === 'dark';
  const isConnected = Boolean(credentials.domain && (credentials.pltaKey || credentials.pltsKey));
  const isDriveConnected = Boolean(googleUser && googleToken);

  const appendLog = useCallback(
    (action: string, targetServer: string, details: string, status: ActivityLog['status'] = 'success') => {
      const entry: ActivityLog = {
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        action,
        targetServer,
        details,
        status,
      };
      setLogs((prev) => [entry, ...prev.slice(0, 99)]);
    },
    []
  );

  const showNotice = useCallback((text: string, type: 'success' | 'error' | 'info' = 'info') => {
    setBannerNotice({ type, text });
  }, []);

  /**
   * Initiates Google Sign-In popup for Google Drive storage permission,
   * automatically opening the Vercel Google Drive Configuration modal if unauthorized-domain occurs on Vercel.
   */
  const handleGoogleLogin = useCallback(async () => {
    setIsSigningInGoogle(true);
    try {
      const result = await googleSignIn();
      if (result) {
        setGoogleUser(result.user);
        setGoogleToken(result.accessToken);
        appendLog(
          'Google Drive Terhubung',
          result.user.email || 'Akun Google',
          'Izin penyimpanan file backup ke Google Drive aktif.',
          'success'
        );
        showNotice(`Terhubung ke Google Drive sebagai ${result.user.email || result.user.displayName}.`, 'success');
      }
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (err?.code === 'VERCEL_DOMAIN_SETUP_REQUIRED' || msg.includes('unauthorized-domain') || msg.includes('OAuth')) {
        setDriveModalAutoReason(
          `Domain "${window.location.hostname}" belum terdaftar di Firebase Authorized Domains. Gunakan Tab 1 (Token Langsung) untuk langsung terhubung di Vercel tanpa whitelist domain, atau tambahkan domain "${window.location.hostname}" di Tab 3.`
        );
        setIsDriveConfigModalOpen(true);
      } else {
        showNotice(
          `Gagal masuk dengan popup Google (${msg || 'Popup ditutup'}). Membuka opsi koneksi Google Drive untuk Vercel...`,
          'info'
        );
        setDriveModalAutoReason(null);
        setIsDriveConfigModalOpen(true);
      }
    } finally {
      setIsSigningInGoogle(false);
    }
  }, [appendLog, showNotice]);

  const handleGoogleLogout = useCallback(async () => {
    await logoutGoogle();
    setGoogleUser(null);
    setGoogleToken(null);
    setSaveManualToDrive(false);
    appendLog('Putuskan Google Drive', 'Akun Google', 'Sesi akses Google Drive dihentikan.', 'info');
    showNotice('Koneksi Google Drive telah diputuskan.', 'info');
  }, [appendLog, showNotice]);

  /**
   * Uploads a specific backup file to an isolated per-server folder in Google Drive,
   * automatically re-authenticating if the token expired.
   */
  const handleUploadBackupToDrive = useCallback(
    async (backup: PteroBackupFile, serverOrdinal: number) => {
      let activeToken = await getAccessToken();
      if (!activeToken) {
        showNotice('Membuka login Google untuk mengizinkan penyimpanan ke Google Drive...', 'info');
        try {
          const signInRes = await googleSignIn();
          if (!signInRes?.accessToken) return;
          activeToken = signInRes.accessToken;
          setGoogleUser(signInRes.user);
          setGoogleToken(signInRes.accessToken);
        } catch (err: any) {
          setDriveModalAutoReason(
            'Silakan hubungkan Google Drive Anda terlebih dahulu (mendukung Token Langsung & OAuth Client ID untuk Vercel).'
          );
          setIsDriveConfigModalOpen(true);
          return;
        }
      }

      setUploadingDriveIds((prev) => [...prev, backup.id]);
      try {
        let result;
        try {
          result = await uploadBackupToGoogleDrive({
            accessToken: activeToken,
            backup,
            serverOrdinal,
            domain: credentials.domain,
            pltsKey: credentials.pltsKey,
          });
        } catch (firstErr: any) {
          if (String(firstErr?.message || '').startsWith('TOKEN_EXPIRED')) {
            const refreshed = await googleSignIn();
            if (!refreshed?.accessToken) {
              throw new Error('Sesi Google Drive habis. Silakan klik Sign in with Google kembali.');
            }
            activeToken = refreshed.accessToken;
            setGoogleUser(refreshed.user);
            setGoogleToken(refreshed.accessToken);
            result = await uploadBackupToGoogleDrive({
              accessToken: activeToken,
              backup,
              serverOrdinal,
              domain: credentials.domain,
              pltsKey: credentials.pltsKey,
            });
          } else {
            throw firstErr;
          }
        }

        setServers((prev) =>
          prev.map((srv) => {
            if (srv.id !== backup.serverId && srv.identifier !== backup.serverIdentifier) return srv;
            return {
              ...srv,
              backups: srv.backups.map((b) =>
                b.id === backup.id
                  ? {
                      ...b,
                      sizeBytes: result.updatedSizeBytes || b.sizeBytes,
                      status: result.updatedStatus || b.status,
                      driveFileId: result.driveFileId,
                      driveWebViewLink: result.driveWebViewLink,
                      driveFolderName: result.driveFolderName,
                      savedToDriveAt: new Date().toISOString(),
                    }
                  : b
              ),
            };
          })
        );

        appendLog(
          'Simpan Backup ke Google Drive',
          backup.serverName,
          `Arsip ${backup.fileName} berhasil disimpan di Google Drive (${result.driveFolderName}).`,
          'success'
        );
        showNotice(
          `File ${backup.fileName} berhasil disimpan ke Google Drive pada folder ${result.driveFolderName}!`,
          'success'
        );
      } catch (err: any) {
        const errMsg = err?.message || 'Gagal mengunggah file ke Google Drive.';
        appendLog('Gagal Upload Google Drive', backup.serverName, errMsg, 'error');
        showNotice(errMsg, 'error');
      } finally {
        setUploadingDriveIds((prev) => prev.filter((id) => id !== backup.id));
      }
    },
    [credentials.domain, credentials.pltsKey, appendLog, showNotice]
  );

  const [isTestingDrive, setIsTestingDrive] = useState<boolean>(false);
  const [lastDriveTestLink, setLastDriveTestLink] = useState<string | null>(null);

  const handleVerifyDriveBackupNow = useCallback(async () => {
    let activeToken = await getAccessToken();
    if (!activeToken) {
      try {
        const signInRes = await googleSignIn();
        if (!signInRes?.accessToken) return;
        activeToken = signInRes.accessToken;
        setGoogleUser(signInRes.user);
        setGoogleToken(signInRes.accessToken);
      } catch (err: any) {
        showNotice(`Gagal masuk ke Google Drive: ${err?.message || 'Popup ditutup'}`, 'error');
        return;
      }
    }

    setIsTestingDrive(true);
    try {
      const firstSrv = servers[0];
      const existingBkp = firstSrv?.backups?.[0];

      if (firstSrv && existingBkp) {
        await handleUploadBackupToDrive(existingBkp, 1);
        return;
      }

      const nowIso = new Date().toISOString();
      const testBackup: PteroBackupFile = {
        id: `drive-test-${Date.now()}`,
        uuid: `drive-test-${Date.now()}`,
        serverId: firstSrv?.id || 'srv-drive-verify',
        serverName: firstSrv?.name || 'PteroVault Drive Verification',
        serverIdentifier: firstSrv?.identifier || 'verify01',
        fileName: `backup_srv01_${firstSrv?.identifier || 'verify01'}_test_drive_${nowIso.slice(0, 19).replace(/[:T]/g, '-')}.tar.gz`,
        sizeBytes: 1024,
        checksum: 'sha256:drive-verified',
        createdAt: nowIso,
        completedAt: nowIso,
        status: 'completed',
        isLocked: false,
        triggerType: 'manual_single',
        ignoredFiles: '',
      };

      const result = await uploadBackupToGoogleDrive({
        accessToken: activeToken,
        backup: testBackup,
        serverOrdinal: 1,
        domain: credentials.domain,
        pltsKey: credentials.pltsKey,
      });

      setLastDriveTestLink(result.driveWebViewLink);
      appendLog(
        'Tes Simpan ke Google Drive Berhasil',
        result.driveFolderName,
        `File ${testBackup.fileName} berhasil dibuat di Google Drive.`,
        'success'
      );
      showNotice(
        `Berhasil membuat folder "${result.driveFolderName}" dan menyimpan file backup "${testBackup.fileName}" di Google Drive Anda!`,
        'success'
      );
    } catch (err: any) {
      showNotice(`Gagal menyimpan ke Google Drive: ${err?.message || 'Unknown error'}`, 'error');
    } finally {
      setIsTestingDrive(false);
    }
  }, [servers, credentials.domain, credentials.pltsKey, handleUploadBackupToDrive, appendLog, showNotice]);

  /**
   * Syncs real server list & isolated backups from the user's Pterodactyl Panel
   */
  const handleSyncFromRealPanel = useCallback(
    async (credsToUse: PteroCredentials = credentials): Promise<{ ok: boolean; message: string }> => {
      if (!credsToUse.domain || (!credsToUse.pltaKey && !credsToUse.pltsKey)) {
        return {
          ok: false,
          message: 'Masukkan Domain dan API Key (PLTA / PLTS) terlebih dahulu.',
        };
      }

      setIsSyncingPanel(true);
      try {
        const { ok, status, data } = await callPteroApi('sync', credsToUse as any);

        if (!ok || !data?.ok) {
          const errMsg =
            data?.error || `Gagal terhubung ke panel ${credsToUse.domain} (HTTP ${status}).`;
          appendLog('Gagal Sinkronisasi Panel', credsToUse.domain, errMsg, 'error');
          showNotice(errMsg, 'error');
          return { ok: false, message: errMsg };
        }

        const realServers: PteroServer[] = Array.isArray(data.servers) ? data.servers : [];
        setServers(realServers);

        if (realServers.length > 0) {
          setQuickSingleServerId(realServers[1]?.id || realServers[0].id);
          setSelectedServerIds([realServers[1]?.id || realServers[0].id]);
        } else {
          setQuickSingleServerId('');
          setSelectedServerIds([]);
        }

        const msg = `Berhasil terhubung ke ${credsToUse.domain}! Memuat ${realServers.length} server real beserta daftar backup masing-masing.`;
        appendLog('Sinkronisasi Panel Real Berhasil', credsToUse.domain, msg, 'success');
        showNotice(msg, 'success');
        return { ok: true, message: msg };
      } catch (err: any) {
        const errMsg = `Gagal menghubungkan ke panel ${credsToUse.domain}: ${err?.message || 'Periksa koneksi internet dan domain panel Anda.'}`;
        appendLog('Error Jaringan API', credsToUse.domain, errMsg, 'error');
        showNotice(errMsg, 'error');
        return { ok: false, message: errMsg };
      } finally {
        setIsSyncingPanel(false);
      }
    },
    [credentials, appendLog, showNotice]
  );

  /**
   * Executes a real backup on a single Pterodactyl server via Client API (PLTS/PLTC),
   * and optionally uploads it to Google Drive if requested by manual preference or Auto-Update schedule.
   */
  const handleBackupSingleServer = useCallback(
    async (
      serverId: string,
      triggerMode: 'manual_single' | 'manual_batch' | 'auto_schedule' = 'manual_single',
      forceDriveUpload?: boolean
    ) => {
      const srvIdx = servers.findIndex((s) => s.id === serverId);
      const targetSrv = servers[srvIdx];
      if (!targetSrv) return false;

      if (!credentials.domain || !credentials.pltsKey) {
        showNotice(
          'Client API Key (PLTS/PLTC) wajib dipasang di pengaturan API untuk mengeksekusi pembuatan backup real pada server Pterodactyl.',
          'error'
        );
        setIsApiModalOpen(true);
        return false;
      }

      const shouldUploadToDrive =
        forceDriveUpload !== undefined
          ? forceDriveUpload
          : triggerMode === 'auto_schedule'
          ? Boolean(schedule.saveToGoogleDrive)
          : saveManualToDrive;

      // Automatically delete previous backups during Auto-Backup (or when server slot is full)
      const isServerSlotFull =
        targetSrv.limits.backupLimit > 0 &&
        targetSrv.backups.length >= targetSrv.limits.backupLimit;

      const shouldAutoDeletePrevious =
        triggerMode === 'auto_schedule'
          ? Boolean(schedule.autoDeletePrevious ?? true)
          : isServerSlotFull;

      const effectiveDeleteStrategy =
        triggerMode === 'auto_schedule'
          ? schedule.autoDeleteStrategy || 'delete_all_previous'
          : 'keep_retention_count';

      const effectiveRetentionCount =
        triggerMode === 'auto_schedule'
          ? schedule.retentionCount || 1
          : targetSrv.limits.backupLimit || 5;

      setBackingUpIds((prev) => [...prev, serverId]);
      try {
        const { ok, data } = await callPteroApi('backup/create', {
          domain: credentials.domain,
          pltsKey: credentials.pltsKey,
          serverIdentifier: targetSrv.identifier,
          serverOrdinal: srvIdx + 1,
          serverName: targetSrv.name,
          isLocked: schedule.lockNewBackups,
          autoDeletePrevious: shouldAutoDeletePrevious,
          autoDeleteStrategy: effectiveDeleteStrategy,
          retentionCount: effectiveRetentionCount,
          serverBackupLimit: targetSrv.limits.backupLimit,
        });

        if (!ok || !data?.ok) {
          const errMsg = data?.error || `Gagal membuat backup pada ${targetSrv.name}`;
          appendLog('Gagal Backup Server', targetSrv.name, errMsg, 'error');
          showNotice(errMsg, 'error');
          return false;
        }

        const newBackup: PteroBackupFile = {
          ...data.backup,
          serverId: targetSrv.id,
          serverName: targetSrv.name,
          serverIdentifier: targetSrv.identifier,
          triggerType: triggerMode,
        };

        const deletedUuidsFromServer: string[] = Array.isArray(data.deletedBackupUuids)
          ? data.deletedBackupUuids
          : [];
        const deletedNamesFromServer: string[] = Array.isArray(data.deletedBackupNames)
          ? data.deletedBackupNames
          : [];

        setServers((prev) =>
          prev.map((s) => {
            if (s.id !== serverId) return s;

            const deletedSet = new Set(deletedUuidsFromServer);
            const afterServerDeletes = s.backups.filter(
              (b) => !deletedSet.has(b.uuid) && !deletedSet.has(b.id)
            );

            // Also apply local retention pruning calculation to keep UI state in sync
            const { backupsToKeep } = selectBackupsToAutoDelete(afterServerDeletes, {
              autoDeletePrevious: shouldAutoDeletePrevious,
              strategy: effectiveDeleteStrategy,
              retentionCount: effectiveRetentionCount,
              serverBackupLimit: s.limits.backupLimit,
            });

            return {
              ...s,
              backups: [newBackup, ...backupsToKeep],
            };
          })
        );

        if (deletedUuidsFromServer.length > 0) {
          appendLog(
            'Hapus Otomatis Backup Sebelumnya',
            targetSrv.name,
            `Menghapus otomatis ${deletedUuidsFromServer.length} file backup lama (${deletedNamesFromServer.join(', ')}) untuk mengantisipasi kepenuhan kuota Pterodactyl.`,
            'info'
          );
        }

        appendLog(
          triggerMode === 'auto_schedule' ? 'Auto-Update Backup Real' : 'Backup Server Real Berhasil',
          targetSrv.name,
          `File terpisah ${newBackup.fileName} dibuat di panel Pterodactyl${
            deletedUuidsFromServer.length > 0
              ? ` (menggantikan ${deletedUuidsFromServer.length} backup sebelumnya)`
              : ''
          }.`,
          'success'
        );

        // If Google Drive storage is selected, also save to Google Drive
        if (shouldUploadToDrive) {
          await handleUploadBackupToDrive(newBackup, srvIdx + 1);
        } else if (triggerMode === 'manual_single') {
          showNotice(
            `Backup real untuk "${targetSrv.name}" berhasil dijalankan: ${newBackup.fileName}${
              deletedUuidsFromServer.length > 0
                ? ` (${deletedUuidsFromServer.length} backup lama dihapus otomatis)`
                : ''
            }`,
            'success'
          );
        }
        return true;
      } catch (err: any) {
        const errMsg = `Gagal menghubungi endpoint backup untuk ${targetSrv.name}: ${err?.message || 'Unknown error'}`;
        appendLog('Error Eksekusi Backup', targetSrv.name, errMsg, 'error');
        showNotice(errMsg, 'error');
        return false;
      } finally {
        setBackingUpIds((prev) => prev.filter((id) => id !== serverId));
      }
    },
    [
      servers,
      credentials,
      schedule.lockNewBackups,
      schedule.saveToGoogleDrive,
      schedule.autoDeletePrevious,
      schedule.autoDeleteStrategy,
      schedule.retentionCount,
      saveManualToDrive,
      handleUploadBackupToDrive,
      appendLog,
      showNotice,
    ]
  );

  /**
   * Executes real separated backups across ALL servers in the panel
   */
  const handleBackupAllServers = useCallback(async () => {
    if (servers.length === 0) {
      showNotice('Belum ada server yang dimuat. Silakan hubungkan Domain, PLTA, dan PLTS panel Anda terlebih dahulu.', 'error');
      setIsApiModalOpen(true);
      return;
    }

    let successCount = 0;
    for (const srv of servers) {
      const ok = await handleBackupSingleServer(srv.id, 'manual_batch', saveManualToDrive);
      if (ok) successCount++;
    }

    if (successCount > 0) {
      showNotice(
        `Berhasil mengeksekusi backup real terpisah untuk ${successCount} dari ${servers.length} server${
          saveManualToDrive ? ' dan menyimpannya ke Google Drive' : ''
        }.`,
        'success'
      );
    }
  }, [servers, handleBackupSingleServer, saveManualToDrive, showNotice]);

  /**
   * Executes real separated backups for user-selected servers
   */
  const handleBackupSelectedServers = useCallback(async () => {
    if (selectedServerIds.length === 0) {
      showNotice('Pilih minimal 1 server terlebih dahulu dengan mencentang kotak di samping nama server.', 'info');
      return;
    }
    let successCount = 0;
    for (const id of selectedServerIds) {
      const ok = await handleBackupSingleServer(
        id,
        selectedServerIds.length === 1 ? 'manual_single' : 'manual_batch',
        saveManualToDrive
      );
      if (ok) successCount++;
    }
    if (successCount > 0) {
      showNotice(
        `Berhasil menjalankan backup real untuk ${successCount} server terpilih${
          saveManualToDrive ? ' beserta upload ke Google Drive' : ''
        }.`,
        'success'
      );
    }
  }, [selectedServerIds, handleBackupSingleServer, saveManualToDrive, showNotice]);

  /**
   * Executes scheduled Auto-Update backup cycle across target servers (including optional Google Drive save)
   */
  const handleTriggerScheduledRunNow = useCallback(async () => {
    if (servers.length === 0) {
      showNotice('Tidak ada server untuk dijadwalkan. Hubungkan panel Pterodactyl Anda terlebih dahulu.', 'error');
      return;
    }

    const targetIds =
      schedule.targetScope === 'all'
        ? servers.map((s) => s.id)
        : schedule.selectedServerIds.length > 0
        ? schedule.selectedServerIds
        : servers.map((s) => s.id);

    let successCount = 0;
    for (const id of targetIds) {
      const ok = await handleBackupSingleServer(id, 'auto_schedule', Boolean(schedule.saveToGoogleDrive));
      if (ok) successCount++;
    }

    const nowIso = new Date().toISOString();
    const nextRunAt = calculateNextScheduleRun(schedule, new Date());
    setSchedule((prev) => ({
      ...prev,
      lastRunAt: nowIso,
      nextRunAt,
    }));

    if (successCount > 0) {
      showNotice(
        `Siklus Auto-Update selesai: ${successCount} server berhasil di-backup${
          schedule.saveToGoogleDrive ? ' dan diunggah ke Google Drive' : ' ke panel'
        }.`,
        'success'
      );
    }
  }, [servers, schedule, handleBackupSingleServer, showNotice]);

  // Real background timer that checks every 15 seconds if Auto-Update schedule is due
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;
  const triggerScheduleRef = useRef(handleTriggerScheduledRunNow);
  triggerScheduleRef.current = handleTriggerScheduledRunNow;

  useEffect(() => {
    const timer = setInterval(() => {
      const cur = scheduleRef.current;
      if (!cur.enabled) return;
      const nowMs = Date.now();
      const nextMs = new Date(cur.nextRunAt).getTime();
      if (nowMs >= nextMs) {
        triggerScheduleRef.current();
      }
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  /**
   * Downloads a real backup archive (.tar.gz) from Pterodactyl Wings signed URL
   */
  const handleDownloadBackup = async (backup: PteroBackupFile) => {
    if (!credentials.domain || !credentials.pltsKey) {
      showNotice('Client API Key (PLTS/PLTC) diperlukan untuk mengunduh file arsip dari Wings.', 'error');
      return;
    }

    try {
      showNotice(`Meminta signed link unduhan untuk ${backup.fileName} dari panel...`, 'info');
      const { ok, data } = await callPteroApi('backup/download', {
        domain: credentials.domain,
        pltsKey: credentials.pltsKey,
        serverIdentifier: backup.serverIdentifier,
        backupUuid: backup.uuid,
      });
      if (!ok || !data?.ok || !data?.downloadUrl) {
        showNotice(data?.error || 'Gagal mendapatkan URL download dari Pterodactyl.', 'error');
        return;
      }

      const a = document.createElement('a');
      a.href = data.downloadUrl;
      a.download = backup.fileName;
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      appendLog('Unduh File Backup Real', backup.serverName, `Mengunduh arsip ${backup.fileName} dari Wings.`, 'info');
      showNotice(`Unduhan dimulai untuk ${backup.fileName}`, 'success');
    } catch (err: any) {
      showNotice(`Gagal mengunduh backup: ${err?.message || 'Network error'}`, 'error');
    }
  };

  /**
   * Toggles lock on a real backup in Pterodactyl Panel
   */
  const handleToggleLockBackup = async (serverId: string, backupId: string) => {
    const targetSrv = servers.find((s) => s.id === serverId);
    const targetBkp = targetSrv?.backups.find((b) => b.id === backupId);
    if (!targetSrv || !targetBkp) return;

    try {
      const { ok, data } = await callPteroApi('backup/lock', {
        domain: credentials.domain,
        pltsKey: credentials.pltsKey,
        serverIdentifier: targetSrv.identifier,
        backupUuid: targetBkp.uuid,
      });
      if (!ok || !data?.ok) {
        showNotice(data?.error || 'Gagal mengubah status kunci backup di panel.', 'error');
        return;
      }

      setServers((prev) =>
        prev.map((srv) => {
          if (srv.id !== serverId) return srv;
          return {
            ...srv,
            backups: srv.backups.map((b) => (b.id === backupId ? { ...b, isLocked: data.isLocked } : b)),
          };
        })
      );
      showNotice(
        `Status kunci untuk ${targetBkp.fileName} berhasil diubah menjadi ${data.isLocked ? 'Terkunci' : 'Tidak Terkunci'}.`,
        'success'
      );
    } catch (err: any) {
      showNotice(`Gagal menghubungi endpoint lock: ${err?.message || 'Network error'}`, 'error');
    }
  };

  /**
   * Opens explicit confirmation dialog before deleting a backup archive
   */
  const handleRequestDeleteBackup = (serverId: string, backupId: string) => {
    const targetSrv = servers.find((s) => s.id === serverId);
    const targetBkp = targetSrv?.backups.find((b) => b.id === backupId);
    if (!targetSrv || !targetBkp || targetBkp.isLocked) return;
    setPendingDelete({
      serverId,
      serverName: targetSrv.name,
      backup: targetBkp,
    });
  };

  /**
   * Executes confirmed deletion of a backup from Pterodactyl Panel (and optionally Google Drive if saved)
   */
  const handleConfirmDeleteBackup = async (alsoDeleteFromDrive: boolean) => {
    if (!pendingDelete) return;
    const { serverId, serverName, backup } = pendingDelete;
    setPendingDelete(null);

    try {
      const { ok, data } = await callPteroApi('backup/delete', {
        domain: credentials.domain,
        pltsKey: credentials.pltsKey,
        serverIdentifier: backup.serverIdentifier,
        backupUuid: backup.uuid,
      });
      if (!ok || !data?.ok) {
        showNotice(data?.error || 'Gagal menghapus backup dari panel Pterodactyl.', 'error');
        return;
      }

      if (alsoDeleteFromDrive && backup.driveFileId) {
        const token = await getAccessToken();
        if (token) {
          await fetch(`https://www.googleapis.com/drive/v3/files/${backup.driveFileId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {});
        }
      }

      setServers((prev) =>
        prev.map((srv) => {
          if (srv.id !== serverId) return srv;
          return {
            ...srv,
            backups: srv.backups.filter((b) => b.id !== backup.id),
          };
        })
      );

      appendLog(
        'Hapus Backup Real',
        serverName,
        `Menghapus file ${backup.fileName}${alsoDeleteFromDrive ? ' dari Panel & Google Drive' : ' dari Panel'}.`,
        'warning'
      );
      showNotice(`File backup ${backup.fileName} berhasil dihapus.`, 'info');
    } catch (err: any) {
      showNotice(`Gagal menghapus backup: ${err?.message || 'Network error'}`, 'error');
    }
  };

  const handleSaveCredentials = async (
    newCreds: PteroCredentials,
    syncLive: boolean
  ): Promise<{ ok: boolean; message: string }> => {
    setCredentials(newCreds);
    if (!syncLive) {
      return { ok: true, message: 'Kredensial disimpan.' };
    }
    return await handleSyncFromRealPanel(newCreds);
  };

  // Filtered servers
  const filteredServers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.identifier.toLowerCase().includes(q) ||
        s.node.toLowerCase().includes(q)
    );
  }, [servers, searchQuery]);

  // All isolated backups flattened for the Separated File Explorer tab
  const allSeparatedBackups = useMemo(() => {
    const list: Array<{ serverOrdinal: number; server: PteroServer; backup: PteroBackupFile }> = [];
    servers.forEach((srv, idx) => {
      if (vaultServerFilter !== 'all' && srv.id !== vaultServerFilter) return;
      srv.backups.forEach((bkp) => {
        list.push({ serverOrdinal: idx + 1, server: srv, backup: bkp });
      });
    });
    return list;
  }, [servers, vaultServerFilter]);

  const totalBackupFiles = useMemo(
    () => servers.reduce((acc, s) => acc + s.backups.length, 0),
    [servers]
  );

  const totalDriveSavedFiles = useMemo(
    () =>
      servers.reduce(
        (acc, s) => acc + s.backups.filter((b) => Boolean(b.driveFileId)).length,
        0
      ),
    [servers]
  );

  const totalBackupBytes = useMemo(
    () =>
      servers.reduce(
        (acc, s) => acc + s.backups.reduce((bAcc, b) => bAcc + b.sizeBytes, 0),
        0
      ),
    [servers]
  );

  return (
    <div
      className={`min-h-screen w-full max-w-full overflow-x-hidden flex flex-col transition-colors ${
        isDark ? 'bg-[#09090B] text-[#FAFAFA]' : 'bg-[#F8FAFC] text-[#0F172A]'
      }`}
    >
      {/* Top Bar Contract: Zone 1 (Brand), Zone 2 (4 Nav Links), Zone 3 (1 Primary Action) */}
      <header
        className={`w-full flex items-center justify-between gap-4 sm:gap-8 px-4 sm:px-6 py-4 border-b transition-colors ${
          isDark ? 'bg-[#09090B] border-[#1F1F23]' : 'bg-white border-slate-200'
        }`}
      >
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('servers');
          }}
          className="text-base sm:text-lg font-bold tracking-tight font-display whitespace-nowrap shrink-0"
        >
          PteroVault Backup
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          <button
            type="button"
            onClick={() => setActiveSection('servers')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 border-b-2 ${
              activeSection === 'servers'
                ? isDark
                  ? 'border-red-500 text-white'
                  : 'border-blue-600 text-slate-900'
                : isDark
                ? 'border-transparent text-zinc-400 hover:text-white'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            Daftar Server ({servers.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('vault')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 border-b-2 ${
              activeSection === 'vault'
                ? isDark
                  ? 'border-red-500 text-white'
                  : 'border-blue-600 text-slate-900'
                : isDark
                ? 'border-transparent text-zinc-400 hover:text-white'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            Arsip Terpisah ({totalBackupFiles})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('scheduler')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 border-b-2 ${
              activeSection === 'scheduler'
                ? isDark
                  ? 'border-red-500 text-white'
                  : 'border-blue-600 text-slate-900'
                : isDark
                ? 'border-transparent text-zinc-400 hover:text-white'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            Auto-Update
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('logs')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 border-b-2 ${
              activeSection === 'logs'
                ? isDark
                  ? 'border-red-500 text-white'
                  : 'border-blue-600 text-slate-900'
                : isDark
                ? 'border-transparent text-zinc-400 hover:text-white'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            Riwayat Log
          </button>
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={handleBackupAllServers}
            className={`px-3.5 sm:px-4 py-2 text-xs font-semibold text-white rounded-lg transition-colors whitespace-nowrap shrink-0 ${
              isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            Backup Semua Server
          </button>
        </div>
      </header>

      {/* Main Content Container with strict overflow protection */}
      <main className="flex-1 w-full max-w-[1360px] mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 sm:space-y-8 overflow-x-hidden">
        {/* Workspace Control Bar: Theme Switcher (Hitam-Merah <-> Putih-Biru) + Real API Key Setup */}
        <section
          aria-label="Kontrol Tema, Google Drive, dan Kredensial API"
          className={`w-full rounded-xl border p-4 sm:p-6 transition-colors ${
            isDark ? 'bg-[#121215] border-[#242429]' : 'bg-white border-slate-200'
          }`}
        >
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
            <div className="space-y-1.5 min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono">
                <span className={isDark ? 'text-red-400 font-semibold' : 'text-blue-600 font-semibold'}>
                  {isConnected ? `PANEL REAL TERHUBUNG: ${credentials.domain}` : 'BELUM TERHUBUNG KE PANEL (MENUNGGU API KEY)'}
                </span>
                <span aria-hidden="true" className="opacity-40">
                  ·
                </span>
                <span className={isDark ? 'text-zinc-400' : 'text-slate-500'}>
                  Google Drive: {isDriveConnected ? googleUser?.email || 'Terhubung' : 'Belum Masuk'}
                </span>
              </div>

              <h1 className="text-xl sm:text-3xl font-bold tracking-tight text-balance">
                Manajemen Backup Terpisah, Auto-Update &amp; Google Drive
              </h1>
              <p className={`text-xs sm:text-sm ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                Terhubung langsung ke API Pterodactyl asli Anda. Pisahkan file backup per server (<code className="font-mono">srv01_</code>, <code className="font-mono">srv02_</code>) dan pilih apakah file disimpan di Panel saja atau diunggah otomatis ke folder terpisah di <strong>Google Drive</strong> (termasuk saat Auto-Update).
              </p>
            </div>

            {/* Theme Mode Switcher & API Key Input Trigger */}
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <div
                className={`inline-flex p-1 rounded-lg border ${
                  isDark ? 'bg-[#09090B] border-[#27272A]' : 'bg-slate-100 border-slate-200'
                }`}
                role="group"
                aria-label="Pemilih Tema Warna"
              >
                <button
                  type="button"
                  onClick={() => setTheme('dark')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                    isDark
                      ? 'bg-red-600 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Moon className="w-3.5 h-3.5" />
                  Hitam &amp; Merah
                </button>
                <button
                  type="button"
                  onClick={() => setTheme('light')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                    !isDark
                      ? 'bg-blue-600 text-white'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5" />
                  White &amp; Biru
                </button>
              </div>

              {isConnected && (
                <button
                  type="button"
                  disabled={isSyncingPanel}
                  onClick={() => handleSyncFromRealPanel()}
                  className={`px-3 py-2 text-xs font-semibold rounded-lg border flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                    isDark
                      ? 'border-[#27272A] bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
                      : 'border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100'
                  }`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSyncingPanel ? 'animate-spin' : ''}`} />
                  Refresh Server Real
                </button>
              )}

              <button
                type="button"
                onClick={() => setIsApiModalOpen(true)}
                className={`px-3.5 py-2 text-xs font-semibold rounded-lg border flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                  isDark
                    ? 'border-red-500/50 bg-red-950/30 text-red-300 hover:bg-red-950/50'
                    : 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" />
                {isConnected ? 'Pengaturan API Key & Domain' : 'Pasang API Key (PLTA / PLTS & Domain)'}
              </button>
            </div>
          </div>

          {/* Google Drive Storage Mode & Super Simple Quick-Connect Bar */}
          <div
            className={`mt-5 p-4 rounded-xl border space-y-4 transition-colors ${
              isDark ? 'bg-[#09090B] border-[#242429]' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <CloudUpload className={`w-5 h-5 mt-0.5 shrink-0 ${isDark ? 'text-red-400' : 'text-blue-600'}`} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold">
                    Pilihan Tujuan Penyimpanan File Backup (Panel Pterodactyl vs Google Drive)
                  </div>
                  <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                    Pilih apakah backup disimpan di Panel saja atau ikut diunggah ke folder terpisah (<code className="font-mono">PteroVault_Backups/Server_01_...</code>) di Google Drive Anda.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 shrink-0">
                {/* Storage Destination Toggle for Manual Backups */}
                <div
                  className={`inline-flex p-1 rounded-lg border ${
                    isDark ? 'bg-[#121215] border-[#27272A]' : 'bg-white border-slate-200'
                  }`}
                  role="group"
                  aria-label="Pilihan Simpan ke Google Drive"
                >
                  <button
                    type="button"
                    onClick={() => setSaveManualToDrive(false)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      !saveManualToDrive
                        ? isDark
                          ? 'bg-red-600 text-white'
                          : 'bg-blue-600 text-white'
                        : isDark
                        ? 'text-zinc-400 hover:text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Simpan di Panel Saja
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSaveManualToDrive(true);
                      if (!isDriveConnected) {
                        setIsDriveConfigModalOpen(true);
                      }
                    }}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      saveManualToDrive
                        ? isDark
                          ? 'bg-red-600 text-white'
                          : 'bg-blue-600 text-white'
                        : isDark
                        ? 'text-zinc-400 hover:text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Simpan ke Panel + Google Drive
                  </button>
                </div>

                {/* Connected Account Actions */}
                {isDriveConnected && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-xs font-mono truncate max-w-[200px] ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                      {googleUser?.email}
                    </span>
                    <button
                      type="button"
                      disabled={isTestingDrive}
                      onClick={handleVerifyDriveBackupNow}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold text-white inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                        isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
                      }`}
                    >
                      <CloudUpload className="w-3.5 h-3.5" />
                      {isTestingDrive ? 'Mengunggah ke Drive...' : 'Simpan Backup ke Drive Sekarang'}
                    </button>
                    {lastDriveTestLink && (
                      <a
                        href={lastDriveTestLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
                          isDark
                            ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300'
                            : 'border-emerald-300 bg-emerald-50 text-emerald-800'
                        }`}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Lihat di Drive
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setDriveModalAutoReason(null);
                        setIsDriveConfigModalOpen(true);
                      }}
                      aria-label="Pengaturan Google Drive Vercel"
                      className={`px-2.5 py-1.5 rounded-lg border text-xs inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
                        isDark
                          ? 'border-[#27272A] text-zinc-300 hover:bg-zinc-800'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Settings className="w-3.5 h-3.5" />
                      Ubah Tautan
                    </button>
                    <button
                      type="button"
                      onClick={handleGoogleLogout}
                      aria-label="Keluar dari Google Drive"
                      className={`px-2.5 py-1.5 rounded-lg border text-xs inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
                        isDark
                          ? 'border-[#27272A] text-zinc-300 hover:bg-zinc-800'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      Putuskan Drive
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Inline 1-Step Quick-Connect Box when Google Drive is not connected yet */}
            {!isDriveConnected && (
              <div
                className={`p-3.5 rounded-lg border flex flex-col xl:flex-row xl:items-center justify-between gap-3 ${
                  isDark ? 'bg-[#121215] border-[#27272A]' : 'bg-white border-slate-200'
                }`}
              >
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1 min-w-0">
                  <input
                    type="url"
                    value={quickBridgeUrl}
                    onChange={(e) => setQuickBridgeUrl(e.target.value)}
                    placeholder="Tempel URL Google Script (https://script.google.com/macros/s/.../exec) — Tanpa Login & Anti-Ribet"
                    aria-label="URL Google Script Bridge"
                    className={`flex-1 min-w-0 px-3 py-2 text-xs rounded-lg border font-mono ${
                      isDark
                        ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                        : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                    }`}
                  />
                  <input
                    type="text"
                    value={quickFolderUrl}
                    onChange={(e) => setQuickFolderUrl(e.target.value)}
                    placeholder="Opsional: Link Folder Google Drive tujuan"
                    aria-label="Link Folder Google Drive Tujuan"
                    className={`sm:w-64 min-w-0 px-3 py-2 text-xs rounded-lg border font-mono ${
                      isDark
                        ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                        : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                    }`}
                  />
                  <button
                    type="button"
                    disabled={isSigningInGoogle}
                    onClick={async () => {
                      if (!quickBridgeUrl.trim()) {
                        setDriveModalAutoReason(null);
                        setIsDriveConfigModalOpen(true);
                        return;
                      }
                      setIsSigningInGoogle(true);
                      try {
                        const res = await connectWithAppsScriptBridge(quickBridgeUrl, quickFolderUrl);
                        setGoogleUser(res.user);
                        setGoogleToken(res.accessToken);
                        setSaveManualToDrive(true);
                        appendLog(
                          'Google Drive Terhubung (Tautan Permanen)',
                          res.user.email || 'Google Drive',
                          'Berhasil menautkan Google Drive tanpa OAuth.',
                          'success'
                        );
                        showNotice('Google Drive berhasil ditautkan secara permanen!', 'success');
                      } catch (err: any) {
                        showNotice(err?.message || 'URL Google Script tidak valid.', 'error');
                      } finally {
                        setIsSigningInGoogle(false);
                      }
                    }}
                    className={`px-4 py-2 rounded-lg text-xs font-semibold text-white whitespace-nowrap shrink-0 transition-colors ${
                      isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    Tautkan Drive Sekarang
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      const code = buildGoogleAppsScriptCode(quickFolderUrl);
                      navigator.clipboard?.writeText(code).catch(() => {});
                      setCopiedQuickScript(true);
                      setTimeout(() => setCopiedQuickScript(false), 3000);
                      setDriveModalAutoReason(null);
                      setIsDriveConfigModalOpen(true);
                    }}
                    className={`px-3 py-2 rounded-lg border text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                      isDark
                        ? 'border-red-500/40 bg-red-950/25 text-red-300 hover:bg-red-950/40'
                        : 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
                    }`}
                  >
                    <Settings className="w-3.5 h-3.5" />
                    {copiedQuickScript ? 'Kode Disalin! Lihat Cara Pasang' : 'Salin Kode Script & Cara Pasang (30 Detik)'}
                  </button>

                  <button
                    type="button"
                    disabled={isSigningInGoogle}
                    onClick={handleGoogleLogin}
                    className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                  >
                    <span>Popup Google</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Summary KPI Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6 pt-5 border-t border-current/10">
            <div className="min-w-0">
              <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                Total Server Real Terdeteksi
              </div>
              <div className="text-xl font-bold font-mono tabular-nums mt-0.5">
                {servers.length} Server
              </div>
              <div className={`text-xs mt-0.5 truncate ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
                {isConnected ? `Sumber: ${credentials.domain}` : 'Menunggu penautan API Key'}
              </div>
            </div>

            <div className="min-w-0">
              <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                Total File Backup Terpisah
              </div>
              <div className="text-xl font-bold font-mono tabular-nums mt-0.5">
                {totalBackupFiles} File (.tar.gz)
              </div>
              <div className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
                Ukuran: {formatBytes(totalBackupBytes)} · {totalDriveSavedFiles} di Google Drive
              </div>
            </div>

            <div className="min-w-0">
              <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                Jadwal Auto-Update Backup
              </div>
              <div className="text-xl font-bold font-mono tabular-nums mt-0.5">
                {schedule.enabled
                  ? schedule.frequency === 'interval_hours'
                    ? `Setiap ${schedule.intervalHours} Jam`
                    : `Pukul ${schedule.timeOfDay}`
                  : 'Nonaktif'}
              </div>
              <div className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
                Hapus Lama: {schedule.autoDeletePrevious !== false ? 'Otomatis (Anti-Penuh)' : 'Nonaktif'} · Drive: {schedule.saveToGoogleDrive ? 'Aktif' : 'Panel'}
              </div>
            </div>

            <div className="min-w-0">
              <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                Eksekusi Backup Satuan Cepat
              </div>
              <div className="flex items-center gap-2 mt-1">
                <select
                  aria-label="Pilih Server untuk Backup Satuan Cepat"
                  disabled={servers.length === 0}
                  value={quickSingleServerId}
                  onChange={(e) => setQuickSingleServerId(e.target.value)}
                  className={`px-2.5 py-1.5 text-xs rounded-lg border font-medium min-w-0 flex-1 truncate ${
                    isDark
                      ? 'bg-[#09090B] border-[#27272A] text-zinc-200 disabled:opacity-50'
                      : 'bg-slate-50 border-slate-300 text-slate-800 disabled:opacity-50'
                  }`}
                >
                  {servers.length === 0 ? (
                    <option value="">Belum ada server</option>
                  ) : (
                    servers.map((srv, idx) => (
                      <option key={srv.id} value={srv.id}>
                        Server {idx + 1}: {srv.name} ({srv.identifier})
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  disabled={servers.length === 0 || !quickSingleServerId}
                  onClick={() => handleBackupSingleServer(quickSingleServerId, 'manual_single', saveManualToDrive)}
                  className={`px-3 py-1.5 text-xs font-semibold text-white rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    isDark
                      ? 'bg-red-600 hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-500'
                      : 'bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400'
                  }`}
                >
                  Backup Satuan
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Live Action Feedback Banner */}
        {bannerNotice && (
          <div
            role="status"
            className={`w-full p-4 rounded-xl border text-xs font-medium flex items-center justify-between gap-4 ${
              bannerNotice.type === 'error'
                ? isDark
                  ? 'bg-red-950/50 border-red-500/70 text-red-200'
                  : 'bg-red-50 border-red-300 text-red-900'
                : bannerNotice.type === 'success'
                ? isDark
                  ? 'bg-emerald-950/40 border-emerald-600/60 text-emerald-200'
                  : 'bg-emerald-50 border-emerald-300 text-emerald-900'
                : isDark
                ? 'bg-zinc-900 border-zinc-700 text-zinc-200'
                : 'bg-blue-50 border-blue-300 text-blue-900'
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              {bannerNotice.type === 'error' ? (
                <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
              ) : (
                <CheckCircle2 className={`w-4 h-4 shrink-0 ${isDark ? 'text-red-400' : 'text-blue-600'}`} />
              )}
              <span className="break-words min-w-0 flex-1">{bannerNotice.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setBannerNotice(null)}
              className="text-xs underline opacity-80 hover:opacity-100 whitespace-nowrap shrink-0"
            >
              Tutup
            </button>
          </div>
        )}

        {/* Mobile Section Switcher (Grid 2x2 on small screens so zero horizontal scroll occurs) */}
        <div
          className={`grid grid-cols-2 sm:grid-cols-4 md:hidden gap-1.5 p-1.5 rounded-xl border ${
            isDark ? 'bg-[#121215] border-[#242429]' : 'bg-white border-slate-200'
          }`}
        >
          <button
            type="button"
            onClick={() => setActiveSection('servers')}
            className={`px-3 py-2 text-xs font-medium rounded-lg text-center truncate ${
              activeSection === 'servers'
                ? isDark
                  ? 'bg-red-600 text-white'
                  : 'bg-blue-600 text-white'
                : ''
            }`}
          >
            Daftar Server ({servers.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('vault')}
            className={`px-3 py-2 text-xs font-medium rounded-lg text-center truncate ${
              activeSection === 'vault'
                ? isDark
                  ? 'bg-red-600 text-white'
                  : 'bg-blue-600 text-white'
                : ''
            }`}
          >
            Arsip Terpisah ({totalBackupFiles})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('scheduler')}
            className={`px-3 py-2 text-xs font-medium rounded-lg text-center truncate ${
              activeSection === 'scheduler'
                ? isDark
                  ? 'bg-red-600 text-white'
                  : 'bg-blue-600 text-white'
                : ''
            }`}
          >
            Auto-Update
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('logs')}
            className={`px-3 py-2 text-xs font-medium rounded-lg text-center truncate ${
              activeSection === 'logs'
                ? isDark
                  ? 'bg-red-600 text-white'
                  : 'bg-blue-600 text-white'
                : ''
            }`}
          >
            Riwayat Log
          </button>
        </div>

        {/* SECTION 1: DAFTAR SERVER REAL & BACKUP SATUAN / SEMUA */}
        {activeSection === 'servers' && (
          <section aria-label="Daftar Server dan File Backup Terpisah" className="space-y-6 min-w-0">
            {servers.length === 0 ? (
              /* Real Empty State when API keys haven't been entered yet */
              <div
                className={`rounded-xl border p-8 sm:p-12 text-center max-w-3xl mx-auto ${
                  isDark ? 'bg-[#121215] border-[#242429]' : 'bg-white border-slate-200'
                }`}
              >
                <div
                  className={`w-12 h-12 rounded-xl mx-auto mb-4 flex items-center justify-center border ${
                    isDark
                      ? 'bg-red-950/30 border-red-500/40 text-red-400'
                      : 'bg-blue-50 border-blue-200 text-blue-600'
                  }`}
                >
                  <ShieldAlert className="w-6 h-6" />
                </div>
                <h2 className="text-xl font-bold tracking-tight">
                  Belum Ada Server Pterodactyl yang Ditautkan
                </h2>
                <p className={`text-xs sm:text-sm mt-2 max-w-xl mx-auto leading-relaxed ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                  Aplikasi ini hanya menampilkan <strong>server real</strong> yang benar-benar ada di panel Pterodactyl Anda (tanpa data server dummy/palsu). Silakan masukkan <strong>Domain Panel</strong>, <strong>Application API Key (PLTA)</strong>, dan <strong>Client API Key (PLTS/PLTC)</strong> untuk memuat seluruh server Anda secara langsung.
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => setIsApiModalOpen(true)}
                    className={`px-5 py-2.5 text-xs font-semibold text-white rounded-lg inline-flex items-center gap-2 transition-colors ${
                      isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    <KeyRound className="w-4 h-4" />
                    Pasang API Key &amp; Muat Server Real Sekarang
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Action & Filter Toolbar */}
                <div
                  className={`rounded-xl border p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                    isDark ? 'bg-[#121215] border-[#242429]' : 'bg-white border-slate-200'
                  }`}
                >
                  <div className="relative flex-1 min-w-0">
                    <Search
                      className={`w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 ${
                        isDark ? 'text-zinc-500' : 'text-slate-400'
                      }`}
                    />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Cari nama server real, identifier, atau node..."
                      aria-label="Cari server"
                      className={`w-full pl-10 pr-4 py-2 text-xs rounded-lg border transition-colors focus:outline-hidden ${
                        isDark
                          ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500 placeholder:text-zinc-500'
                          : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600 placeholder:text-slate-400'
                      }`}
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                    <button
                      type="button"
                      onClick={handleBackupSelectedServers}
                      className={`px-4 py-2 text-xs font-semibold text-white rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                        isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
                      }`}
                    >
                      <Server className="w-3.5 h-3.5" />
                      Backup Server Terpilih ({selectedServerIds.length})
                    </button>
                  </div>
                </div>

                {/* Real Server Cards List */}
                <div className="space-y-5 min-w-0">
                  {filteredServers.map((server) => {
                    const origIdx = servers.findIndex((s) => s.id === server.id) + 1;
                    return (
                      <ServerBackupCard
                        key={server.id}
                        server={server}
                        ordinalIndex={origIdx}
                        isSelected={selectedServerIds.includes(server.id)}
                        isBackingUp={backingUpIds.includes(server.id)}
                        uploadingDriveIds={uploadingDriveIds}
                        saveToDriveEnabled={saveManualToDrive}
                        onToggleSelect={(id) =>
                          setSelectedServerIds((prev) =>
                            prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
                          )
                        }
                        onBackupSingleServer={(id) =>
                          handleBackupSingleServer(id, 'manual_single', saveManualToDrive)
                        }
                        onDownloadBackup={handleDownloadBackup}
                        onUploadBackupToDrive={handleUploadBackupToDrive}
                        onToggleLockBackup={handleToggleLockBackup}
                        onDeleteBackup={handleRequestDeleteBackup}
                        theme={theme}
                      />
                    );
                  })}
                </div>
              </>
            )}

            {/* Inline Auto-Update Scheduler Panel */}
            <AutoBackupSchedulerPanel
              schedule={schedule}
              servers={servers}
              isDriveConnected={isDriveConnected}
              onRequestGoogleSignIn={handleGoogleLogin}
              onUpdateSchedule={(updated) => {
                setSchedule(updated);
                appendLog(
                  'Perbarui Jadwal Auto-Update',
                  updated.targetScope === 'all'
                    ? 'Semua Server'
                    : `${updated.selectedServerIds.length} Server Pilihan`,
                  `Frekuensi: ${updated.frequency}, Simpan ke Google Drive: ${
                    updated.saveToGoogleDrive ? 'Ya' : 'Tidak'
                  }.`,
                  'info'
                );
              }}
              onTriggerScheduledRunNow={handleTriggerScheduledRunNow}
              theme={theme}
            />
          </section>
        )}

        {/* SECTION 2: EKSPLORER ARSIP TERPISAH PER SERVER */}
        {activeSection === 'vault' && (
          <section
            aria-label="Eksplorer Pemisahan File Backup"
            className={`w-full rounded-xl border p-4 sm:p-6 transition-colors min-w-0 ${
              isDark ? 'bg-[#121215] border-[#242429]' : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-current/10">
              <div className="min-w-0">
                <p className={`text-xs font-medium mb-1 ${isDark ? 'text-red-400' : 'text-blue-600'}`}>
                  Isolasi Penyimpanan Arsip Real &amp; Google Drive
                </p>
                <h2 className="text-lg sm:text-xl font-bold tracking-tight">
                  Daftar File Backup Terpisah per Server
                </h2>
                <p className={`text-xs mt-1 ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                  Setiap server memiliki prefix namespace <code className="font-mono">srv01_</code>, <code className="font-mono">srv02_</code>, dan folder mandiri di Google Drive (<code className="font-mono">PteroVault_Backups/Server_01_...</code>).
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setVaultServerFilter('all')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                    vaultServerFilter === 'all'
                      ? isDark
                        ? 'bg-red-600 border-red-600 text-white'
                        : 'bg-blue-600 border-blue-600 text-white'
                      : isDark
                      ? 'border-[#27272A] text-zinc-400 hover:text-white'
                      : 'border-slate-200 text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Semua Server ({totalBackupFiles})
                </button>
                {servers.map((srv, idx) => (
                  <button
                    key={srv.id}
                    type="button"
                    onClick={() => setVaultServerFilter(srv.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                      vaultServerFilter === srv.id
                        ? isDark
                          ? 'bg-red-600 border-red-600 text-white'
                          : 'bg-blue-600 border-blue-600 text-white'
                        : isDark
                        ? 'border-[#27272A] text-zinc-400 hover:text-white'
                        : 'border-slate-200 text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    File Server {idx + 1} ({srv.backups.length})
                  </button>
                ))}
              </div>
            </div>

            {allSeparatedBackups.length === 0 ? (
              <div className="py-10 text-center text-xs opacity-75">
                Belum ada file arsip yang dimuat. Hubungkan panel Pterodactyl Anda atau jalankan backup pada server.
              </div>
            ) : (
              <div className="mt-5 space-y-2.5">
                {allSeparatedBackups.map(({ serverOrdinal, server, backup }) => {
                  const isUploadingThis = uploadingDriveIds.includes(backup.id);
                  return (
                    <div
                      key={backup.id}
                      className={`p-3.5 rounded-lg border flex flex-col md:flex-row md:items-center justify-between gap-3 min-w-0 ${
                        isDark ? 'bg-[#09090B] border-[#1F1F23]' : 'bg-slate-50 border-slate-200'
                      }`}
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-bold">Server {serverOrdinal}: {server.name}</span>
                          <span className={`font-mono text-[11px] ${isDark ? 'text-red-400' : 'text-blue-600'}`}>
                            /vault/server-{serverOrdinal}-{server.identifier}/
                          </span>
                        </div>
                        <div className="font-mono text-xs font-medium break-all">{backup.fileName}</div>
                        <div className={`text-[11px] font-mono tabular-nums ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                          {formatBytes(backup.sizeBytes)} · {new Date(backup.createdAt).toLocaleString('id-ID')}
                          {backup.driveFileId ? ` · Tersimpan di Google Drive (${backup.driveFolderName})` : ''}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {backup.driveWebViewLink ? (
                          <a
                            href={backup.driveWebViewLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`px-3 py-1.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                              isDark
                                ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300 hover:bg-emerald-950/50'
                                : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                            }`}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            Buka di Google Drive
                          </a>
                        ) : (
                          <button
                            type="button"
                            disabled={isUploadingThis}
                            onClick={() => handleUploadBackupToDrive(backup, serverOrdinal)}
                            className={`px-3 py-1.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                              isDark
                                ? 'border-red-500/40 bg-red-950/25 text-red-300 hover:bg-red-950/40'
                                : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                            }`}
                          >
                            <CloudUpload className="w-3.5 h-3.5" />
                            {isUploadingThis ? 'Mengunggah...' : 'Simpan ke Google Drive'}
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => handleDownloadBackup(backup)}
                          className={`px-3 py-1.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                            isDark
                              ? 'border-[#27272A] text-zinc-200 hover:bg-zinc-800'
                              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          <Download className="w-3.5 h-3.5" />
                          Unduh File Server {serverOrdinal}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* SECTION 3: DEDICATED AUTO-UPDATE SCHEDULER */}
        {activeSection === 'scheduler' && (
          <AutoBackupSchedulerPanel
            schedule={schedule}
            servers={servers}
            isDriveConnected={isDriveConnected}
            onRequestGoogleSignIn={handleGoogleLogin}
            onUpdateSchedule={(updated) => {
              setSchedule(updated);
              appendLog(
                'Perbarui Jadwal Auto-Update',
                updated.targetScope === 'all'
                  ? 'Semua Server'
                  : `${updated.selectedServerIds.length} Server Pilihan`,
                `Frekuensi: ${updated.frequency}, Simpan ke Google Drive: ${
                  updated.saveToGoogleDrive ? 'Ya' : 'Tidak'
                }.`,
                'info'
              );
            }}
            onTriggerScheduledRunNow={handleTriggerScheduledRunNow}
            theme={theme}
          />
        )}

        {/* SECTION 4: ACTIVITY LOGS */}
        {activeSection === 'logs' && (
          <section
            aria-label="Riwayat Aktivitas Backup"
            className={`w-full rounded-xl border p-4 sm:p-6 transition-colors min-w-0 ${
              isDark ? 'bg-[#121215] border-[#242429]' : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-current/10">
              <div className="min-w-0">
                <h2 className="text-lg sm:text-xl font-bold tracking-tight">Riwayat Eksekusi Backup, Auto-Update &amp; Google Drive</h2>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                  Catatan sinkronisasi panel real, pembuatan file backup satuan/massal, dan penyimpanan ke Google Drive.
                </p>
              </div>
              <Clock className={`w-5 h-5 shrink-0 ${isDark ? 'text-red-400' : 'text-blue-600'}`} />
            </div>

            {logs.length === 0 ? (
              <div className="py-10 text-center text-xs opacity-70">
                Belum ada riwayat aktivitas. Hubungkan panel Pterodactyl Anda untuk memulai.
              </div>
            ) : (
              <div className="mt-4 divide-y divide-current/10 text-xs">
                {logs.map((log) => (
                  <div key={log.id} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 min-w-0">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-sm">{log.action}</div>
                      <div className={`mt-0.5 break-words ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                        Target: <span className="font-medium">{log.targetServer}</span> — {log.details}
                      </div>
                    </div>
                    <div className={`font-mono tabular-nums shrink-0 ${isDark ? 'text-zinc-500' : 'text-slate-400'}`}>
                      {new Date(log.timestamp).toLocaleString('id-ID')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {/* Explicit Confirmation Modal for Deleting a Backup File */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-delete-title"
        >
          <div
            className={`w-full max-w-md rounded-xl border p-6 ${
              isDark ? 'bg-[#121215] border-[#26262B] text-white' : 'bg-white border-slate-200 text-slate-900 shadow-xl'
            }`}
          >
            <div className="flex items-center gap-2.5 text-red-500 mb-2">
              <Trash2 className="w-5 h-5 shrink-0" />
              <h3 id="confirm-delete-title" className="text-base font-bold">
                Konfirmasi Hapus File Backup
              </h3>
            </div>
            <p className={`text-xs leading-relaxed ${isDark ? 'text-zinc-300' : 'text-slate-600'}`}>
              Apakah Anda yakin ingin menghapus arsip backup{' '}
              <code className="font-mono font-semibold break-all">{pendingDelete.backup.fileName}</code> milik{' '}
              <strong>{pendingDelete.serverName}</strong>? Tindakan ini tidak dapat dibatalkan.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className={`px-3.5 py-2 text-xs font-medium rounded-lg border ${
                  isDark ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800' : 'border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                Batal
              </button>
              {pendingDelete.backup.driveFileId && (
                <button
                  type="button"
                  onClick={() => handleConfirmDeleteBackup(true)}
                  className="px-3.5 py-2 text-xs font-semibold text-white bg-red-700 hover:bg-red-600 rounded-lg"
                >
                  Hapus di Panel &amp; Google Drive
                </button>
              )}
              <button
                type="button"
                onClick={() => handleConfirmDeleteBackup(false)}
                className="px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 rounded-lg"
              >
                Hapus dari Panel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API Key Configuration Modal (PLTA, PLTS, Domain) */}
      <ApiKeyConfigModal
        isOpen={isApiModalOpen}
        onClose={() => setIsApiModalOpen(false)}
        credentials={credentials}
        isConnected={isConnected}
        onSaveCredentials={handleSaveCredentials}
        onDisconnect={() => {
          setCredentials({ domain: '', pltaKey: '', pltsKey: '' });
          setServers([]);
          setSelectedServerIds([]);
          setQuickSingleServerId('');
          appendLog('Putuskan Kredensial API', 'Panel Pterodactyl', 'Kredensial dan daftar server real dibersihkan dari sesi web.', 'warning');
        }}
        theme={theme}
      />

      {/* Google Drive & Vercel Login Configuration Modal */}
      <GoogleDriveConfigModal
        isOpen={isDriveConfigModalOpen}
        onClose={() => setIsDriveConfigModalOpen(false)}
        autoOpenedReason={driveModalAutoReason}
        onConnected={(user, token) => {
          setGoogleUser(user);
          setGoogleToken(token);
          appendLog(
            'Google Drive Terhubung (Mode Vercel/OAuth)',
            user.email || 'Google Drive',
            'Koneksi Google Drive berhasil diverifikasi dan siap menyimpan file backup.',
            'success'
          );
          showNotice(
            `Berhasil terhubung ke Google Drive sebagai ${user.email || user.displayName}!`,
            'success'
          );
        }}
        theme={theme}
      />

      {/* Clean Footer */}
      <footer
        className={`w-full mt-12 border-t py-6 px-4 sm:px-6 text-xs transition-colors ${
          isDark ? 'border-[#1F1F23] text-zinc-500' : 'border-slate-200 text-slate-500'
        }`}
      >
        <div className="max-w-[1360px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <FolderSync className="w-4 h-4 shrink-0" />
            <span className="truncate">PteroVault Backup Manager — Integrasi Real API Pterodactyl &amp; Google Drive</span>
          </div>
          <div className="shrink-0">
            Tema Aktif: {isDark ? 'Hitam & Merah (Dark Mode)' : 'Putih & Biru (White Mode)'}
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
