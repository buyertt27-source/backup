import React, { useState, useEffect } from 'react';
import {
  AutoBackupSchedule,
  AutoDeleteStrategy,
  PteroServer,
  ScheduleFrequency,
  ThemeMode,
} from '../types/pterodactyl';
import { calculateNextScheduleRun } from '../utils/backupLogic';
import { Clock, CalendarCheck, Play, Save, CheckSquare, Square, CloudUpload, Trash2 } from 'lucide-react';

interface AutoBackupSchedulerPanelProps {
  schedule: AutoBackupSchedule;
  servers: PteroServer[];
  isDriveConnected: boolean;
  onRequestGoogleSignIn: () => void;
  onUpdateSchedule: (updated: AutoBackupSchedule) => void;
  onTriggerScheduledRunNow: () => void;
  theme: ThemeMode;
}

const DAYS_OF_WEEK = [
  { value: 0, label: 'Minggu' },
  { value: 1, label: 'Senin' },
  { value: 2, label: 'Selasa' },
  { value: 3, label: 'Rabu' },
  { value: 4, label: 'Kamis' },
  { value: 5, label: 'Jumat' },
  { value: 6, label: 'Sabtu' },
];

export const AutoBackupSchedulerPanel: React.FC<AutoBackupSchedulerPanelProps> = ({
  schedule,
  servers,
  isDriveConnected,
  onRequestGoogleSignIn,
  onUpdateSchedule,
  onTriggerScheduledRunNow,
  theme,
}) => {
  const [enabled, setEnabled] = useState<boolean>(schedule.enabled);
  const [frequency, setFrequency] = useState<ScheduleFrequency>(schedule.frequency);
  const [intervalHours, setIntervalHours] = useState<number>(schedule.intervalHours);
  const [timeOfDay, setTimeOfDay] = useState<string>(schedule.timeOfDay);
  const [dayOfWeek, setDayOfWeek] = useState<number>(schedule.dayOfWeek);
  const [targetScope, setTargetScope] = useState<'all' | 'selected'>(schedule.targetScope);
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>(schedule.selectedServerIds);
  const [retentionCount, setRetentionCount] = useState<number>(schedule.retentionCount || 1);
  const [autoDeletePrevious, setAutoDeletePrevious] = useState<boolean>(
    schedule.autoDeletePrevious ?? true
  );
  const [autoDeleteStrategy, setAutoDeleteStrategy] = useState<AutoDeleteStrategy>(
    schedule.autoDeleteStrategy || 'delete_all_previous'
  );
  const [lockNewBackups, setLockNewBackups] = useState<boolean>(schedule.lockNewBackups);
  const [saveToGoogleDrive, setSaveToGoogleDrive] = useState<boolean>(Boolean(schedule.saveToGoogleDrive));
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(schedule.enabled);
    setFrequency(schedule.frequency);
    setIntervalHours(schedule.intervalHours);
    setTimeOfDay(schedule.timeOfDay);
    setDayOfWeek(schedule.dayOfWeek);
    setTargetScope(schedule.targetScope);
    setSelectedServerIds(schedule.selectedServerIds);
    setRetentionCount(schedule.retentionCount || 1);
    setAutoDeletePrevious(schedule.autoDeletePrevious ?? true);
    setAutoDeleteStrategy(schedule.autoDeleteStrategy || 'delete_all_previous');
    setLockNewBackups(schedule.lockNewBackups);
    setSaveToGoogleDrive(Boolean(schedule.saveToGoogleDrive));
  }, [schedule]);

  const isDark = theme === 'dark';

  const handleToggleServerInSchedule = (srvId: string) => {
    setSelectedServerIds((prev) =>
      prev.includes(srvId) ? prev.filter((id) => id !== srvId) : [...prev, srvId]
    );
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const effectiveSelected =
      targetScope === 'all'
        ? servers.map((s) => s.id)
        : selectedServerIds.length > 0
        ? selectedServerIds
        : [servers[0]?.id].filter(Boolean);

    const nextRunAt = calculateNextScheduleRun({
      frequency,
      intervalHours,
      timeOfDay,
      dayOfWeek,
    });

    const nextSchedule: AutoBackupSchedule = {
      enabled,
      frequency,
      intervalHours,
      timeOfDay,
      dayOfWeek,
      targetScope,
      selectedServerIds: effectiveSelected,
      retentionCount: autoDeleteStrategy === 'delete_all_previous' ? 1 : retentionCount,
      autoDeletePrevious,
      autoDeleteStrategy,
      lockNewBackups,
      saveToGoogleDrive,
      lastRunAt: schedule.lastRunAt,
      nextRunAt,
    };

    onUpdateSchedule(nextSchedule);
    setSaveFeedback(
      `Jadwal Auto-Update berhasil disimpan (${
        autoDeletePrevious
          ? autoDeleteStrategy === 'delete_all_previous'
            ? 'Otomatis hapus semua backup sebelumnya di Pterodactyl'
            : `Otomatis hapus backup lama di atas ${retentionCount} file`
          : 'Tanpa hapus otomatis'
      } · ${
        saveToGoogleDrive ? 'Simpan ke Google Drive + Panel' : 'Simpan di Panel Pterodactyl'
      }). Eksekusi berikutnya: ${new Date(nextRunAt).toLocaleString('id-ID')}`
    );
    setTimeout(() => setSaveFeedback(null), 5000);
  };

  return (
    <section
      aria-labelledby="scheduler-heading"
      className={`w-full rounded-xl border p-4 sm:p-8 transition-colors min-w-0 ${
        isDark ? 'bg-[#121215] border-[#242429]' : 'bg-white border-slate-200'
      }`}
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-current/10">
        <div className="min-w-0">
          <p className={`text-xs font-medium mb-1 ${isDark ? 'text-red-400' : 'text-blue-600'}`}>
            Otomatisasi Pencadangan Terjadwal &amp; Google Drive
          </p>
          <h2 id="scheduler-heading" className="text-lg sm:text-xl font-bold tracking-tight">
            Konfigurasi Auto-Update Backup &amp; Penyimpanan Google Drive
          </h2>
          <p className={`text-xs mt-1 ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
            Tentukan waktu eksekusi otomatis dan pilih apakah hasil backup otomatis juga langsung disimpan ke folder terpisah di Google Drive Anda.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            role="switch"
            aria-checked={enabled}
            className={`px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
              enabled
                ? isDark
                  ? 'bg-red-600/20 border-red-500 text-red-300'
                  : 'bg-blue-50 border-blue-600 text-blue-700'
                : isDark
                ? 'bg-zinc-900 border-zinc-700 text-zinc-400'
                : 'bg-slate-100 border-slate-300 text-slate-600'
            }`}
          >
            Status Auto-Update: {enabled ? 'Aktif' : 'Nonaktif'}
          </button>

          <button
            type="button"
            onClick={onTriggerScheduledRunNow}
            className={`px-3.5 py-2 text-xs font-semibold rounded-lg border flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              isDark
                ? 'border-[#27272A] bg-zinc-900 text-zinc-100 hover:bg-zinc-800'
                : 'border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100'
            }`}
          >
            <Play className="w-3.5 h-3.5" />
            Jalankan Siklus Auto-Update Sekarang
          </button>
        </div>
      </div>

      <form onSubmit={handleSave} className="mt-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Frequency Mode */}
          <div>
            <label htmlFor="schedule-frequency" className="block text-sm font-medium mb-2">
              Mode Frekuensi Waktu
            </label>
            <select
              id="schedule-frequency"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)}
              className={`w-full px-3.5 py-2.5 text-sm rounded-lg border transition-colors ${
                isDark
                  ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                  : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
              }`}
            >
              <option value="interval_hours">Interval Jam (Setiap X Jam)</option>
              <option value="daily">Harian pada Jam Tertentu</option>
              <option value="weekly">Mingguan pada Hari &amp; Jam Tertentu</option>
            </select>
          </div>

          {/* Conditional Time Picker */}
          {frequency === 'interval_hours' ? (
            <div>
              <label htmlFor="schedule-interval-hours" className="block text-sm font-medium mb-2">
                Rentang Interval (Jam)
              </label>
              <select
                id="schedule-interval-hours"
                value={intervalHours}
                onChange={(e) => setIntervalHours(Number(e.target.value))}
                className={`w-full px-3.5 py-2.5 text-sm rounded-lg border font-mono tabular-nums transition-colors ${
                  isDark
                    ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                    : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                }`}
              >
                <option value={1}>Setiap 1 Jam</option>
                <option value={3}>Setiap 3 Jam</option>
                <option value={6}>Setiap 6 Jam</option>
                <option value={12}>Setiap 12 Jam</option>
                <option value={24}>Setiap 24 Jam</option>
              </select>
            </div>
          ) : (
            <div>
              <label htmlFor="schedule-time-of-day" className="block text-sm font-medium mb-2">
                Waktu Eksekusi (WIB / 24 Jam)
              </label>
              <div className="relative">
                <Clock
                  className={`w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 ${
                    isDark ? 'text-zinc-500' : 'text-slate-400'
                  }`}
                />
                <input
                  id="schedule-time-of-day"
                  type="time"
                  value={timeOfDay}
                  onChange={(e) => setTimeOfDay(e.target.value)}
                  className={`w-full pl-10 pr-3.5 py-2.5 text-sm rounded-lg border font-mono tabular-nums transition-colors ${
                    isDark
                      ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                      : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                  }`}
                />
              </div>
            </div>
          )}

          {/* Day of week or Retention Limit */}
          {frequency === 'weekly' ? (
            <div>
              <label htmlFor="schedule-day-of-week" className="block text-sm font-medium mb-2">
                Hari Eksekusi Mingguan
              </label>
              <select
                id="schedule-day-of-week"
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(Number(e.target.value))}
                className={`w-full px-3.5 py-2.5 text-sm rounded-lg border transition-colors ${
                  isDark
                    ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                    : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                }`}
              >
                {DAYS_OF_WEEK.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label htmlFor="schedule-retention" className="block text-sm font-medium mb-2">
                Batas Retensi Arsip per Server di Panel
              </label>
              <select
                id="schedule-retention"
                value={autoDeleteStrategy === 'delete_all_previous' ? 1 : retentionCount}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setRetentionCount(val);
                  if (val === 1) {
                    setAutoDeleteStrategy('delete_all_previous');
                  } else {
                    setAutoDeleteStrategy('keep_retention_count');
                  }
                }}
                className={`w-full px-3.5 py-2.5 text-sm rounded-lg border font-mono tabular-nums transition-colors ${
                  isDark
                    ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                    : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                }`}
              >
                <option value={1}>Simpan 1 File Terbaru Saja (Hapus Semua Sebelumnya)</option>
                <option value={2}>Simpan Maksimal 2 File Terbaru</option>
                <option value={3}>Simpan Maksimal 3 File Terbaru</option>
                <option value={5}>Simpan Maksimal 5 File Terbaru</option>
                <option value={8}>Simpan Maksimal 8 File Terbaru</option>
                <option value={10}>Simpan Maksimal 10 File Terbaru</option>
              </select>
            </div>
          )}
        </div>

        {/* Auto-Delete Previous Backups Card (Prevents Pterodactyl Backup Slot Fullness) */}
        <div
          className={`p-4 rounded-xl border transition-colors ${
            autoDeletePrevious
              ? isDark
                ? 'bg-red-950/20 border-red-500/60'
                : 'bg-blue-50/70 border-blue-500'
              : isDark
              ? 'bg-[#09090B] border-[#242429]'
              : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <Trash2
                className={`w-5 h-5 mt-0.5 shrink-0 ${
                  isDark ? 'text-red-400' : 'text-blue-600'
                }`}
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  Hapus Otomatis File Backup Sebelumnya (Antisipasi Kepenuhan Backup Pterodactyl)
                </div>
                <p className={`text-xs mt-0.5 leading-relaxed ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                  Saat Auto-Backup berjalan, sistem otomatis menghapus file backup lama yang tidak dikunci pada server Pterodactyl (termasuk mengosongkan slot terlebih dahulu jika limit backup panel sudah penuh) sehingga proses backup baru tidak pernah gagal karena kuota penuh.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <div
                className={`inline-flex p-1 rounded-lg border ${
                  isDark ? 'bg-[#121215] border-[#27272A]' : 'bg-white border-slate-200'
                }`}
                role="group"
                aria-label="Status Hapus Otomatis Backup Sebelumnya"
              >
                <button
                  type="button"
                  onClick={() => setAutoDeletePrevious(true)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    autoDeletePrevious
                      ? isDark
                        ? 'bg-red-600 text-white'
                        : 'bg-blue-600 text-white'
                      : isDark
                      ? 'text-zinc-400 hover:text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Aktif: Hapus Backup Sebelumnya
                </button>
                <button
                  type="button"
                  onClick={() => setAutoDeletePrevious(false)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    !autoDeletePrevious
                      ? isDark
                        ? 'bg-red-600 text-white'
                        : 'bg-blue-600 text-white'
                      : isDark
                      ? 'text-zinc-400 hover:text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Nonaktif (Biarkan Menumpuk)
                </button>
              </div>
            </div>
          </div>

          {autoDeletePrevious && (
            <div className="mt-3.5 pt-3.5 border-t border-current/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <span className={`text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-slate-700'}`}>
                Mode Pembersihan File Backup Lama di Panel Pterodactyl:
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAutoDeleteStrategy('delete_all_previous');
                    setRetentionCount(1);
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                    autoDeleteStrategy === 'delete_all_previous'
                      ? isDark
                        ? 'bg-red-600 border-red-500 text-white'
                        : 'bg-blue-600 border-blue-600 text-white'
                      : isDark
                      ? 'border-[#27272A] bg-[#121215] text-zinc-400 hover:text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Hapus Semua Backup Sebelumnya (Sisakan 1 Terbaru)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAutoDeleteStrategy('keep_retention_count');
                    if (retentionCount <= 1) setRetentionCount(3);
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                    autoDeleteStrategy === 'keep_retention_count'
                      ? isDark
                        ? 'bg-red-600 border-red-500 text-white'
                        : 'bg-blue-600 border-blue-600 text-white'
                      : isDark
                      ? 'border-[#27272A] bg-[#121215] text-zinc-400 hover:text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Hapus Backup Terlama (Sesuai Batas Retensi)
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Google Drive Auto-Upload Choice for Scheduled Backups */}
        <div
          className={`p-4 rounded-xl border transition-colors ${
            saveToGoogleDrive
              ? isDark
                ? 'bg-red-950/20 border-red-500/60'
                : 'bg-blue-50/70 border-blue-500'
              : isDark
              ? 'bg-[#09090B] border-[#242429]'
              : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <CloudUpload
                className={`w-5 h-5 mt-0.5 shrink-0 ${
                  isDark ? 'text-red-400' : 'text-blue-600'
                }`}
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  Pilihan Penyimpanan Google Drive untuk Backup Otomatis (Auto-Update)
                </div>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                  Jika diaktifkan, setiap kali jadwal Auto-Update berjalan, file backup tiap server akan otomatis diunggah ke folder terpisah (<code className="font-mono">PteroVault_Backups/Server_01_...</code>) di Google Drive Anda.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <div
                className={`inline-flex p-1 rounded-lg border ${
                  isDark ? 'bg-[#121215] border-[#27272A]' : 'bg-white border-slate-200'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSaveToGoogleDrive(false)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    !saveToGoogleDrive
                      ? isDark
                        ? 'bg-red-600 text-white'
                        : 'bg-blue-600 text-white'
                      : isDark
                      ? 'text-zinc-400 hover:text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Hanya Panel (Tanpa Drive)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSaveToGoogleDrive(true);
                    if (!isDriveConnected) {
                      onRequestGoogleSignIn();
                    }
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    saveToGoogleDrive
                      ? isDark
                        ? 'bg-red-600 text-white'
                        : 'bg-blue-600 text-white'
                      : isDark
                      ? 'text-zinc-400 hover:text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Simpan Otomatis ke Google Drive
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Target Server Scope */}
        <div className="pt-4 border-t border-current/10">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Cakupan Target Server pada Saat Auto-Update</h3>
              <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                Pilih apakah jadwal otomatis mem-backup semua server (file tetap dipisah per server) atau hanya server tertentu.
              </p>
            </div>

            <div
              className={`inline-flex p-1 rounded-lg border shrink-0 ${
                isDark ? 'bg-[#09090B] border-[#27272A]' : 'bg-slate-100 border-slate-200'
              }`}
            >
              <button
                type="button"
                onClick={() => setTargetScope('all')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  targetScope === 'all'
                    ? isDark
                      ? 'bg-red-600 text-white'
                      : 'bg-blue-600 text-white'
                    : isDark
                    ? 'text-zinc-400 hover:text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Semua Server ({servers.length})
              </button>
              <button
                type="button"
                onClick={() => setTargetScope('selected')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  targetScope === 'selected'
                    ? isDark
                      ? 'bg-red-600 text-white'
                      : 'bg-blue-600 text-white'
                    : isDark
                    ? 'text-zinc-400 hover:text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Pilih Server Tertentu (Satuan)
              </button>
            </div>
          </div>

          {targetScope === 'selected' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              {servers.length === 0 ? (
                <p className="text-xs opacity-70 col-span-2">
                  Hubungkan panel Pterodactyl terlebih dahulu untuk memilih server tertentu.
                </p>
              ) : (
                servers.map((srv, idx) => {
                  const checked = selectedServerIds.includes(srv.id);
                  return (
                    <button
                      key={srv.id}
                      type="button"
                      onClick={() => handleToggleServerInSchedule(srv.id)}
                      className={`p-3.5 rounded-lg border text-left flex items-center justify-between gap-2 transition-colors min-w-0 ${
                        checked
                          ? isDark
                            ? 'bg-red-950/25 border-red-500/70 text-zinc-100'
                            : 'bg-blue-50/70 border-blue-600 text-slate-900'
                          : isDark
                          ? 'bg-[#09090B] border-[#242429] text-zinc-400'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-mono font-semibold truncate">
                          Server {idx + 1} · {srv.identifier}
                        </div>
                        <div className="text-sm font-medium mt-0.5 truncate">{srv.name}</div>
                      </div>
                      {checked ? (
                        <CheckSquare className={`w-4 h-4 shrink-0 ${isDark ? 'text-red-400' : 'text-blue-600'}`} />
                      ) : (
                        <Square className="w-4 h-4 shrink-0 opacity-50" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Lock option & Next Run Info */}
        <div className="pt-4 border-t border-current/10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums">
            <label className="inline-flex items-center gap-2 cursor-pointer font-sans">
              <input
                type="checkbox"
                checked={lockNewBackups}
                onChange={(e) => setLockNewBackups(e.target.checked)}
                className="rounded"
              />
              <span>Kunci otomatis file hasil Auto-Update di Panel</span>
            </label>
            <span aria-hidden="true" className="opacity-30">
              |
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CalendarCheck className={`w-4 h-4 shrink-0 ${isDark ? 'text-red-400' : 'text-blue-600'}`} />
              Jadwal Berikutnya:{' '}
              {new Date(schedule.nextRunAt).toLocaleString('id-ID', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>

          <button
            type="submit"
            className={`px-5 py-2.5 text-xs font-semibold text-white rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
              isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            <Save className="w-4 h-4" />
            Simpan Pengaturan Auto-Update
          </button>
        </div>

        {saveFeedback && (
          <div
            className={`p-3 rounded-lg border text-xs font-medium break-words ${
              isDark
                ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                : 'bg-emerald-50 border-emerald-200 text-emerald-800'
            }`}
          >
            {saveFeedback}
          </div>
        )}
      </form>
    </section>
  );
};
