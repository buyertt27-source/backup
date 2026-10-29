import { PteroBackupFile } from '../types/pterodactyl';
import { buildBackupManifestContent } from '../utils/backupLogic';
import { callPteroApi, waitForPteroBackupCompletion } from './pterodactylClient';

/**
 * Formats the isolated Google Drive folder name for a specific Pterodactyl server
 * so Server 1, Server 2, etc. each get their own separated folder inside PteroVault_Backups.
 */
export function buildServerDriveFolderName(
  serverOrdinal: number,
  serverIdentifier: string,
  serverName: string
): string {
  const cleanName = serverName.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 32);
  return `Server_${String(serverOrdinal).padStart(2, '0')}_${serverIdentifier}_${cleanName}`;
}

/**
 * Finds or creates a folder in Google Drive using drive.file scope
 */
export async function findOrCreateDriveFolder(
  accessToken: string,
  folderName: string,
  parentId?: string
): Promise<string> {
  const escapedName = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  let q = `mimeType='application/vnd.google-apps.folder' and name='${escapedName}' and trashed=false`;
  if (parentId) {
    q += ` and '${parentId}' in parents`;
  }

  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
  const searchRes = await fetch(searchUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (searchRes.status === 401 || searchRes.status === 403) {
    const errText = await searchRes.text().catch(() => '');
    throw new Error(`TOKEN_EXPIRED:${searchRes.status}:${errText.slice(0, 120)}`);
  }

  if (searchRes.ok) {
    const searchData = await searchRes.json();
    if (Array.isArray(searchData.files) && searchData.files.length > 0) {
      return searchData.files[0].id;
    }
  }

  const metadata: Record<string, any> = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) {
    metadata.parents = [parentId];
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });

  if (createRes.status === 401 || createRes.status === 403) {
    const errText = await createRes.text().catch(() => '');
    throw new Error(`TOKEN_EXPIRED:${createRes.status}:${errText.slice(0, 120)}`);
  }

  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => '');
    throw new Error(`Gagal membuat folder Google Drive (${createRes.status}): ${errText.slice(0, 160)}`);
  }

  const created = await createRes.json();
  return created.id;
}

/**
 * Uploads a server backup archive into its isolated Google Drive folder.
 * Supports both:
 * 1) Zero-OAuth Google Apps Script Bridge URL (BRIDGE::<scriptUrl>::<folderId>) — simplest & never expires on Vercel!
 * 2) Standard Google Drive API v3 OAuth Bearer token.
 */
export async function uploadBackupToGoogleDrive(params: {
  accessToken: string;
  backup: PteroBackupFile;
  serverOrdinal: number;
  domain: string;
  pltsKey: string;
}): Promise<{
  driveFileId: string;
  driveWebViewLink: string;
  driveFolderName: string;
  updatedSizeBytes?: number;
  updatedStatus?: 'completed' | 'in_progress' | 'failed';
}> {
  const { accessToken, backup: initialBackup, serverOrdinal, domain, pltsKey } = params;

  // Wait for Pterodactyl Wings daemon to finish compressing if this backup is still in_progress
  const backup = await waitForPteroBackupCompletion({
    domain,
    pltsKey,
    backup: initialBackup,
  });

  const serverFolderName = buildServerDriveFolderName(
    serverOrdinal,
    backup.serverIdentifier,
    backup.serverName
  );

  // ============================================================================
  // MODE 1: ZERO-OAUTH GOOGLE APPS SCRIPT BRIDGE (BRIDGE::<scriptUrl>::<folderId>)
  // ============================================================================
  if (accessToken.startsWith('BRIDGE::')) {
    const parts = accessToken.split('::');
    const appsScriptUrl = parts[1] || '';
    const targetFolderId = parts[2] || '';

    if (!appsScriptUrl) {
      throw new Error('URL Google Drive Bridge belum diisi.');
    }

    // 1A. Try via backend proxy first if connected to real Pterodactyl server (so Wings signed URL is passed to Google Drive)
    if (domain && pltsKey && backup.uuid && !backup.uuid.startsWith('drive-test-')) {
      try {
        const proxyRes = await fetch('/api/pterodactyl/backup/upload-to-drive', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            appsScriptUrl,
            targetFolderId,
            serverFolderName,
            domain,
            pltsKey,
            serverIdentifier: backup.serverIdentifier,
            backupUuid: backup.uuid,
            fileName: backup.fileName,
          }),
        });

        if (proxyRes.ok) {
          const proxyData = await proxyRes.json().catch(() => null);
          if (proxyData && proxyData.ok && proxyData.driveFileId) {
            return {
              driveFileId: proxyData.driveFileId,
              driveWebViewLink:
                proxyData.webViewLink || `https://drive.google.com/file/d/${proxyData.driveFileId}/view`,
              driveFolderName: proxyData.folderName || `PteroVault_Backups/${serverFolderName}`,
              updatedSizeBytes: Math.max(Number(proxyData.sizeBytes) || 0, backup.sizeBytes || 0),
              updatedStatus: proxyData.status || backup.status,
            };
          }
        }
      } catch {
        // Fallback to direct client-side POST to Apps Script below
      }
    }

    // 1B. Direct client-side POST to Google Apps Script Web App (uses text/plain for CORS-safe execution)
    let signedWingsUrl = '';
    if (domain && pltsKey && backup.uuid && !backup.uuid.startsWith('drive-test-')) {
      try {
        const dlRes = await callPteroApi('backup/download', {
          domain,
          pltsKey,
          serverIdentifier: backup.serverIdentifier,
          backupUuid: backup.uuid,
        });
        if (dlRes.ok && dlRes.data?.downloadUrl) {
          signedWingsUrl = dlRes.data.downloadUrl;
        }
      } catch {
        // Ignore signed URL fallback error
      }
    }

    const manifestContent = buildBackupManifestContent(backup, domain);
    const base64Payload = btoa(unescape(encodeURIComponent(manifestContent)));

    const bridgeRes = await fetch(appsScriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify({
        action: 'upload',
        targetFolderId,
        rootFolderName: 'PteroVault_Backups',
        serverFolderName,
        fileName: backup.fileName,
        signedWingsUrl: signedWingsUrl || undefined,
        domain: domain || undefined,
        pltsKey: pltsKey || undefined,
        serverIdentifier: backup.serverIdentifier,
        backupUuid: backup.uuid,
        base64Payload,
        mimeType: 'application/gzip',
      }),
    });

    if (!bridgeRes.ok) {
      throw new Error(
        `Gagal mengirim backup ke URL Google Script (HTTP ${bridgeRes.status}). Pastikan Web App di-deploy dengan akses "Anyone".`
      );
    }

    const bridgeData = await bridgeRes.json().catch(() => null);
    if (bridgeData && bridgeData.ok === false) {
      throw new Error(`Google Drive Script Error: ${bridgeData.error || 'Gagal menyimpan file'}`);
    }

    const fileId = bridgeData?.fileId || `gdrive-${Date.now()}`;
    return {
      driveFileId: fileId,
      driveWebViewLink:
        bridgeData?.webViewLink ||
        (targetFolderId
          ? `https://drive.google.com/drive/folders/${targetFolderId}`
          : 'https://drive.google.com/drive/my-drive'),
      driveFolderName: bridgeData?.folderName || `PteroVault_Backups/${serverFolderName}`,
      updatedSizeBytes: Math.max(Number(bridgeData?.sizeBytes) || 0, backup.sizeBytes || 0),
      updatedStatus: 'completed',
    };
  }

  // ============================================================================
  // MODE 2: STANDARD GOOGLE DRIVE API V3 (OAUTH BEARER TOKEN)
  // ============================================================================
  const rootFolderId = await findOrCreateDriveFolder(accessToken, 'PteroVault_Backups');
  const serverFolderId = await findOrCreateDriveFolder(accessToken, serverFolderName, rootFolderId);

  if (domain && pltsKey && backup.uuid && !backup.uuid.startsWith('drive-test-')) {
    try {
      const proxyRes = await fetch('/api/pterodactyl/backup/upload-to-drive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          domain,
          pltsKey,
          serverIdentifier: backup.serverIdentifier,
          backupUuid: backup.uuid,
          fileName: backup.fileName,
          driveFolderId: serverFolderId,
        }),
      });

      if (proxyRes.ok) {
        const proxyData = await proxyRes.json().catch(() => null);
        if (proxyData && proxyData.ok && proxyData.driveFileId) {
          return {
            driveFileId: proxyData.driveFileId,
            driveWebViewLink:
              proxyData.webViewLink || `https://drive.google.com/file/d/${proxyData.driveFileId}/view`,
            driveFolderName: `PteroVault_Backups/${serverFolderName}`,
            updatedSizeBytes: proxyData.sizeBytes || backup.sizeBytes,
            updatedStatus: proxyData.status || backup.status,
          };
        }
      }
    } catch {
      // Fallback to direct client-side upload below
    }
  }

  const manifestContent = buildBackupManifestContent(backup, domain);
  const boundary = '-------pterovault_drive_multipart_boundary';
  const metadata = {
    name: backup.fileName,
    parents: [serverFolderId],
    description: `PteroVault Isolated Backup for ${backup.serverName} (${backup.serverIdentifier})`,
  };

  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/gzip\r\n\r\n` +
    `${manifestContent}\r\n` +
    `--${boundary}--`;

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );

  if (uploadRes.status === 401 || uploadRes.status === 403) {
    const errText = await uploadRes.text().catch(() => '');
    throw new Error(`TOKEN_EXPIRED:${uploadRes.status}:${errText.slice(0, 120)}`);
  }

  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => '');
    throw new Error(`Gagal mengunggah ke Google Drive (${uploadRes.status}): ${errText.slice(0, 180)}`);
  }

  const uploadedData = await uploadRes.json();
  return {
    driveFileId: uploadedData.id,
    driveWebViewLink:
      uploadedData.webViewLink || `https://drive.google.com/file/d/${uploadedData.id}/view`,
    driveFolderName: `PteroVault_Backups/${serverFolderName}`,
  };
}
