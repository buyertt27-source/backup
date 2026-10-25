export type ThemeMode = 'dark' | 'light';

export type ServerStatus = 'running' | 'offline' | 'starting' | 'stopping';

export interface PteroCredentials {
  domain: string;
  pltaKey: string;
  pltsKey: string;
}

export interface PteroBackupFile {
  id: string;
  uuid: string;
  serverId: string;
  serverName: string;
  serverIdentifier: string;
  fileName: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
  completedAt: string | null;
  status: 'completed' | 'in_progress' | 'failed';
  isLocked: boolean;
  triggerType: 'manual_single' | 'manual_batch' | 'auto_schedule';
  ignoredFiles: string;
  driveFileId?: string;
  driveWebViewLink?: string;
  driveFolderName?: string;
  savedToDriveAt?: string;
}

export interface PteroServer {
  id: string;
  uuid: string;
  identifier: string;
  name: string;
  node: string;
  description: string;
  status: ServerStatus;
  limits: {
    memoryMb: number;
    diskMb: number;
    cpuPercent: number;
    backupLimit: number;
  };
  usage: {
    memoryUsedMb: number;
    diskUsedMb: number;
  };
  eggName: string;
  allocation: string;
  backups: PteroBackupFile[];
}

export type ScheduleFrequency = 'interval_hours' | 'daily' | 'weekly';

export type AutoDeleteStrategy = 'delete_all_previous' | 'keep_retention_count';

export interface AutoBackupSchedule {
  enabled: boolean;
  frequency: ScheduleFrequency;
  intervalHours: number;
  timeOfDay: string; // HH:mm format e.g. "03:00"
  dayOfWeek: number; // 0 = Sunday, 1 = Monday, etc.
  targetScope: 'all' | 'selected';
  selectedServerIds: string[];
  retentionCount: number; // Keep max N backups per server
  autoDeletePrevious: boolean; // Automatically delete previous backup(s) on Pterodactyl during auto-backup
  autoDeleteStrategy: AutoDeleteStrategy; // 'delete_all_previous' (keep 1 newest) or 'keep_retention_count'
  lockNewBackups: boolean;
  saveToGoogleDrive: boolean; // Whether scheduled Auto-Update also saves backups to Google Drive
  lastRunAt: string | null;
  nextRunAt: string;
}

export interface ActivityLog {
  id: string;
  timestamp: string;
  action: string;
  targetServer: string;
  details: string;
  status: 'success' | 'info' | 'warning' | 'error';
}
