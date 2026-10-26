import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import rawFirebaseConfig from '../../firebase-applet-config.json';
import { extractDriveFolderId, validateAppsScriptUrl } from '../utils/backupLogic';

export const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

export interface GoogleDriveUser {
  email: string | null;
  displayName: string | null;
  photoURL?: string | null;
  folderUrl?: string | null;
  authMethod?: 'apps_script_bridge' | 'firebase' | 'gis_client' | 'direct_token';
}

export interface GoogleDriveAuthConfig {
  appsScriptUrl?: string;
  targetFolderId?: string;
  customClientId: string;
  directAccessToken: string;
  refreshToken: string;
  clientSecret: string;
  connectedEmail?: string;
  connectedFolderUrl?: string;
}

const GDRIVE_CONFIG_STORAGE_KEY = 'pterovault_gdrive_vercel_config_v1';

// Merge static config with optional VITE_ environment variables for Vercel deployments
const firebaseConfig = {
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || rawFirebaseConfig.projectId,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || rawFirebaseConfig.appId,
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || rawFirebaseConfig.apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || rawFirebaseConfig.authDomain,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || rawFirebaseConfig.storageBucket,
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || rawFirebaseConfig.messagingSenderId,
  oAuthClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID || rawFirebaseConfig.oAuthClientId,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
SCOPES.forEach((scope) => provider.addScope(scope));
provider.setCustomParameters({ prompt: 'select_account' });

let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedTokenExpiryMs = 0;
let cachedUser: GoogleDriveUser | null = null;

export function getSavedDriveAuthConfig(): GoogleDriveAuthConfig {
  try {
    const raw = localStorage.getItem(GDRIVE_CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        appsScriptUrl: String(parsed.appsScriptUrl || '').trim(),
        targetFolderId: String(parsed.targetFolderId || '').trim(),
        customClientId: String(parsed.customClientId || '').trim(),
        directAccessToken: String(parsed.directAccessToken || '').trim(),
        refreshToken: String(parsed.refreshToken || '').trim(),
        clientSecret: String(parsed.clientSecret || '').trim(),
        connectedEmail: parsed.connectedEmail || undefined,
        connectedFolderUrl: parsed.connectedFolderUrl || undefined,
      };
    }
  } catch {
    // ignore storage read error
  }
  return {
    appsScriptUrl: '',
    targetFolderId: '',
    customClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID || '',
    directAccessToken: '',
    refreshToken: '',
    clientSecret: '',
  };
}

export function saveDriveAuthConfig(config: GoogleDriveAuthConfig): void {
  try {
    localStorage.setItem(GDRIVE_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore storage write error
  }
}

export function getDefaultOAuthClientId(): string {
  return firebaseConfig.oAuthClientId || '';
}

export function getDefaultFirebaseProjectId(): string {
  return firebaseConfig.projectId || '';
}

/**
 * Connects Google Drive using the zero-OAuth Google Apps Script Bridge URL (100% Permanent & Vercel-friendly).
 */
export async function connectWithAppsScriptBridge(
  rawScriptUrl: string,
  rawFolderInput = ''
): Promise<{ user: GoogleDriveUser; accessToken: string }> {
  const validation = validateAppsScriptUrl(rawScriptUrl);
  if (!validation.valid) {
    throw new Error(validation.error || 'URL Google Script tidak valid.');
  }

  const cleanUrl = validation.cleanUrl;
  const folderId = extractDriveFolderId(rawFolderInput);

  let detectedEmail = 'Google Drive (Bridge Permanen Aktif)';
  let detectedFolderUrl = folderId
    ? `https://drive.google.com/drive/folders/${folderId}`
    : undefined;

  // Test ping to Google Apps Script Web App
  try {
    const pingRes = await fetch(cleanUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'ping',
        targetFolderId: folderId,
        rootFolderName: 'PteroVault_Backups',
      }),
    });

    if (pingRes.ok) {
      const data = await pingRes.json().catch(() => null);
      if (data && data.ok === false) {
        throw new Error(`Script Google Drive merespons error: ${data.error || 'Unknown error'}`);
      }
      if (data?.email) {
        detectedEmail = data.email;
      }
      if (data?.folderUrl) {
        detectedFolderUrl = data.folderUrl;
      }
    }
  } catch (err: any) {
    if (String(err?.message || '').includes('Script Google Drive merespons error')) {
      throw err;
    }
    // Even if browser blocks reading redirect response, the bridge URL itself is valid
  }

  const bridgeToken = `BRIDGE::${cleanUrl}::${folderId}`;
  const bridgeUser: GoogleDriveUser = {
    email: detectedEmail,
    displayName: 'Google Drive Bridge',
    folderUrl: detectedFolderUrl || null,
    authMethod: 'apps_script_bridge',
  };

  cachedAccessToken = bridgeToken;
  cachedTokenExpiryMs = Number.MAX_SAFE_INTEGER;
  cachedUser = bridgeUser;

  saveDriveAuthConfig({
    ...getSavedDriveAuthConfig(),
    appsScriptUrl: cleanUrl,
    targetFolderId: folderId,
    connectedEmail: detectedEmail,
    connectedFolderUrl: detectedFolderUrl,
  });

  return { user: bridgeUser, accessToken: bridgeToken };
}

/**
 * Verifies a Google OAuth2 access token against Google Drive API v3
 * and returns the associated Google account profile.
 */
export async function verifyGoogleDriveToken(accessToken: string): Promise<GoogleDriveUser> {
  const cleanToken = accessToken.trim();
  if (!cleanToken) {
    throw new Error('Access Token Google Drive kosong.');
  }

  if (cleanToken.startsWith('BRIDGE::')) {
    const parts = cleanToken.split('::');
    const res = await connectWithAppsScriptBridge(parts[1] || '', parts[2] || '');
    return res.user;
  }

  // 1. Check Drive v3 about endpoint (works with drive.file scope)
  const aboutRes = await fetch(
    'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink)',
    {
      headers: { Authorization: `Bearer ${cleanToken}` },
    }
  );

  if (aboutRes.ok) {
    const data = await aboutRes.json();
    const u = data?.user || {};
    return {
      email: u.emailAddress || 'Google Drive Terhubung',
      displayName: u.displayName || u.emailAddress || 'Google Drive User',
      photoURL: u.photoLink || null,
      authMethod: 'direct_token',
    };
  }

  // 2. Fallback check against files.list (strict drive.file check)
  const filesRes = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)', {
    headers: { Authorization: `Bearer ${cleanToken}` },
  });

  if (filesRes.ok) {
    return {
      email: 'Google Drive Aktif (Token Terverifikasi)',
      displayName: 'Google Drive User',
      photoURL: null,
      authMethod: 'direct_token',
    };
  }

  const errText = await filesRes.text().catch(() => '');
  throw new Error(
    `Token Google Drive tidak valid atau sudah kadaluarsa (HTTP ${filesRes.status}). ${errText.slice(0, 120)}`
  );
}

/**
 * Exchanges a Google OAuth2 Refresh Token for a fresh Access Token
 */
export async function refreshGoogleAccessToken(
  config: GoogleDriveAuthConfig
): Promise<{ accessToken: string; expiresIn: number }> {
  const clientId = config.customClientId.trim() || firebaseConfig.oAuthClientId;
  const clientSecret = config.clientSecret.trim();
  const refreshToken = config.refreshToken.trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Client ID, Client Secret, dan Refresh Token diperlukan untuk auto-refresh token.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gagal me-refresh token Google Drive (HTTP ${response.status}): ${errText.slice(0, 150)}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Respons OAuth2 tidak mengandung access_token baru.');
  }

  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in) || 3500,
  };
}

/**
 * Dynamically loads Google Identity Services (GIS) script (https://accounts.google.com/gsi/client)
 */
function loadGoogleGsiScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && (window as any).google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Gagal memuat script Google Identity Services.')));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Gagal memuat script Google Identity Services (GIS).'));
    document.head.appendChild(script);
  });
}

/**
 * Performs Google OAuth2 Popup Login using Google Identity Services (GIS) directly.
 */
export async function signInWithGoogleGIS(
  clientIdOverride?: string
): Promise<{ user: GoogleDriveUser; accessToken: string }> {
  const savedCfg = getSavedDriveAuthConfig();
  const clientId = (
    clientIdOverride ||
    savedCfg.customClientId ||
    import.meta.env.VITE_GOOGLE_CLIENT_ID ||
    firebaseConfig.oAuthClientId ||
    ''
  ).trim();

  if (!clientId) {
    throw new Error('Google OAuth Client ID belum dikonfigurasi.');
  }

  await loadGoogleGsiScript();

  return new Promise((resolve, reject) => {
    try {
      const oauth2 = (window as any).google?.accounts?.oauth2;
      if (!oauth2) {
        reject(new Error('Google Identity Services (GIS) tidak tersedia di browser.'));
        return;
      }

      const tokenClient = oauth2.initTokenClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/drive.file email profile',
        callback: async (tokenResponse: any) => {
          if (tokenResponse?.error) {
            reject(
              new Error(
                `Google OAuth Error (${tokenResponse.error}): ${
                  tokenResponse.error_description || 'Gunakan metode Tautan Cepat Google Script (Tanpa Login) untuk Vercel.'
                }`
              )
            );
            return;
          }

          const accessToken = tokenResponse?.access_token;
          if (!accessToken) {
            reject(new Error('Tidak menerima access_token dari Google.'));
            return;
          }

          try {
            const verifiedUser = await verifyGoogleDriveToken(accessToken);
            verifiedUser.authMethod = 'gis_client';
            cachedAccessToken = accessToken;
            cachedTokenExpiryMs = Date.now() + (Number(tokenResponse.expires_in) || 3500) * 1000;
            cachedUser = verifiedUser;

            saveDriveAuthConfig({
              ...getSavedDriveAuthConfig(),
              customClientId: clientIdOverride || savedCfg.customClientId,
              directAccessToken: accessToken,
              connectedEmail: verifiedUser.email || undefined,
            });

            resolve({ user: verifiedUser, accessToken });
          } catch (verifyErr: any) {
            reject(verifyErr);
          }
        },
        error_callback: (err: any) => {
          reject(
            new Error(
              err?.message ||
                'Popup login Google ditutup. Gunakan Tautan Cepat Google Drive (Tanpa Login OAuth) agar lebih simpel.'
            )
          );
        },
      });

      tokenClient.requestAccessToken({ prompt: 'consent' });
    } catch (err: any) {
      reject(err);
    }
  });
}

/**
 * Connects Google Drive using a direct Access Token or Refresh Token
 */
export async function connectWithDirectTokenOrRefresh(
  config: GoogleDriveAuthConfig
): Promise<{ user: GoogleDriveUser; accessToken: string }> {
  let tokenToUse = config.directAccessToken.trim();

  if (config.refreshToken.trim() && config.clientSecret.trim()) {
    const refreshed = await refreshGoogleAccessToken(config);
    tokenToUse = refreshed.accessToken;
    cachedTokenExpiryMs = Date.now() + refreshed.expiresIn * 1000;
  } else {
    cachedTokenExpiryMs = Date.now() + 3500 * 1000;
  }

  const verifiedUser = await verifyGoogleDriveToken(tokenToUse);
  cachedAccessToken = tokenToUse;
  cachedUser = verifiedUser;

  saveDriveAuthConfig({
    ...config,
    directAccessToken: tokenToUse,
    connectedEmail: verifiedUser.email || undefined,
  });

  return { user: verifiedUser, accessToken: tokenToUse };
}

export const initAuth = (
  onAuthSuccess?: (user: GoogleDriveUser, token: string) => void,
  onAuthFailure?: () => void
) => {
  const savedCfg = getSavedDriveAuthConfig();

  // 1. Check if Permanent Google Apps Script Bridge is configured (Zero-OAuth, Never Expires!)
  if (savedCfg.appsScriptUrl) {
    const bridgeToken = `BRIDGE::${savedCfg.appsScriptUrl}::${savedCfg.targetFolderId || ''}`;
    const bridgeUser: GoogleDriveUser = {
      email: savedCfg.connectedEmail || 'Google Drive (Tautan Permanen Aktif)',
      displayName: 'Google Drive Bridge',
      folderUrl: savedCfg.connectedFolderUrl || null,
      authMethod: 'apps_script_bridge',
    };
    cachedAccessToken = bridgeToken;
    cachedTokenExpiryMs = Number.MAX_SAFE_INTEGER;
    cachedUser = bridgeUser;
    if (onAuthSuccess) {
      setTimeout(() => onAuthSuccess(bridgeUser, bridgeToken), 0);
    }
  }

  // 2. Check if we returned from a Firebase signInWithRedirect flow
  getRedirectResult(auth)
    .then((result) => {
      if (result) {
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
          cachedAccessToken = credential.accessToken;
          cachedTokenExpiryMs = Date.now() + 3500 * 1000;
          cachedUser = {
            email: result.user.email,
            displayName: result.user.displayName,
            photoURL: result.user.photoURL,
            authMethod: 'firebase',
          };
          if (onAuthSuccess) onAuthSuccess(cachedUser, cachedAccessToken);
        }
      }
    })
    .catch(() => {
      // ignore redirect check errors
    });

  // 3. Check if there is a saved direct token or refresh token
  if (!savedCfg.appsScriptUrl && savedCfg.refreshToken && savedCfg.clientSecret) {
    refreshGoogleAccessToken(savedCfg)
      .then(async ({ accessToken, expiresIn }) => {
        const user = await verifyGoogleDriveToken(accessToken);
        cachedAccessToken = accessToken;
        cachedTokenExpiryMs = Date.now() + expiresIn * 1000;
        cachedUser = user;
        if (onAuthSuccess) onAuthSuccess(user, accessToken);
      })
      .catch(() => {});
  } else if (!savedCfg.appsScriptUrl && savedCfg.directAccessToken) {
    verifyGoogleDriveToken(savedCfg.directAccessToken)
      .then((user) => {
        cachedAccessToken = savedCfg.directAccessToken;
        cachedTokenExpiryMs = Date.now() + 1800 * 1000;
        cachedUser = user;
        if (onAuthSuccess) onAuthSuccess(user, savedCfg.directAccessToken);
      })
      .catch(() => {
        saveDriveAuthConfig({ ...savedCfg, directAccessToken: '' });
      });
  }

  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user && cachedAccessToken && !cachedAccessToken.startsWith('BRIDGE::')) {
      const mapped: GoogleDriveUser = {
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        authMethod: 'firebase',
      };
      cachedUser = mapped;
      if (onAuthSuccess) onAuthSuccess(mapped, cachedAccessToken);
    } else if (!cachedAccessToken && !isSigningIn) {
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: GoogleDriveUser; accessToken: string } | null> => {
  const savedCfg = getSavedDriveAuthConfig();

  // If Apps Script Bridge URL is already saved, use it immediately!
  if (savedCfg.appsScriptUrl) {
    return await connectWithAppsScriptBridge(savedCfg.appsScriptUrl, savedCfg.targetFolderId);
  }

  // If user configured a Refresh Token + Client Secret, auto-refresh seamlessly
  if (savedCfg.refreshToken && savedCfg.clientSecret) {
    try {
      return await connectWithDirectTokenOrRefresh(savedCfg);
    } catch {
      // Proceed to interactive sign-in if refresh fails
    }
  }

  if (savedCfg.customClientId) {
    return await signInWithGoogleGIS(savedCfg.customClientId);
  }

  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Gagal mendapatkan access token Google Drive dari Firebase Auth.');
    }

    cachedAccessToken = credential.accessToken;
    cachedTokenExpiryMs = Date.now() + 3500 * 1000;
    const mappedUser: GoogleDriveUser = {
      email: result.user.email,
      displayName: result.user.displayName,
      photoURL: result.user.photoURL,
      authMethod: 'firebase',
    };
    cachedUser = mappedUser;
    return { user: mappedUser, accessToken: cachedAccessToken };
  } catch (error: any) {
    const errCode = String(error?.code || '');
    const errMsg = String(error?.message || '');

    if (
      errCode === 'auth/unauthorized-domain' ||
      errCode === 'auth/operation-not-supported-in-this-environment' ||
      errCode === 'auth/invalid-api-key' ||
      errMsg.includes('unauthorized-domain')
    ) {
      try {
        return await signInWithGoogleGIS(firebaseConfig.oAuthClientId);
      } catch {
        const domainErr: any = new Error(
          `Domain "${window.location.hostname}" memblokir popup OAuth. Gunakan Tautan Cepat Google Drive (Tanpa Login OAuth) yang jauh lebih simpel.`
        );
        domainErr.code = 'VERCEL_DOMAIN_SETUP_REQUIRED';
        domainErr.hostname = window.location.hostname;
        domainErr.origin = window.location.origin;
        throw domainErr;
      }
    }

    if (errCode === 'auth/popup-blocked') {
      await signInWithRedirect(auth, provider);
      return null;
    }

    console.error('Google Sign-In error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  const savedCfg = getSavedDriveAuthConfig();

  if (savedCfg.appsScriptUrl) {
    return `BRIDGE::${savedCfg.appsScriptUrl}::${savedCfg.targetFolderId || ''}`;
  }

  if (cachedAccessToken && Date.now() < cachedTokenExpiryMs - 60000) {
    return cachedAccessToken;
  }

  if (savedCfg.refreshToken && savedCfg.clientSecret) {
    try {
      const refreshed = await refreshGoogleAccessToken(savedCfg);
      cachedAccessToken = refreshed.accessToken;
      cachedTokenExpiryMs = Date.now() + refreshed.expiresIn * 1000;
      return cachedAccessToken;
    } catch (err) {
      console.error('Auto-refresh Google token failed:', err);
    }
  }

  return cachedAccessToken;
};

export const logoutGoogle = async () => {
  try {
    await auth.signOut();
  } catch {
    // ignore
  }
  cachedAccessToken = null;
  cachedTokenExpiryMs = 0;
  cachedUser = null;
  const savedCfg = getSavedDriveAuthConfig();
  saveDriveAuthConfig({
    ...savedCfg,
    appsScriptUrl: '',
    directAccessToken: '',
    refreshToken: '',
    connectedEmail: undefined,
    connectedFolderUrl: undefined,
  });
};
