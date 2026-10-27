import { PteroServer, AutoBackupSchedule, ActivityLog } from '../types/pterodactyl';

// Real Pterodactyl state starts empty until connected to the user's real panel via PLTA/PLTS & Domain
export const INITIAL_SERVERS: PteroServer[] = [];

export const INITIAL_SCHEDULE: AutoBackupSchedule = {
  enabled: false,
  frequency: 'interval_hours',
  intervalHours: 1,
  timeOfDay: '03:00',
  dayOfWeek: 1,
  targetScope: 'all',
  selectedServerIds: [],
  retentionCount: 1,
  autoDeletePrevious: true,
  autoDeleteStrategy: 'delete_all_previous',
  lockNewBackups: false,
  saveToGoogleDrive: true,
  lastRunAt: null,
  nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
};

export const INITIAL_LOGS: ActivityLog[] = [];
