import React, { useState, useEffect } from 'react';
import { PteroCredentials, ThemeMode } from '../types/pterodactyl';
import { validateCredentials, normalizePanelDomain } from '../utils/backupLogic';
import { KeyRound, Globe, ShieldCheck, Eye, EyeOff, RefreshCw, Unplug, CheckCircle2, AlertCircle } from 'lucide-react';

interface ApiKeyConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  credentials: PteroCredentials;
  isConnected: boolean;
  onSaveCredentials: (creds: PteroCredentials, syncLive: boolean) => Promise<{ ok: boolean; message: string }>;
  onDisconnect: () => void;
  theme: ThemeMode;
}

export const ApiKeyConfigModal: React.FC<ApiKeyConfigModalProps> = ({
  isOpen,
  onClose,
  credentials,
  isConnected,
  onSaveCredentials,
  onDisconnect,
  theme,
}) => {
  const [domain, setDomain] = useState(credentials.domain);
  const [pltaKey, setPltaKey] = useState(credentials.pltaKey);
  const [pltsKey, setPltsKey] = useState(credentials.pltsKey);
  const [showPlta, setShowPlta] = useState(false);
  const [showPlts, setShowPlts] = useState(false);
  const [errors, setErrors] = useState<{ domain?: string; pltaKey?: string; pltsKey?: string }>({});
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setDomain(credentials.domain);
    setPltaKey(credentials.pltaKey);
    setPltsKey(credentials.pltsKey);
  }, [credentials, isOpen]);

  if (!isOpen) return null;

  const isDark = theme === 'dark';

  const handleConnectRealPanel = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);
    const validation = validateCredentials({ domain, pltaKey, pltsKey });
    if (!validation.valid) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setIsSubmitting(true);
    try {
      const normalized: PteroCredentials = {
        domain: normalizePanelDomain(domain),
        pltaKey: pltaKey.trim(),
        pltsKey: pltsKey.trim(),
      };
      const result = await onSaveCredentials(normalized, true);
      setStatusMessage({
        type: result.ok ? 'success' : 'error',
        text: result.message,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-api-config-title"
    >
      <div
        className={`w-full max-w-2xl rounded-xl border p-5 sm:p-7 transition-colors my-auto ${
          isDark
            ? 'bg-[#121215] border-[#26262B] text-[#FAFAFA]'
            : 'bg-white border-slate-200 text-slate-900 shadow-xl'
        }`}
      >
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-current/10">
          <div className="min-w-0">
            <p
              className={`text-xs font-medium mb-1 ${
                isDark ? 'text-red-400' : 'text-blue-600'
              }`}
            >
              Koneksi Real API Pterodactyl Panel
            </p>
            <h2 id="modal-api-config-title" className="text-lg sm:text-xl font-bold tracking-tight">
              Tautkan Domain, PLTA &amp; PLTS Panel Anda
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              isDark
                ? 'border-[#27272A] text-zinc-400 hover:text-white hover:bg-zinc-800'
                : 'border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            Tutup
          </button>
        </div>

        <form onSubmit={handleConnectRealPanel} className="mt-5 space-y-4">
          {/* Domain Input */}
          <div>
            <label
              htmlFor="ptero-domain-input"
              className="block text-sm font-medium mb-1.5"
            >
              Domain Panel Pterodactyl <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <Globe
                className={`w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 ${
                  isDark ? 'text-zinc-500' : 'text-slate-400'
                }`}
              />
              <input
                id="ptero-domain-input"
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="https://panel.domainanda.com"
                className={`w-full pl-10 pr-4 py-2.5 text-sm rounded-lg border font-mono transition-colors focus:outline-hidden ${
                  isDark
                    ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500 placeholder:text-zinc-600'
                    : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600 placeholder:text-slate-400'
                }`}
              />
            </div>
            {errors.domain ? (
              <p className="mt-1.5 text-xs text-red-500 font-medium">{errors.domain}</p>
            ) : (
              <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                Masukkan domain aktif panel Pterodactyl Anda (contoh: <code className="font-mono">panel.domainanda.com</code>).
              </p>
            )}
          </div>

          {/* PLTA Key Input */}
          <div>
            <label
              htmlFor="ptero-plta-input"
              className="block text-sm font-medium mb-1.5"
            >
              Application API Key (PLTA)
            </label>
            <div className="relative">
              <KeyRound
                className={`w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 ${
                  isDark ? 'text-zinc-500' : 'text-slate-400'
                }`}
              />
              <input
                id="ptero-plta-input"
                type={showPlta ? 'text' : 'password'}
                value={pltaKey}
                onChange={(e) => setPltaKey(e.target.value)}
                placeholder="ptla_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className={`w-full pl-10 pr-12 py-2.5 text-sm rounded-lg border font-mono transition-colors focus:outline-hidden ${
                  isDark
                    ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500 placeholder:text-zinc-600'
                    : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600 placeholder:text-slate-400'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowPlta(!showPlta)}
                aria-label={showPlta ? 'Sembunyikan PLTA Key' : 'Tampilkan PLTA Key'}
                className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded text-xs ${
                  isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {showPlta ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {errors.pltaKey ? (
              <p className="mt-1.5 text-xs text-red-500 font-medium">{errors.pltaKey}</p>
            ) : (
              <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                Membaca daftar seluruh server di panel (<code className="font-mono">GET /api/application/servers</code>) dengan izin Read Servers.
              </p>
            )}
          </div>

          {/* PLTS / PLTC Key Input */}
          <div>
            <label
              htmlFor="ptero-plts-input"
              className="block text-sm font-medium mb-1.5"
            >
              Client / Account API Key (PLTS / PLTC) <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <ShieldCheck
                className={`w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 ${
                  isDark ? 'text-zinc-500' : 'text-slate-400'
                }`}
              />
              <input
                id="ptero-plts-input"
                type={showPlts ? 'text' : 'password'}
                value={pltsKey}
                onChange={(e) => setPltsKey(e.target.value)}
                placeholder="ptlc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className={`w-full pl-10 pr-12 py-2.5 text-sm rounded-lg border font-mono transition-colors focus:outline-hidden ${
                  isDark
                    ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500 placeholder:text-zinc-600'
                    : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600 placeholder:text-slate-400'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowPlts(!showPlts)}
                aria-label={showPlts ? 'Sembunyikan PLTS Key' : 'Tampilkan PLTS Key'}
                className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded text-xs ${
                  isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {showPlts ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {errors.pltsKey ? (
              <p className="mt-1.5 text-xs text-red-500 font-medium">{errors.pltsKey}</p>
            ) : (
              <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                Digunakan untuk mengeksekusi pembuatan backup, download signed URL, lock, &amp; hapus backup per server (<code className="font-mono">/api/client/servers/:id/backups</code>).
              </p>
            )}
          </div>

          {statusMessage && (
            <div
              className={`p-3.5 rounded-lg border text-xs flex items-start gap-2.5 break-words ${
                statusMessage.type === 'success'
                  ? isDark
                    ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : statusMessage.type === 'error'
                  ? isDark
                    ? 'bg-red-950/40 border-red-800/60 text-red-300'
                    : 'bg-red-50 border-red-200 text-red-800'
                  : isDark
                  ? 'bg-zinc-900 border-zinc-700 text-zinc-300'
                  : 'bg-blue-50 border-blue-200 text-blue-800'
              }`}
            >
              {statusMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span className="min-w-0 flex-1">{statusMessage.text}</span>
            </div>
          )}

          <div className="pt-3 flex flex-wrap items-center justify-between gap-3 border-t border-current/10">
            <div>
              {isConnected && (
                <button
                  type="button"
                  onClick={() => {
                    onDisconnect();
                    setDomain('');
                    setPltaKey('');
                    setPltsKey('');
                    setStatusMessage({
                      type: 'info',
                      text: 'Kredensial dilepas dan daftar server dibersihkan.',
                    });
                  }}
                  className={`px-3 py-2 text-xs font-medium rounded-lg border flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                    isDark
                      ? 'border-red-900/60 text-red-400 hover:bg-red-950/40'
                      : 'border-red-200 text-red-600 hover:bg-red-50'
                  }`}
                >
                  <Unplug className="w-3.5 h-3.5" />
                  Putuskan Koneksi Panel
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="submit"
                disabled={isSubmitting}
                className={`px-4 py-2.5 text-xs font-semibold text-white rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                  isDark
                    ? 'bg-red-600 hover:bg-red-500 disabled:bg-red-900/50'
                    : 'bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300'
                }`}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSubmitting ? 'animate-spin' : ''}`} />
                {isSubmitting ? 'Menghubungkan ke Panel...' : 'Hubungkan & Muat Server Real'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
