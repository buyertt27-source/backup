import React, { useState, useEffect } from 'react';
import { ThemeMode } from '../types/pterodactyl';
import {
  GoogleDriveAuthConfig,
  GoogleDriveUser,
  getSavedDriveAuthConfig,
  connectWithAppsScriptBridge,
  connectWithDirectTokenOrRefresh,
} from '../services/googleDriveAuth';
import { buildGoogleAppsScriptCode } from '../utils/backupLogic';
import {
  X,
  Copy,
  Check,
  ExternalLink,
  CloudUpload,
  AlertCircle,
  Sparkles,
  FolderOpen,
  Link2,
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
  const [activeTab, setActiveTab] = useState<'simple_bridge' | 'direct_token'>('simple_bridge');
  const [appsScriptUrl, setAppsScriptUrl] = useState<string>('');
  const [targetFolderUrl, setTargetFolderUrl] = useState<string>('');
  const [directAccessToken, setDirectAccessToken] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedScript, setCopiedScript] = useState<boolean>(false);
  const [showScriptPreview, setShowScriptPreview] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      const saved = getSavedDriveAuthConfig();
      setAppsScriptUrl(saved.appsScriptUrl || '');
      setTargetFolderUrl(saved.targetFolderId || '');
      setDirectAccessToken(saved.directAccessToken || '');
      setErrorMsg(autoOpenedReason || null);
    }
  }, [isOpen, autoOpenedReason]);

  if (!isOpen) return null;

  const isDark = theme === 'dark';
  const generatedScriptCode = buildGoogleAppsScriptCode(targetFolderUrl);

  const handleCopyScript = () => {
    navigator.clipboard?.writeText(generatedScriptCode).catch(() => {});
    setCopiedScript(true);
    setTimeout(() => setCopiedScript(false), 3000);
  };

  const handleConnectBridge = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!appsScriptUrl.trim()) {
      setErrorMsg('Tempelkan URL Web App Google Script (https://script.google.com/macros/s/.../exec) terlebih dahulu.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await connectWithAppsScriptBridge(appsScriptUrl, targetFolderUrl);
      onConnected(result.user, result.accessToken);
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal menghubungkan URL Google Drive Bridge.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConnectDirectToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!directAccessToken.trim()) {
      setErrorMsg('Tempelkan Access Token Google Drive (ya29...) terlebih dahulu.');
      return;
    }

    setIsSubmitting(true);
    try {
      const cfg: GoogleDriveAuthConfig = {
        ...getSavedDriveAuthConfig(),
        directAccessToken: directAccessToken.trim(),
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
              <Sparkles className={`w-4 h-4 shrink-0 ${isDark ? 'text-red-400' : 'text-blue-600'}`} />
              <span className={isDark ? 'text-red-400' : 'text-blue-600'}>
                PENAUTAN CEPAT GOOGLE DRIVE (ANTI-RIBET &amp; SUPPORT VERCEL 100%)
              </span>
            </div>
            <h2 id="gdrive-vercel-modal-title" className="text-lg sm:text-xl font-bold tracking-tight">
              Tautkan Folder Google Drive Tanpa Login OAuth
            </h2>
            <p className={`text-xs mt-1 leading-relaxed ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
              Cara paling simpel dan permanen untuk menyimpan backup ke Google Drive Anda (termasuk Auto-Update) tanpa perlu setting Firebase / Cloud Console saat di-deploy ke Vercel.
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
          className={`grid grid-cols-1 sm:grid-cols-2 gap-1.5 p-1.5 mt-5 rounded-xl border ${
            isDark ? 'bg-[#09090B] border-[#242429]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <button
            type="button"
            onClick={() => setActiveTab('simple_bridge')}
            className={`px-3 py-2 text-xs font-semibold rounded-lg text-center transition-colors ${
              activeTab === 'simple_bridge'
                ? isDark
                  ? 'bg-red-600 text-white'
                  : 'bg-blue-600 text-white'
                : isDark
                ? 'text-zinc-400 hover:text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Cara Paling Mudah: Link Google Script (Permanen Selamanya)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('direct_token')}
            className={`px-3 py-2 text-xs font-semibold rounded-lg text-center transition-colors ${
              activeTab === 'direct_token'
                ? isDark
                  ? 'bg-red-600 text-white'
                  : 'bg-blue-600 text-white'
                : isDark
                ? 'text-zinc-400 hover:text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Alternatif: Tempel Access Token (OAuth Playground)
          </button>
        </div>

        {/* TAB 1: SUPER SIMPLE 1-LINK GOOGLE DRIVE BRIDGE */}
        {activeTab === 'simple_bridge' && (
          <form onSubmit={handleConnectBridge} className="mt-5 space-y-4">
            {/* Step 1: Optional Folder Link */}
            <div>
              <label htmlFor="gdrive-folder-link" className="block text-xs font-semibold mb-1.5">
                1. Link Folder Google Drive Tujuan <span className="font-normal opacity-70">(Opsional — Kosongkan agar otomatis membuat folder PteroVault_Backups)</span>
              </label>
              <div className="relative">
                <FolderOpen
                  className={`w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 ${
                    isDark ? 'text-zinc-500' : 'text-slate-400'
                  }`}
                />
                <input
                  id="gdrive-folder-link"
                  type="text"
                  value={targetFolderUrl}
                  onChange={(e) => setTargetFolderUrl(e.target.value)}
                  placeholder="Contoh: https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRs..."
                  className={`w-full pl-10 pr-3.5 py-2.5 text-xs rounded-lg border font-mono transition-colors ${
                    isDark
                      ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                      : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                  }`}
                />
              </div>
            </div>

            {/* Step 2: 1-Click Copy Script & Open script.google.com */}
            <div
              className={`p-4 rounded-xl border space-y-3 ${
                isDark
                  ? 'bg-[#09090B] border-[#242429] text-zinc-300'
                  : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div className="text-xs font-semibold">
                  2. Salin Kode Jembatan Google Drive (Hanya 1x Seumur Hidup):
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyScript}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold text-white inline-flex items-center gap-1.5 transition-colors ${
                      copiedScript
                        ? 'bg-emerald-600'
                        : isDark
                        ? 'bg-red-600 hover:bg-red-500'
                        : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    {copiedScript ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedScript ? 'Kode Berhasil Disalin!' : 'Salin Kode Otomatis (1-Klik)'}
                  </button>
                  <a
                    href="https://script.google.com/home/start"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`px-3 py-1.5 rounded-lg border text-xs font-semibold inline-flex items-center gap-1.5 transition-colors ${
                      isDark
                        ? 'border-[#27272A] bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
                        : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
                    }`}
                  >
                    Buka script.google.com
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              <ol className="list-decimal list-inside text-xs space-y-1 opacity-90 leading-relaxed">
                <li>
                  Klik <strong>Salin Kode Otomatis</strong> di atas, lalu buka <strong>script.google.com</strong> dan klik <strong>New Project (Proyek Baru)</strong>.
                </li>
                <li>
                  Hapus isi awal lalu <strong>Paste (Ctrl+V)</strong> kode tadi.
                </li>
                <li>
                  Klik tombol biru <strong>Deploy &rarr; New deployment</strong>, pilih jenis <strong>Web app</strong>, ubah <em>Who has access</em> menjadi <strong>Anyone (Siapa saja)</strong>, lalu klik <strong>Deploy</strong>.
                </li>
                <li>
                  Salin <strong>Web App URL</strong> (<code className="font-mono">https://script.google.com/macros/s/.../exec</code>) dan tempel di kolom nomor 3 di bawah!
                </li>
              </ol>

              <div>
                <button
                  type="button"
                  onClick={() => setShowScriptPreview(!showScriptPreview)}
                  className="text-[11px] underline opacity-75 hover:opacity-100"
                >
                  {showScriptPreview ? 'Sembunyikan Isi Kode Script' : 'Lihat Isi Kode Script (25 Baris)'}
                </button>
                {showScriptPreview && (
                  <pre
                    className={`mt-2 p-3 rounded-lg border text-[11px] font-mono overflow-x-auto max-h-44 ${
                      isDark ? 'bg-[#121215] border-[#27272A] text-zinc-300' : 'bg-white border-slate-200 text-slate-800'
                    }`}
                  >
                    {generatedScriptCode}
                  </pre>
                )}
              </div>
            </div>

            {/* Step 3: Paste Web App URL */}
            <div>
              <label htmlFor="gdrive-script-url" className="block text-xs font-semibold mb-1.5">
                3. Tempel Web App URL Google Script Anda (<code className="font-mono">https://script.google.com/macros/s/.../exec</code>)
              </label>
              <div className="relative">
                <Link2
                  className={`w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 ${
                    isDark ? 'text-zinc-500' : 'text-slate-400'
                  }`}
                />
                <input
                  id="gdrive-script-url"
                  type="url"
                  value={appsScriptUrl}
                  onChange={(e) => setAppsScriptUrl(e.target.value)}
                  placeholder="https://script.google.com/macros/s/AKfycb.../exec"
                  className={`w-full pl-10 pr-3.5 py-2.5 text-xs rounded-lg border font-mono transition-colors ${
                    isDark
                      ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                      : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                  }`}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
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
                className={`px-5 py-2.5 text-xs font-semibold text-white rounded-lg inline-flex items-center gap-2 transition-colors ${
                  isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                <CloudUpload className="w-4 h-4" />
                {isSubmitting ? 'Menghubungkan ke Google Drive...' : 'Hubungkan Google Drive Permanen'}
              </button>
            </div>
          </form>
        )}

        {/* TAB 2: DIRECT OAUTH PLAYGROUND TOKEN */}
        {activeTab === 'direct_token' && (
          <form onSubmit={handleConnectDirectToken} className="mt-5 space-y-4">
            <div
              className={`p-3.5 rounded-lg border text-xs leading-relaxed ${
                isDark
                  ? 'bg-[#09090B] border-[#242429] text-zinc-300'
                  : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              <ol className="list-decimal list-inside space-y-1">
                <li>
                  Buka{' '}
                  <a
                    href="https://developers.google.com/oauthplayground/?scope=https://www.googleapis.com/auth/drive.file"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`underline font-semibold inline-flex items-center gap-1 ${
                      isDark ? 'text-red-400' : 'text-blue-600'
                    }`}
                  >
                    Google OAuth Playground (Klik di Sini)
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </li>
                <li>
                  Klik <strong>Authorize APIs</strong> &rarr; <strong>Exchange authorization code for tokens</strong>.
                </li>
                <li>
                  Salin <strong>Access token</strong> (<code className="font-mono">ya29...</code>) dan tempel di bawah.
                </li>
              </ol>
            </div>

            <div>
              <label htmlFor="gdrive-direct-token" className="block text-xs font-semibold mb-1.5">
                Access Token Google Drive (<code className="font-mono">ya29.a0...</code>)
              </label>
              <input
                id="gdrive-direct-token"
                type="password"
                value={directAccessToken}
                onChange={(e) => setDirectAccessToken(e.target.value)}
                placeholder="ya29.a0..."
                className={`w-full px-3.5 py-2.5 text-xs rounded-lg border font-mono ${
                  isDark
                    ? 'bg-[#09090B] border-[#27272A] text-zinc-100'
                    : 'bg-slate-50 border-slate-300 text-slate-900'
                }`}
              />
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
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
                className={`px-5 py-2.5 text-xs font-semibold text-white rounded-lg inline-flex items-center gap-2 ${
                  isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                <CloudUpload className="w-4 h-4" />
                {isSubmitting ? 'Memverifikasi...' : 'Hubungkan dengan Token'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
