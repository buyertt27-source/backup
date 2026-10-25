import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePanelDomain,
  validateCredentials,
  generateIsolatedBackupFileName,
  executeBackupForServers,
  calculateNextScheduleRun,
  formatBytes,
  selectBackupsToAutoDelete,
} from './backupLogic';
import { buildServerDriveFolderName } from '../services/googleDriveService';
import { PteroServer, PteroBackupFile } from '../types/pterodactyl';

const sampleServers: PteroServer[] = [
  {
    id: 'srv-1',
    uuid: '11111111-aaaa-bbbb-cccc-000000000001',
    identifier: 'a1b2c3d4',
    name: 'PaperMC Survival Utama',
    node: 'Node-SG-01',
    description: 'Server utama survival produksi',
    status: 'running',
    limits: { memoryMb: 16384, diskMb: 51200, cpuPercent: 400, backupLimit: 5 },
    usage: { memoryUsedMb: 11200, diskUsedMb: 14500 },
    eggName: 'Paper 1.21.1',
    allocation: '103.152.118.10:25565',
    backups: [],
  },
  {
    id: 'srv-2',
    uuid: '22222222-aaaa-bbbb-cccc-000000000002',
    identifier: 'e5f6g7h8',
    name: 'Velocity Proxy Network',
    node: 'Node-SG-01',
    description: 'Proxy pintu masuk jaringan',
    status: 'running',
    limits: { memoryMb: 4096, diskMb: 10240, cpuPercent: 200, backupLimit: 5 },
    usage: { memoryUsedMb: 1850, diskUsedMb: 820 },
    eggName: 'Velocity Proxy',
    allocation: '103.152.118.10:25577',
    backups: [],
  },
];

test('normalizePanelDomain strips trailing slashes and adds https', () => {
  assert.equal(normalizePanelDomain('panel.contoh.id/'), 'https://panel.contoh.id');
  assert.equal(normalizePanelDomain('https://ptero.serverku.com///'), 'https://ptero.serverku.com');
  assert.equal(normalizePanelDomain(''), '');
});

test('validateCredentials validates domain and PLTA/PLTS key lengths properly', () => {
  const invalidResult = validateCredentials({
    domain: '',
    pltaKey: '',
    pltsKey: '',
  });
  assert.equal(invalidResult.valid, false);
  assert.ok(invalidResult.errors.domain);
  assert.ok(invalidResult.errors.pltaKey);
  assert.ok(invalidResult.errors.pltsKey);

  const shortKeyResult = validateCredentials({
    domain: 'panel.hostingku.id',
    pltaKey: 'short',
    pltsKey: 'short',
  });
  assert.equal(shortKeyResult.valid, false);

  const validResult = validateCredentials({
    domain: 'panel.hostingku.id',
    pltaKey: 'ptla_AbCdEfGhIjKlMnOpQrStUvWxYz123456',
    pltsKey: 'ptlc_ZyXwVuTsRqPoNmLkJiHgFeDcBa654321',
  });
  assert.equal(validResult.valid, true);
  assert.deepEqual(validResult.errors, {});
});

test('generateIsolatedBackupFileName creates distinct separated filenames per server', () => {
  const file1 = generateIsolatedBackupFileName(1, 'a1b2c3d4', 'PaperMC Survival', '2026-10-25T09:30:00.000Z');
  const file2 = generateIsolatedBackupFileName(2, 'e5f6g7h8', 'Velocity Proxy', '2026-10-25T09:30:00.000Z');

  assert.notEqual(file1, file2);
  assert.ok(file1.includes('srv01_a1b2c3d4_papermc-survival'));
  assert.ok(file2.includes('srv02_e5f6g7h8_velocity-proxy'));
  assert.ok(file1.endsWith('.tar.gz'));
});

test('buildServerDriveFolderName creates isolated Google Drive subfolder names per server', () => {
  const folder1 = buildServerDriveFolderName(1, 'a1b2c3d4', 'PaperMC Survival');
  const folder2 = buildServerDriveFolderName(2, 'e5f6g7h8', 'Velocity Proxy');
  assert.equal(folder1, 'Server_01_a1b2c3d4_PaperMC Survival');
  assert.equal(folder2, 'Server_02_e5f6g7h8_Velocity Proxy');
  assert.notEqual(folder1, folder2);
});

test('executeBackupForServers supports single server (Server 2 only) and batch all servers with isolated files', () => {
  const nowIso = '2026-10-25T10:00:00.000Z';

  const singleRun = executeBackupForServers(sampleServers, ['srv-2'], 'manual_single', nowIso, 5);
  assert.equal(singleRun.createdBackups.length, 1);
  assert.equal(singleRun.updatedServers[0].backups.length, 0);
  assert.equal(singleRun.updatedServers[1].backups.length, 1);
  assert.ok(singleRun.updatedServers[1].backups[0].fileName.includes('srv02_e5f6g7h8'));

  const batchRun = executeBackupForServers(singleRun.updatedServers, ['srv-1', 'srv-2'], 'manual_batch', nowIso, 5);
  assert.equal(batchRun.createdBackups.length, 2);
  assert.equal(batchRun.updatedServers[0].backups.length, 1);
  assert.equal(batchRun.updatedServers[1].backups.length, 2);
  assert.notEqual(
    batchRun.updatedServers[0].backups[0].fileName,
    batchRun.updatedServers[1].backups[0].fileName
  );
});

test('selectBackupsToAutoDelete frees full slots before creation and deletes previous backups during auto-backup', () => {
  const existing: PteroBackupFile[] = [
    {
      id: 'bkp-newest',
      uuid: 'bkp-newest',
      serverId: 'srv-1',
      serverName: 'PaperMC',
      serverIdentifier: 'a1b2c3d4',
      fileName: 'backup_srv01_newest.tar.gz',
      sizeBytes: 1000,
      checksum: 'sha256:1',
      createdAt: '2026-10-25T10:00:00.000Z',
      completedAt: '2026-10-25T10:00:00.000Z',
      status: 'completed',
      isLocked: false,
      triggerType: 'auto_schedule',
      ignoredFiles: '',
    },
    {
      id: 'bkp-oldest',
      uuid: 'bkp-oldest',
      serverId: 'srv-1',
      serverName: 'PaperMC',
      serverIdentifier: 'a1b2c3d4',
      fileName: 'backup_srv01_oldest.tar.gz',
      sizeBytes: 1000,
      checksum: 'sha256:2',
      createdAt: '2026-10-24T10:00:00.000Z',
      completedAt: '2026-10-24T10:00:00.000Z',
      status: 'completed',
      isLocked: false,
      triggerType: 'auto_schedule',
      ignoredFiles: '',
    },
    {
      id: 'bkp-locked',
      uuid: 'bkp-locked',
      serverId: 'srv-1',
      serverName: 'PaperMC',
      serverIdentifier: 'a1b2c3d4',
      fileName: 'backup_srv01_locked.tar.gz',
      sizeBytes: 1000,
      checksum: 'sha256:3',
      createdAt: '2026-10-23T10:00:00.000Z',
      completedAt: '2026-10-23T10:00:00.000Z',
      status: 'completed',
      isLocked: true,
      triggerType: 'manual_single',
      ignoredFiles: '',
    },
  ];

  // When serverBackupLimit is 3 (currently 3 backups = FULL) and strategy is delete_all_previous:
  // 1 oldest unlocked backup ('bkp-oldest') must be deleted BEFORE creating the new backup,
  // 1 remaining unlocked backup ('bkp-newest') is deleted AFTER creating the new backup,
  // and locked backup ('bkp-locked') is preserved.
  const planAll = selectBackupsToAutoDelete(existing, {
    autoDeletePrevious: true,
    strategy: 'delete_all_previous',
    retentionCount: 1,
    serverBackupLimit: 3,
  });

  assert.equal(planAll.backupsToDeleteBeforeCreate.length, 1);
  assert.equal(planAll.backupsToDeleteBeforeCreate[0].id, 'bkp-oldest');
  assert.equal(planAll.backupsToDeleteAfterCreate.length, 1);
  assert.equal(planAll.backupsToDeleteAfterCreate[0].id, 'bkp-newest');
  assert.equal(planAll.backupsToKeep.length, 1);
  assert.equal(planAll.backupsToKeep[0].id, 'bkp-locked');
});

test('calculateNextScheduleRun computes accurate future timestamps', () => {
  const base = new Date('2026-10-25T08:00:00.000Z');
  const nextInterval = calculateNextScheduleRun(
    { frequency: 'interval_hours', intervalHours: 4, timeOfDay: '03:00', dayOfWeek: 1 },
    base
  );
  assert.equal(new Date(nextInterval).getUTCHours(), 12);

  const nextDaily = calculateNextScheduleRun(
    { frequency: 'daily', intervalHours: 6, timeOfDay: '22:30', dayOfWeek: 1 },
    base
  );
  assert.ok(new Date(nextDaily).getTime() > base.getTime());
});

test('formatBytes formats megabytes and gigabytes cleanly', () => {
  assert.equal(formatBytes(524288000), '500.0 MB');
  assert.equal(formatBytes(2147483648), '2.00 GB');
});
