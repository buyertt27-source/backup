import React, { useState, useEffect } from 'react';
import {
  AutoBackupSchedule,
  AutoDeleteStrategy,
  PteroServer,
  ScheduleFrequency,
  ThemeMode,
} from '../types/pterodactyl';
import {
  calculateNextScheduleRun,
  ensureFutureNextRunAt,
  formatCountdownMs,
} from '../utils/backupLogic';
import {
  Clock,
  CalendarCheck,
  Play,
  Save,
  CheckSquare,
  Square,
  CloudUpload,
  Trash2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';

interface AutoBackupSchedulerPanelProps {
  schedule: AutoBackupSchedule;
  servers: PteroServer[];
  isDriveConnected: boolean;
  isRunningAutoBackup?: boolean;
  onRequestGoogleSignIn: () => void;
  onUpdateSchedule: (updated: AutoBackupSchedule) => void;
  onTriggerScheduledRunNow: (overrideSchedule?: AutoBackupSchedule) => void;
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

const INTERVAL_OPTIONS = [
  { value: 0.0167, label: 'Setiap 1 Menit (Tes Cepat Auto-Backup)' },
  { value: 0.0833, label: 'Setiap 5 Menit (Tes Cepat ke Drive)' },
  { value: 0.25, label: 'Setiap 15 Menit' },
  { value: 0.5, label: 'Setiap 30 Menit' },
  { value: 1, label: 'Setiap 1 Jam (Per Jam)' },
  { value: 3, label: 'Setiap 3 Jam' },
  { value: 6, label: 'Setiap 6 Jam' },
  { value: 12, label: 'Setiap 12 Jam' },
  { value: 24, label: 'Setiap 24 Jam' },
];

export const AutoBackupSchedulerPanel: React.FC<AutoBackupSchedulerPanelProps> = ({
  schedule,
  servers,
  isDriveConnected,
  isRunningAutoBackup = false,
  onRequestGoogleSignIn,
  onUpdateSchedule,
  onTriggerScheduledRunNow,
  theme,
}) => {
  const [enabled, setEnabled] = useState<boolean>(schedule.enabled);
  const [frequency, setFrequency] = useState<ScheduleFrequency>(schedule.frequency);
  const [intervalHours, setIntervalHours] = useState<number>(schedule.intervalHours || 1);
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
  const [saveToGoogleDrive, setSaveToGoogleDrive] = useState<boolean>(
    schedule.saveToGoogleDrive ?? true
  );
  const [runImmediatelyOnSave, setRunImmediatelyOnSave] = useState<boolean>(true);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    setEnabled(schedule.enabled);
    setFrequency(schedule.frequency);
    setIntervalHours(schedule.intervalHours || 1);
    setTimeOfDay(schedule.timeOfDay);
    setDayOfWeek(schedule.dayOfWeek);
    setTargetScope(schedule.targetScope);
    setSelectedServerIds(schedule.selectedServerIds);
    setRetentionCount(schedule.retentionCount || 1);
    setAutoDeletePrevious(schedule.autoDeletePrevious ?? true);
    setAutoDeleteStrategy(schedule.autoDeleteStrategy || 'delete_all_previous');
    setLockNewBackups(schedule.lockNewBackups);
    setSaveToGoogleDrive(schedule.saveToGoogleDrive ?? true);
  }, [schedule]);

  // Live 1-second tick + visibility wake-up for real-time countdown display
  useEffect(() => {
    const ticker = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    const handleWake = () => setNowMs(Date.now());
    document.addEventListener('visibilitychange', handleWake);
    window.addEventListener('focus', handleWake);
    return () => {
      clearInterval(ticker);
      document.removeEventListener('visibilitychange', handleWake);
      window.removeEventListener('focus', handleWake);
    };
  }, []);

  const isDark = theme === 'dark';

  const buildScheduleObject = (overrides: Partial<AutoBackupSchedule> = {}): AutoBackupSchedule => {
    const nextFreq = overrides.frequency ?? frequency;
    const nextIntHours = overrides.intervalHours ?? intervalHours;
    const nextTime = overrides.timeOfDay ?? timeOfDay;
    const nextDay = overrides.dayOfWeek ?? dayOfWeek;
    const nextScope = overrides.targetScope ?? targetScope;
    const nextSelIds = overrides.selectedServerIds ?? selectedServerIds;
    const nextStrategy = overrides.autoDeleteStrategy ?? autoDeleteStrategy;
    const nextRetCount = overrides.retentionCount ?? retentionCount;

    const effectiveSelected =
      nextScope === 'all'
        ? servers.map((s) => s.id)
        : nextSelIds.length > 0
        ? nextSelIds
        : [servers[0]?.id].filter(Boolean);

    const nextRunAt =
      overrides.nextRunAt ||
      calculateNextScheduleRun({
        frequency: nextFreq,
        intervalHours: nextIntHours,
        timeOfDay: nextTime,
        dayOfWeek: nextDay,
      });

    return {
      enabled: overrides.enabled ?? enabled,
      frequency: nextFreq,
      intervalHours: nextIntHours,
      timeOfDay: nextTime,
      dayOfWeek: nextDay,
      targetScope: nextScope,
      selectedServerIds: effectiveSelected,
      retentionCount: nextStrategy === 'delete_all_previous' ? 1 : nextRetCount,
      autoDeletePrevious: overrides.autoDeletePrevious ?? autoDeletePrevious,
      autoDeleteStrategy: nextStrategy,
      lockNewBackups: overrides.lockNewBackups ?? lockNewBackups,
      saveToGoogleDrive: overrides.saveToGoogleDrive ?? saveToGoogleDrive,
      lastRunAt: schedule.lastRunAt,
      nextRunAt,
    };
  };

  const handleToggleServerInSchedule = (srvId: string) => {
    setSelectedServerIds((prev) => {
      const nextIds = prev.includes(srvId) ? prev.filter((id) => id !== srvId) : [...prev, srvId];
      setEnabled(true);
      onUpdateSchedule(buildScheduleObject({ enabled: true, selectedServerIds: nextIds }));
      return nextIds;
    });
  };

  const handleQuickToggleEnabled = () => {
    const nextEnabled = !enabled;
    setEnabled(nextEnabled);
    const updated = buildScheduleObject({
      enabled: nextEnabled,
      saveToGoogleDrive: nextEnabled ? true : saveToGoogleDrive,
    });
    if (nextEnabled) {
      setSaveToGoogleDrive(true);
    }
    onUpdateSchedule(updated);

    if (nextEnabled && runImmediatelyOnSave && (servers.length > 0 || isDriveConnected)) {
      onTriggerScheduledRunNow(updated);
      setSaveFeedback(
        'Auto-Backup 24/7 diaktifkan! Menjalankan siklus backup pertama sekarang dan menyinkronkan Background Daemon...'
      );
    } else {
      setSaveFeedback(
        nextEnabled
          ? `Auto-Backup 24/7 diaktifkan (Background Daemon & Cloud Cron siap berjalan walau panel ditutup)! Eksekusi berikutnya: ${new Date(updated.nextRunAt).toLocaleString('id-ID')}`
          : 'Auto-Backup dinonaktifkan.'
      );
    }
    setTimeout(() => setSaveFeedback(null), 6000);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    // When user clicks Save on the scheduler form, ensure enabled is true so their schedule actually runs
    const effectiveEnabled = true;
    setEnabled(true);
    const nextSchedule = buildScheduleObject({ enabled: effectiveEnabled });

    onUpdateSchedule(nextSchedule);

    if (runImmediatelyOnSave) {
      onTriggerScheduledRunNow(nextSchedule);
      setSaveFeedback(
        `Pengaturan Auto-Backup disimpan & diaktifkan! Menjalankan backup pertama sekarang ke ${
          nextSchedule.saveToGoogleDrive ? 'Panel + Google Drive' : 'Panel Pterodactyl'
        }, lalu berlanjut otomatis 24/7 di background.`
      );
    } else {
      setSaveFeedback(
        `Jadwal Auto-Update 24/7 berhasil disimpan & diaktifkan (${
          autoDeletePrevious
            ? autoDeleteStrategy === 'delete_all_previous'
              ? 'Otomatis hapus semua backup sebelumnya di Pterodactyl'
              : `Otomatis hapus backup lama di atas ${retentionCount} file`
            : 'Tanpa hapus otomatis'
        } · ${
          saveToGoogleDrive ? 'Simpan ke Google Drive + Panel' : 'Simpan di Panel Pterodactyl'
        }). Eksekusi berikutnya: ${new Date(nextSchedule.nextRunAt).toLocaleString('id-ID')}`
      );
    }
    setTimeout(() => setSaveFeedback(null), 6000);
  };

  // Ensure countdown never gets stuck at 00:00:00 even if schedule.nextRunAt just passed
  const alignedSchedule = ensureFutureNextRunAt(schedule, new Date(nowMs));
  const rawRemainingMs = new Date(schedule.nextRunAt).getTime() - nowMs;
  const remainingMs =
    rawRemainingMs > 0
      ? rawRemainingMs
      : Math.max(1000, new Date(alignedSchedule.nextRunAt).getTime() - nowMs);
  const countdownText = formatCountdownMs(remainingMs);

  // If schedule.nextRunAt is reached while viewing this panel, roll it forward & trigger run
  useEffect(() => {
    if (!schedule.enabled || isRunningAutoBackup) return;
    const scheduledMs = new Date(schedule.nextRunAt).getTime();
    if (!Number.isFinite(scheduledMs) || nowMs >= scheduledMs) {
      onTriggerScheduledRunNow();
    }
  }, [nowMs, schedule.enabled, schedule.nextRunAt, isRunningAutoBackup, onTriggerScheduledRunNow]);

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
            Otomatisasi Pencadangan Terjadwal &amp; Google Drive Real-Time
          </p>
          <h2 id="scheduler-heading" className="text-lg sm:text-xl font-bold tracking-tight">
            Konfigurasi Auto-Update Backup &amp; Penyimpanan Google Drive
          </h2>
          <p className={`text-xs mt-1 ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
            Sistem memantau kompresi Wings hingga selesai (<code className="font-mono">completed</code>) sebelum mengunggah arsip <code className="font-mono">.tar.gz</code> ke folder terpisah di Google Drive Anda.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={handleQuickToggleEnabled}
            role="switch"
            aria-checked={enabled}
            className={`px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
              enabled
                ? isDark
                  ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                  : 'bg-emerald-50 border-emerald-600 text-emerald-800'
                : isDark
                ? 'bg-zinc-900 border-zinc-700 text-zinc-400'
                : 'bg-slate-100 border-slate-300 text-slate-600'
            }`}
          >
            Status Auto-Update: {enabled ? 'AKTIF (Berjalan)' : 'Nonaktif (Klik untuk Aktifkan)'}
          </button>

          <button
            type="button"
            disabled={isRunningAutoBackup}
            onClick={() => {
              const currentObj = buildScheduleObject({ enabled: true, saveToGoogleDrive: true });
              setEnabled(true);
              setSaveToGoogleDrive(true);
              onUpdateSchedule(currentObj);
              onTriggerScheduledRunNow(currentObj);
            }}
            className={`px-3.5 py-2 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 text-white ${
              isDark
                ? 'bg-red-600 hover:bg-red-500 disabled:opacity-60'
                : 'bg-blue-600 hover:bg-blue-700 disabled:opacity-60'
            }`}
          >
            {isRunningAutoBackup ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Memproses Auto-Backup ke Drive...
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                Jalankan Auto-Backup ke Drive Sekarang
              </>
            )}
          </button>
        </div>
      </div>

      {/* Live Countdown & Real-Time Telemetry Banner */}
      <div
        className={`mt-5 p-4 rounded-xl border flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
          enabled
            ? isDark
              ? 'bg-emerald-950/20 border-emerald-700/50'
              : 'bg-emerald-50/70 border-emerald-200'
            : isDark
            ? 'bg-[#09090B] border-[#242429]'
            : 'bg-slate-50 border-slate-200'
        }`}
      >
        <div className="flex items-start sm:items-center gap-3 min-w-0">
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 font-mono text-xs font-bold ${
              enabled
                ? isDark
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                : isDark
                ? 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                : 'bg-slate-200 text-slate-600'
            }`}
          >
            <Clock className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider">
                {enabled ? 'Timer Auto-Backup 24/7 Aktif' : 'Timer Auto-Backup Belum Aktif'}
              </span>
              <span
                className={`px-2 py-0.5 text-[11px] rounded font-medium ${
                  enabled
                    ? isDark
                      ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/60'
                      : 'bg-emerald-100 text-emerald-800'
                    : isDark
                    ? 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                    : 'bg-slate-200 text-slate-700'
                }`}
              >
                Daemon 24/7 (Jalan Walau Panel Ditutup)
              </span>
              <span
                className={`px-2 py-0.5 text-[11px] rounded font-medium ${
                  saveToGoogleDrive && isDriveConnected
                    ? isDark
                      ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/60'
                      : 'bg-emerald-100 text-emerald-800'
                    : isDark
                    ? 'bg-amber-950/80 text-amber-300 border border-amber-700/60'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {saveToGoogleDrive
                  ? isDriveConnected
                    ? 'Google Drive Terhubung (Siap Upload Otomatis)'
                    : 'Google Drive Belum Terhubung!'
                  : 'Hanya Simpan di Panel'}
              </span>
            </div>
            <p className={`text-xs mt-1 ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
              {schedule.lastRunAt
                ? `Backup otomatis terakhir berhasil dijalankan pada: ${new Date(
                    schedule.lastRunAt
                  ).toLocaleString('id-ID')} · Berjalan otomatis di background tanpa harus membuka panel.`
                : 'Sistem menjalankan Auto-Backup 24/7 via Server Daemon & Google Apps Script Cloud Cron bahkan saat browser ditutup.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 shrink-0">
          <div
            className={`px-3.5 py-2 rounded-lg border font-mono tabular-nums ${
              isDark ? 'bg-[#09090B] border-[#27272A]' : 'bg-white border-slate-200'
            }`}
          >
            <div className={`text-[10px] uppercase ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
              Hitung Mundur Backup Berikutnya
            </div>
            <div className="text-base font-bold tracking-wider">
              {isRunningAutoBackup ? 'MEMPROSES...' : enabled ? countdownText : '--:--:--'}
            </div>
          </div>

          {!isDriveConnected && (
            <button
              type="button"
              onClick={onRequestGoogleSignIn}
              className={`px-3.5 py-2.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 text-white shrink-0 ${
                isDark ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              <CloudUpload className="w-4 h-4" />
              Hubungkan Google Drive
            </button>
          )}
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
              onChange={(e) => {
                const nextFreq = e.target.value as ScheduleFrequency;
                setFrequency(nextFreq);
                setEnabled(true);
                onUpdateSchedule(buildScheduleObject({ enabled: true, frequency: nextFreq }));
              }}
              className={`w-full px-3.5 py-2.5 text-sm rounded-lg border transition-colors ${
                isDark
                  ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                  : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
              }`}
            >
              <option value="interval_hours">Interval Waktu (Setiap X Menit / Jam)</option>
              <option value="daily">Harian pada Jam Tertentu</option>
              <option value="weekly">Mingguan pada Hari &amp; Jam Tertentu</option>
            </select>
          </div>

          {/* Conditional Time Picker */}
          {frequency === 'interval_hours' ? (
            <div>
              <label htmlFor="schedule-interval-hours" className="block text-sm font-medium mb-2">
                Rentang Interval Auto-Backup
              </label>
              <select
                id="schedule-interval-hours"
                value={intervalHours}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setIntervalHours(val);
                  setEnabled(true);
                  onUpdateSchedule(buildScheduleObject({ enabled: true, intervalHours: val }));
                }}
                className={`w-full px-3.5 py-2.5 text-sm rounded-lg border font-mono tabular-nums transition-colors ${
                  isDark
                    ? 'bg-[#09090B] border-[#27272A] text-zinc-100 focus:border-red-500'
                    : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-600'
                }`}
              >
                {INTERVAL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
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
                  onChange={(e) => {
                    const val = e.target.value;
                    setTimeOfDay(val);
                    setEnabled(true);
                    onUpdateSchedule(buildScheduleObject({ enabled: true, timeOfDay: val }));
                  }}
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
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setDayOfWeek(val);
                  setEnabled(true);
                  onUpdateSchedule(buildScheduleObject({ enabled: true, dayOfWeek: val }));
                }}
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
                  const nextStrat: AutoDeleteStrategy =
                    val === 1 ? 'delete_all_previous' : 'keep_retention_count';
                  setRetentionCount(val);
                  setAutoDeleteStrategy(nextStrat);
                  setEnabled(true);
                  onUpdateSchedule(
                    buildScheduleObject({
                      enabled: true,
                      retentionCount: val,
                      autoDeleteStrategy: nextStrat,
                    })
                  );
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
                  onClick={() => {
                    setAutoDeletePrevious(true);
                    if (enabled) {
                      onUpdateSchedule(buildScheduleObject({ autoDeletePrevious: true }));
                    }
                  }}
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
                  onClick={() => {
                    setAutoDeletePrevious(false);
                    if (enabled) {
                      onUpdateSchedule(buildScheduleObject({ autoDeletePrevious: false }));
                    }
                  }}
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
                    if (enabled) {
                      onUpdateSchedule(
                        buildScheduleObject({
                          autoDeleteStrategy: 'delete_all_previous',
                          retentionCount: 1,
                        })
                      );
                    }
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
                    const nextRet = retentionCount <= 1 ? 3 : retentionCount;
                    setAutoDeleteStrategy('keep_retention_count');
                    setRetentionCount(nextRet);
                    if (enabled) {
                      onUpdateSchedule(
                        buildScheduleObject({
                          autoDeleteStrategy: 'keep_retention_count',
                          retentionCount: nextRet,
                        })
                      );
                    }
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
                  Jika diaktifkan, setiap kali jadwal Auto-Update berjalan, sistem menunggu kompresi backup selesai di Wings lalu otomatis mengunggahnya ke folder (<code className="font-mono">PteroVault_Backups/Server_01_...</code>) di Google Drive Anda.
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
                  onClick={() => {
                    setSaveToGoogleDrive(false);
                    if (enabled) {
                      onUpdateSchedule(buildScheduleObject({ saveToGoogleDrive: false }));
                    }
                  }}
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
                    if (enabled) {
                      onUpdateSchedule(buildScheduleObject({ saveToGoogleDrive: true }));
                    }
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
                onClick={() => {
                  setTargetScope('all');
                  setEnabled(true);
                  onUpdateSchedule(buildScheduleObject({ enabled: true, targetScope: 'all' }));
                }}
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
                onClick={() => {
                  setTargetScope('selected');
                  setEnabled(true);
                  onUpdateSchedule(buildScheduleObject({ enabled: true, targetScope: 'selected' }));
                }}
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
                  const checked =
                    selectedServerIds.includes(srv.id) ||
                    selectedServerIds.includes(srv.uuid) ||
                    selectedServerIds.includes(srv.identifier);
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

        {/* Lock option, Immediate First Run option & Next Run Info */}
        <div className="pt-4 border-t border-current/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 text-xs">
            <label className="inline-flex items-center gap-2 cursor-pointer font-medium">
              <input
                type="checkbox"
                checked={runImmediatelyOnSave}
                onChange={(e) => setRunImmediatelyOnSave(e.target.checked)}
                className="rounded"
              />
              <span>Langsung jalankan backup pertama ke Google Drive saat disimpan</span>
            </label>

            <span aria-hidden="true" className="hidden sm:inline opacity-30">
              |
            </span>

            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={lockNewBackups}
                onChange={(e) => setLockNewBackups(e.target.checked)}
                className="rounded"
              />
              <span>Kunci otomatis file di Panel</span>
            </label>

            <span aria-hidden="true" className="hidden sm:inline opacity-30">
              |
            </span>

            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <CalendarCheck className={`w-4 h-4 shrink-0 ${isDark ? 'text-red-400' : 'text-blue-600'}`} />
              Jadwal Berikutnya:{' '}
              {new Date(alignedSchedule.nextRunAt).toLocaleString('id-ID', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          </div>

          <button
            type="submit"
            disabled={isRunningAutoBackup}
            className={`px-5 py-2.5 text-xs font-semibold text-white rounded-lg flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
              isDark
                ? 'bg-red-600 hover:bg-red-500 disabled:opacity-60'
                : 'bg-blue-600 hover:bg-blue-700 disabled:opacity-60'
            }`}
          >
            <Save className="w-4 h-4" />
            {runImmediatelyOnSave
              ? 'Simpan, Aktifkan & Backup ke Drive Sekarang'
              : 'Simpan & Aktifkan Jadwal Auto-Update'}
          </button>
        </div>

        {saveFeedback && (
          <div
            className={`p-3 rounded-lg border text-xs font-medium flex items-center gap-2 break-words ${
              isDark
                ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                : 'bg-emerald-50 border-emerald-200 text-emerald-800'
            }`}
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{saveFeedback}</span>
          </div>
        )}
      </form>
    </section>
  );
};
