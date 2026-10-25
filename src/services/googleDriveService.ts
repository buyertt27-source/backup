import { PteroBackupFile } from '../types/pterodactyl';
import { buildBackupManifestContent } from '../utils/backupLogic';

/**
 * Formats the isolated Google Drive folder name for a specific Pterodactyl server
 * so Server 1, Server 2, etc. each get their own separated folder inside PteroVault_Backups.
 */
export function buildServerDriveFolderName(serverOrdinal: number, serverIdentifier: string, serverName: string): string {
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

  // Create folder if not found
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
 * Uploads a server backup archive (or transfers via backend from Wings signed URL) into its isolated Google Drive folder.
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
  const { accessToken, backup, serverOrdinal, domain, pltsKey } = params;

  // 1. Ensure Root Folder "PteroVault_Backups" exists in Google Drive
  const rootFolderId = await findOrCreateDriveFolder(accessToken, 'PteroVault_Backups');

  // 2. Ensure Isolated Per-Server Subfolder exists (e.g. "Server_01_srv01a9f_PaperMC")
  const serverFolderName = buildServerDriveFolderName(serverOrdinal, backup.serverIdentifier, backup.serverName);
  const serverFolderId = await findOrCreateDriveFolder(accessToken, serverFolderName, rootFolderId);

  // 3. Try transferring the binary archive via our server-side proxy (which also polls Wings until completion)
  if (domain && pltsKey && backup.uuid) {
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
        const proxyData = await proxyRes.json();
        if (proxyData.ok && proxyData.driveFileId) {
          return {
            driveFileId: proxyData.driveFileId,
            driveWebViewLink:
              proxyData.webViewLink || `https://drive.google.com/file/d/${proxyData.driveFileId}/view`,
            driveFolderName: `PteroVault_Backups/${serverFolderName}`,
            updatedSizeBytes: proxyData.sizeBytes,
            updatedStatus: proxyData.status,
          };
        }
      }
    } catch {
      // Fallback to direct client-side upload below if server proxy times out
    }
  }

  // 4. Direct client-side resumable/multipart upload to Google Drive
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
