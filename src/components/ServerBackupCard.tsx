import React from 'react';
import { PteroServer, PteroBackupFile, ThemeMode } from '../types/pterodactyl';
import { formatBytes } from '../utils/backupLogic';
import {
  HardDrive,
  Download,
  Lock,
  Unlock,
  Trash2,
  Archive,
  CheckSquare,
  Square,
  FolderArchive,
  CloudUpload,
  ExternalLink,
} from 'lucide-react';

interface ServerBackupCardProps {
  server: PteroServer;
  ordinalIndex: number;
  isSelected: boolean;
  isBackingUp: boolean;
  uploadingDriveIds: string[];
  saveToDriveEnabled: boolean;
  onToggleSelect: (serverId: string) => void;
  onBackupSingleServer: (serverId: string) => void;
  onDownloadBackup: (backup: PteroBackupFile) => void;
  onUploadBackupToDrive: (backup: PteroBackupFile, ordinalIndex: number) => void;
  onToggleLockBackup: (serverId: string, backupId: string) => void;
  onDeleteBackup: (serverId: string, backupId: string) => void;
  theme: ThemeMode;
}

export const ServerBackupCard: React.FC<ServerBackupCardProps> = ({
  server,
  ordinalIndex,
  isSelected,
  isBackingUp,
  uploadingDriveIds,
  saveToDriveEnabled,
  onToggleSelect,
  onBackupSingleServer,
  onDownloadBackup,
  onUploadBackupToDrive,
  onToggleLockBackup,
  onDeleteBackup,
  theme,
}) => {
  const isDark = theme === 'dark';
  const folderPath = `/vault/server-${ordinalIndex}-${server.identifier}/`;

  return (
    <article
      className={`w-full max-w-full overflow-hidden rounded-xl border transition-colors ${
        isDark
          ? isSelected
            ? 'bg-[#121215] border-red-500/80'
            : 'bg-[#121215] border-[#242429]'
          : isSelected
          ? 'bg-white border-blue-600'
          : 'bg-white border-slate-200'
      }`}
    >
      {/* Server Header */}
      <div className="p-4 sm:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-current/10 min-w-0">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onToggleSelect(server.id)}
            aria-label={`Pilih ${server.name} untuk aksi grup`}
            className={`mt-0.5 p-1 rounded transition-colors shrink-0 ${
              isDark
                ? isSelected
                  ? 'text-red-500'
                  : 'text-zinc-500 hover:text-zinc-300'
                : isSelected
                ? 'text-blue-600'
                : 'text-slate-400 hover:text-slate-700'
            }`}
          >
            {isSelected ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono mb-1">
              <span className={isDark ? 'text-red-400 font-semibold' : 'text-blue-600 font-semibold'}>
                SERVER #{ordinalIndex}
              </span>
              <span aria-hidden="true" className={isDark ? 'text-zinc-600' : 'text-slate-300'}>
                ·
              </span>
              <span className={isDark ? 'text-zinc-400' : 'text-slate-500'}>
                ID: {server.identifier}
              </span>
              <span aria-hidden="true" className={isDark ? 'text-zinc-600' : 'text-slate-300'}>
                ·
              </span>
              <span className={isDark ? 'text-zinc-400' : 'text-slate-500'}>
                Status: {server.status.toUpperCase()}
              </span>
              <span aria-hidden="true" className={isDark ? 'text-zinc-600' : 'text-slate-300'}>
                ·
              </span>
              <span className={`truncate max-w-[220px] ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                {server.allocation}
              </span>
            </div>

            <h3 className="text-base sm:text-lg font-bold tracking-tight break-words">{server.name}</h3>
            <p className={`text-xs mt-0.5 break-words ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
              {server.description}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between lg:justify-end gap-3 shrink-0">
          <div className={`text-left lg:text-right text-xs font-mono tabular-nums ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
            <div>
              Disk: {formatBytes(server.usage.diskUsedMb * 1024 * 1024)}
              {server.limits.diskMb > 0 ? ` / ${formatBytes(server.limits.diskMb * 1024 * 1024)}` : ''}
            </div>
            <div>
              Arsip: {server.backups.length} / {server.limits.backupLimit} file terpisah
            </div>
          </div>

          <button
            type="button"
            disabled={isBackingUp}
            onClick={() => onBackupSingleServer(server.id)}
            className={`px-3.5 py-2 text-xs font-semibold text-white rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
              isDark
                ? 'bg-red-600 hover:bg-red-500 disabled:bg-red-900/50'
                : 'bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300'
            }`}
          >
            <Archive className="w-3.5 h-3.5 shrink-0" />
            {isBackingUp
              ? 'Membuat Backup...'
              : `Backup Server ${ordinalIndex} (${saveToDriveEnabled ? 'Panel + Drive' : 'Satuan'})`}
          </button>
        </div>
      </div>

      {/* Isolated Backup Files Container */}
      <div className="p-4 sm:p-6 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium min-w-0">
            <FolderArchive className={`w-4 h-4 shrink-0 ${isDark ? 'text-red-400' : 'text-blue-600'}`} />
            <span>Direktori Arsip Terpisah Server {ordinalIndex}:</span>
            <code
              className={`font-mono px-2 py-0.5 rounded text-xs break-all ${
                isDark ? 'bg-[#09090B] text-zinc-300' : 'bg-slate-100 text-slate-800'
              }`}
            >
              {folderPath}
            </code>
          </div>
          <span className={`text-xs font-mono tabular-nums shrink-0 ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
            Total {server.backups.length} File Arsip
          </span>
        </div>

        {server.backups.length === 0 ? (
          <div
            className={`p-5 rounded-lg border text-center ${
              isDark ? 'bg-[#09090B] border-[#1F1F23] text-zinc-400' : 'bg-slate-50 border-slate-200 text-slate-600'
            }`}
          >
            <HardDrive className="w-6 h-6 mx-auto mb-2 opacity-60" />
            <p className="text-sm font-medium">Belum ada file backup untuk {server.name}</p>
            <p className="text-xs mt-1 mb-3 opacity-80">
              Klik tombol Backup Server {ordinalIndex} untuk mengeksekusi pembuatan arsip .tar.gz di Pterodactyl
              {saveToDriveEnabled ? ' dan menyimpannya ke Google Drive.' : '.'}
            </p>
            <button
              type="button"
              disabled={isBackingUp}
              onClick={() => onBackupSingleServer(server.id)}
              className={`px-3.5 py-1.5 text-xs font-semibold text-white rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              Buat Backup Server {ordinalIndex} Sekarang
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {server.backups.map((bkp) => {
              const isUploadingThis = uploadingDriveIds.includes(bkp.id);
              return (
                <div
                  key={bkp.id}
                  className={`p-3.5 rounded-lg border flex flex-col md:flex-row md:items-center justify-between gap-3 transition-colors min-w-0 ${
                    isDark
                      ? 'bg-[#09090B] border-[#1F1F23] hover:border-[#2E2E36]'
                      : 'bg-slate-50/70 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="font-mono text-xs font-semibold break-all">
                      {bkp.fileName}
                    </div>
                    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono tabular-nums ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                      <span>Ukuran: {formatBytes(bkp.sizeBytes)}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        Status:{' '}
                        {bkp.status === 'completed'
                          ? 'Selesai'
                          : bkp.status === 'in_progress'
                          ? 'Sedang Diproses Wings'
                          : 'Gagal'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {new Date(bkp.createdAt).toLocaleString('id-ID', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{bkp.isLocked ? 'Terkunci' : 'Tidak Dikunci'}</span>
                      {bkp.driveFileId && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className={isDark ? 'text-emerald-400 font-semibold' : 'text-emerald-700 font-semibold'}>
                            Tersimpan di Google Drive ({bkp.driveFolderName || 'PteroVault_Backups'})
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    {bkp.driveWebViewLink ? (
                      <a
                        href={bkp.driveWebViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`px-3 py-1.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                          isDark
                            ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300 hover:bg-emerald-950/50'
                            : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                        }`}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Buka di Drive
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled={isUploadingThis}
                        onClick={() => onUploadBackupToDrive(bkp, ordinalIndex)}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                          isDark
                            ? 'border-red-500/40 bg-red-950/25 text-red-300 hover:bg-red-950/40'
                            : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                        }`}
                      >
                        <CloudUpload className="w-3.5 h-3.5" />
                        {isUploadingThis ? 'Mengunggah...' : 'Simpan ke Drive'}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => onDownloadBackup(bkp)}
                      aria-label={`Unduh file ${bkp.fileName}`}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                        isDark
                          ? 'border-[#27272A] text-zinc-200 hover:bg-zinc-800'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Download className="w-3.5 h-3.5" />
                      Unduh (.tar.gz)
                    </button>

                    <button
                      type="button"
                      onClick={() => onToggleLockBackup(server.id, bkp.id)}
                      aria-label={
                        bkp.isLocked
                          ? `Buka kunci ${bkp.fileName}`
                          : `Kunci ${bkp.fileName} agar tidak terhapus`
                      }
                      className={`p-1.5 rounded-lg border transition-colors shrink-0 ${
                        bkp.isLocked
                          ? isDark
                            ? 'border-red-500/50 text-red-400 bg-red-950/30'
                            : 'border-blue-300 text-blue-600 bg-blue-50'
                          : isDark
                          ? 'border-[#27272A] text-zinc-400 hover:text-zinc-200'
                          : 'border-slate-200 bg-white text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {bkp.isLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                    </button>

                    <button
                      type="button"
                      disabled={bkp.isLocked}
                      onClick={() => onDeleteBackup(server.id, bkp.id)}
                      aria-label={`Hapus file ${bkp.fileName}`}
                      className={`p-1.5 rounded-lg border transition-colors shrink-0 ${
                        bkp.isLocked
                          ? 'opacity-30 cursor-not-allowed border-transparent'
                          : isDark
                          ? 'border-[#27272A] text-zinc-400 hover:text-red-400 hover:border-red-900/50'
                          : 'border-slate-200 bg-white text-slate-500 hover:text-red-600 hover:border-red-200'
                      }`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
};
