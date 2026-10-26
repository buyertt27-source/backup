import React, { useState, useEffect } from 'react';
import { ThemeMode } from '../types/pterodactyl';
import {
  GoogleDriveAuthConfig,
  GoogleDriveUser,
  getSavedDriveAuthConfig,
  saveDriveAuthConfig,
  getDefaultOAuthClientId,
  getDefaultFirebaseProjectId,
  signInWithGoogleGIS,
  connectWithDirectTokenOrRefresh,
} from '../services/googleDriveAuth';
import {
  X,
  Copy,
  Check,
  ExternalLink,
  KeyRound,
  ShieldCheck,
  Globe,
  CloudUpload,
  AlertCircle,
} from 'lucide-react';

interface GoogleDriveConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnected: (user: GoogleDriveUser, accessToken: string) => void;
  theme: ThemeMode;
  autoOpenedReason?: string | null;
}

export const GoogleDriveConfigModal: React.FC<GoogleDriveConfigModalProps> = ({
  isOpen,
  onClose,
  onConnected,
  theme,
  autoOpenedReason,
}) => {
  const [activeTab, setActiveTab] = useState<'instant_token' | 'custom_client' | 'firebase_domain'>(
    'instant_token'
  );
  const [customClientId, setCustomClientId] = useState<string>('');
  const [directAccessToken, setDirectAccessToken] = useState<string>('');
  const [refreshToken, setRefreshToken] = useState<string>('');
  const [clientSecret, setClientSecret] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const currentHostname = typeof window !== 'undefined' ? window.location.hostname : 'nama-app.vercel.app';
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://nama-app.vercel.app';
  const defaultProjectId = getDefaultFirebaseProjectId();
  const defaultClientId = getDefaultOAuthClientId();

  useEffect(() => {
    if (isOpen) {
      const saved = getSavedDriveAuthConfig();
      setCustomClientId(saved.customClientId || '');
      setDirectAccessToken(saved.directAccessToken || '');
      setRefreshToken(saved.refreshToken || '');
      setClientSecret(saved.clientSecret || '');
      setErrorMsg(autoOpenedReason || null);
    }
  }, [isOpen, autoOpenedReason]);

  if (!isOpen) return null;

  const isDark = theme === 'dark';

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedField(label);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleConnectDirectToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!directAccessToken.trim() && !(refreshToken.trim() && clientSecret.trim())) {
      setErrorMsg('Masukkan Access Token Google Drive (ya29...) atau pasangan Refresh Token + Client Secret.');
      return;
    }

    setIsSubmitting(true);
    try {
      const cfg: GoogleDriveAuthConfig = {
        customClientId: customClientId.trim(),
        directAccessToken: directAccessToken.trim(),
        refreshToken: refreshToken.trim(),
        clientSecret: clientSecret.trim(),
      };
      const result = await connectWithDirectTokenOrRefresh(cfg);
      onConnected(result.user, result.accessToken);
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal memverifikasi token Google Drive.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConnectGisPopup = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    const clientToUse = customClientId.trim() || defaultClientId;
    if (!clientToUse) {
      setErrorMsg('Masukkan Google OAuth Client ID terlebih dahulu.');
      return;
    }

    setIsSubmitting(true);
    try {
      saveDriveAuthConfig({
        ...getSavedDriveAuthConfig(),
        customClientId: customClientId.trim(),
      });
      const result = await signInWithGoogleGIS(clientToUse);
      onConnected(result.user, result.accessToken);
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal login dengan Google Identity Services (GIS).');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gdrive-vercel-modal-title"
    >
      <div
        className={`w-full max-w-2xl rounded-xl border p-5 sm:p-7 my-8 transition-colors ${
          isDark
            ? 'bg-[#121215] border-[#27272A] text-[#FAFAFA]'
            : 'bg-white border-slate-200 text-slate-900 shadow-2xl'
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-current/10">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-mono font-semibold mb-1">
              <CloudUpload className={`w-4 h-4 shrink-0 ${isDark ? 'text-red-400' : 'text-blue-600'}`} />
              <span className={isDark ? 'text-red-400' : 'text-blue-600'}>
                KONFIGURASI LOGIN GOOGLE DRIVE (SUPPORT VERCEL &amp; CUSTOM DOMAIN)
              </span>
            </div>
            <h2 id="gdrive-vercel-modal-title" className="text-lg sm:text-xl font-bold tracking-tight">
              Solusi Login Google Drive Saat Deploy di Vercel
            </h2>
            <p className={`text-xs mt-1 leading-relaxed ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
              Domain saat ini terdeteksi sebagai <code className="font-mono font-semibold">{currentHostname}</code>. Pilih salah satu dari 3 metode di bawah agar koneksi Google Drive langsung berfungsi di Vercel.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup modal konfigurasi Google Drive"
            className={`p-2 rounded-lg border transition-colors shrink-0 ${
              isDark
                ? 'border-[#27272A] text-zinc-400 hover:text-white hover:bg-zinc-800'
                : 'border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {errorMsg && (
          <div
            className={`mt-4 p-3.5 rounded-lg border text-xs flex items-start gap-2.5 ${
              isDark
                ? 'bg-red-950/40 border-red-500/60 text-red-200'
                : 'bg-red-50 border-red-300 text-red-900'
            }`}
          >
            <AlertCircle className="w-4 h-4 shrink-0 text-red-500 mt-0.5" />
            <div className="min-w-0 flex-1 break-words">{errorMsg}</div>
          </div>
        )}

        {/* Mode Switcher Tabs */}
        <div
          className={`grid grid-cols-1 sm:grid-cols-3 gap-1.5 p-1.5 mt-5 rounded-xl border ${
            isDark ? 'bg-[#09090B] border-[#242429]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <button
            type="button"
            onClick={() => setActiveTab('instant_token')}
            className={`px-3 py-2 text-xs font-semibold rounded-lg text-left sm:text-center transition-colors ${
              activeTab === 'instant_token'
                ? isDark
                  ? 'bg-red-600 text-white'
                  : 'bg-blue-600 text-white'
                : isDark
                ? 'text-zinc-400 hover:text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            1. Token Langsung (Tanpa Whitelist)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('custom_client')}
            className={`px-3 py-2 text-xs font-semibold rounded-lg text-left sm:text-center transition-colors ${
              activeTab === 'custom_client'
                ? isDark
                  ? 'bg-red-600 text-white'
                  : 'bg-blue-600 text-white'
                : isDark
                ? 'text-zinc-400 hover:text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            2. Google OAuth Client ID (GIS)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('firebase_domain')}
            className={`px-3 py-2 text-xs font-semibold rounded-lg text-left sm:text-center transition-colors ${
              activeTab === 'firebase_domain'
                ? isDark
                  ? 'bg-red-600 text-white'
                  : 'bg-blue-600 text-white'
                : isDark
                ? 'text-zinc-400 hover:text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            3. Whitelist Domain Vercel
          </button>
        </div>

        {/* TAB 1: INSTANT ACCESS TOKEN / REFRESH TOKEN (WORKS ON ANY VERCEL URL WITHOUT DOMAIN WHITELIST) */}
        {activeTab === 'instant_token' && (
          <form onSubmit={handleConnectDirectToken} className="mt-5 space-y-4">
            <div
              className={`p-3.5 rounded-lg border text-xs leading-relaxed ${
                isDark
                  ? 'bg-[#09090B] border-[#242429] text-zinc-300'
                  : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              <div className="font-semibold mb-1 flex items-center gap-1.5">
                <ShieldCheck className={`w-4 h-4 ${isDark ? 'text-red-400' : 'text-blue-600'}`} />
                Cara Tercepat di Vercel (Bebas Error Unauthorized Domain):
              </div>
              <ol className="list-decimal list-inside space-y-1 opacity-90">
                <li>
                  Buka{' '}
                  <a
                    href="https://developers.google.com/oauthplayground/?scope=https://www.googleapis.com/auth/drive.file"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`underline font-semibold inline-flex items-center gap-1 ${
                      isDark ? 'text-red-400 hover:text-red-300' : 'text-blue-600 hover:text-blue-700'
                    }`}
                  >
                    Google OAuth 2.0 Playground (Klik di Sini)
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </li>
                <li>
                  Klik tombol biru <strong>Authorize APIs</strong> lalu pilih akun Google Drive Anda.
                </li>
                <li>
                  Klik <strong>Exchange authorization code for tokens</strong>, lalu salin <strong>Access token</strong> (<code className="font-mono">ya29...</code>) ke kolom di bawah.
                </li>
              </ol>
            </div>

            <div>
              <label htmlFor="gdrive-direct-token" className="block text-xs font-semibold mb-1.5">
                Google Drive Access Token (<code className="font-mono">ya29.a0...</code>)
              </label>
              <input
                id="gdrive-direct-token"
                type="password"
                value={directAccessToken}
                onChange={(e) => setDirectAccessToken(e.target.value)}
                placeholder="Tempelkan Access Token (ya29.a0...) dari OAuth Playground"
                className={`w-full px-3.5 py-2.5 text-xs rounded-lg border font-mono transition-colors ${
                  isDark
                    ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                    : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                }`}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-current/10">
              <div>
                <label htmlFor="gdrive-refresh-token" className="block text-xs font-medium mb-1">
                  Refresh Token <span className="opacity-60">(Opsional - Auto-Renew 24/7)</span>
                </label>
                <input
                  id="gdrive-refresh-token"
                  type="password"
                  value={refreshToken}
                  onChange={(e) => setRefreshToken(e.target.value)}
                  placeholder="1//04..."
                  className={`w-full px-3 py-2 text-xs rounded-lg border font-mono ${
                    isDark
                      ? 'bg-[#09090B] border-[#27272A] text-zinc-100'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                />
              </div>
              <div>
                <label htmlFor="gdrive-client-secret" className="block text-xs font-medium mb-1">
                  Client Secret <span className="opacity-60">(Opsional jika pakai Refresh Token)</span>
                </label>
                <input
                  id="gdrive-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="GOCSPX-..."
                  className={`w-full px-3 py-2 text-xs rounded-lg border font-mono ${
                    isDark
                      ? 'bg-[#09090B] border-[#27272A] text-zinc-100'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-3">
              <button
                type="button"
                onClick={onClose}
                className={`px-4 py-2 text-xs font-medium rounded-lg border ${
                  isDark
                    ? 'border-[#27272A] text-zinc-300 hover:bg-zinc-800'
                    : 'border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className={`px-4 py-2 text-xs font-semibold text-white rounded-lg inline-flex items-center gap-2 transition-colors ${
                  isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" />
                {isSubmitting ? 'Memverifikasi Token...' : 'Verifikasi & Hubungkan Google Drive'}
              </button>
            </div>
          </form>
        )}

        {/* TAB 2: CUSTOM GOOGLE OAUTH CLIENT ID (GIS POPUP FOR VERCEL) */}
        {activeTab === 'custom_client' && (
          <form onSubmit={handleConnectGisPopup} className="mt-5 space-y-4">
            <div
              className={`p-3.5 rounded-lg border text-xs leading-relaxed ${
                isDark
                  ? 'bg-[#09090B] border-[#242429] text-zinc-300'
                  : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              <p className="font-semibold mb-1">
                Login Popup Langsung via Google Identity Services (Tanpa Firebase Auth):
              </p>
              <p className="opacity-90">
                Jika Anda membuat <strong>OAuth 2.0 Client ID (Web Application)</strong> di Google Cloud Console sendiri, tambahkan URL Vercel Anda di bagian <strong>Authorized JavaScript origins</strong> lalu tempelkan Client ID-nya di bawah.
              </p>
              <div className="mt-2.5 flex items-center justify-between gap-2 p-2 rounded border border-current/15 font-mono text-[11px]">
                <span className="truncate">Origin Vercel Anda: {currentOrigin}</span>
                <button
                  type="button"
                  onClick={() => handleCopy(currentOrigin, 'origin')}
                  className={`px-2 py-1 rounded text-[11px] font-sans font-semibold inline-flex items-center gap-1 shrink-0 ${
                    isDark ? 'bg-zinc-800 text-zinc-200' : 'bg-white border border-slate-200 text-slate-700'
                  }`}
                >
                  {copiedField === 'origin' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copiedField === 'origin' ? 'Tersalin' : 'Salin URL'}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="custom-google-client-id" className="block text-xs font-semibold mb-1.5">
                Google OAuth 2.0 Client ID (<code className="font-mono">*.apps.googleusercontent.com</code>)
              </label>
              <input
                id="custom-google-client-id"
                type="text"
                value={customClientId}
                onChange={(e) => setCustomClientId(e.target.value)}
                placeholder={defaultClientId || '1234567890-abcdefg.apps.googleusercontent.com'}
                className={`w-full px-3.5 py-2.5 text-xs rounded-lg border font-mono ${
                  isDark
                    ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                    : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                }`}
              />
              <p className={`text-[11px] mt-1 ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
                Kosongkan untuk mencoba menggunakan Client ID bawaan proyek ({defaultClientId.slice(0, 22)}...).
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-3">
              <button
                type="button"
                onClick={onClose}
                className={`px-4 py-2 text-xs font-medium rounded-lg border ${
                  isDark
                    ? 'border-[#27272A] text-zinc-300 hover:bg-zinc-800'
                    : 'border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className={`px-4 py-2 text-xs font-semibold text-white rounded-lg inline-flex items-center gap-2 transition-colors ${
                  isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                <Globe className="w-3.5 h-3.5" />
                {isSubmitting ? 'Membuka Popup Google...' : 'Simpan & Login Popup Google (GIS)'}
              </button>
            </div>
          </form>
        )}

        {/* TAB 3: WHITELIST VERCEL DOMAIN IN FIREBASE CONSOLE */}
        {activeTab === 'firebase_domain' && (
          <div className="mt-5 space-y-4 text-xs">
            <div
              className={`p-4 rounded-lg border leading-relaxed space-y-3 ${
                isDark
                  ? 'bg-[#09090B] border-[#242429] text-zinc-300'
                  : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              <p className="font-semibold">
                Mengapa tombol Sign in with Google menolak domain Vercel secara default?
              </p>
              <p className="opacity-90">
                Keamanan Firebase Authentication memblokir popup login dari domain baru (<code className="font-mono">auth/unauthorized-domain</code>) sampai domain Vercel Anda ditambahkan ke daftar <strong>Authorized domains</strong>.
              </p>

              <div className="p-2.5 rounded-lg border border-current/15 flex items-center justify-between gap-2 font-mono">
                <span className="truncate font-semibold">{currentHostname}</span>
                <button
                  type="button"
                  onClick={() => handleCopy(currentHostname, 'hostname')}
                  className={`px-2.5 py-1 rounded text-xs font-sans font-semibold inline-flex items-center gap-1 shrink-0 ${
                    isDark ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                  }`}
                >
                  {copiedField === 'hostname' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedField === 'hostname' ? 'Domain Tersalin!' : 'Salin Domain Vercel'}
                </button>
              </div>

              <ol className="list-decimal list-inside space-y-1.5 pt-1">
                <li>
                  Salin domain <code className="font-mono font-semibold">{currentHostname}</code> di atas.
                </li>
                <li>
                  Buka{' '}
                  <a
                    href={`https://console.firebase.google.com/project/${defaultProjectId}/authentication/settings`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`underline font-semibold inline-flex items-center gap-1 ${
                      isDark ? 'text-red-400' : 'text-blue-600'
                    }`}
                  >
                    Firebase Console &rarr; Authentication &rarr; Settings &rarr; Authorized domains
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </li>
                <li>
                  Klik <strong>Add domain</strong>, tempelkan <code className="font-mono">{currentHostname}</code>, lalu simpan.
                </li>
                <li>
                  Atau jika Anda tidak ingin mengatur Firebase Console, gunakan <strong>Tab 1 (Token Langsung)</strong> di atas yang langsung berjalan di Vercel tanpa whitelist domain.
                </li>
              </ol>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onClose}
                className={`px-4 py-2 text-xs font-semibold rounded-lg border ${
                  isDark
                    ? 'border-[#27272A] text-zinc-200 hover:bg-zinc-800'
                    : 'border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                Tutup
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
