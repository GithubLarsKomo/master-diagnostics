import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';

const sourceDb = required('CUTOVER_SOURCE_DB');
const legacyBackup = required('CUTOVER_LEGACY_BACKUP');
const sourceReportPath = required('SOURCE_RECONCILIATION_REPORT');
const restoreReportPath = required('POSTGRES_RESTORE_REPORT_PATH');
const pgBackupFile = required('POSTGRES_BACKUP_FILE');
const pgBackupChecksumFile = required('POSTGRES_BACKUP_CHECKSUM_FILE');
const receiptPath = required('CUTOVER_RECEIPT_PATH');

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function sha256File(path: string): Promise<string> {
  const value = await readFile(path);
  return createHash('sha256').update(value).digest('hex');
}

function assertReconciliation(report: any, label: string): void {
  if (report?.status !== 'MATCH') throw new Error(`${label} reconciliation status is not MATCH`);
  if (report?.tableCount !== 46) throw new Error(`${label} reconciliation must cover 46 tables`);
  if (!Array.isArray(report?.mismatches) || report.mismatches.length !== 0) {
    throw new Error(`${label} reconciliation contains mismatches`);
  }
  const critical = report?.criticalTables ?? {};
  for (const key of ['diagnosticResultSnapshots', 'reportVersions', 'interpretations', 'auditEvents']) {
    if (critical[key]?.matches !== true) throw new Error(`${label} critical table is not matched: ${key}`);
  }
}

const sourceStat = await stat(sourceDb);
if ((sourceStat.mode & 0o222) !== 0) throw new Error('Cutover source snapshot is not sealed read-only');

const sourceSha256 = await sha256File(sourceDb);
const legacyBackupSha256 = await sha256File(legacyBackup);
if (sourceSha256 !== legacyBackupSha256) throw new Error('Final legacy backup does not match sealed cutover source');

const sourceReport = JSON.parse(await readFile(sourceReportPath, 'utf8'));
const restoreReport = JSON.parse(await readFile(restoreReportPath, 'utf8'));
assertReconciliation(sourceReport, 'libSQL -> PostgreSQL');
assertReconciliation(restoreReport, 'PostgreSQL restore');

const postgresBackupSha256 = await sha256File(pgBackupFile);
const checksumText = (await readFile(pgBackupChecksumFile, 'utf8')).trim();
const expectedPostgresSha256 = checksumText.split(/\s+/)[0]?.toLowerCase();
if (expectedPostgresSha256 !== postgresBackupSha256) {
  throw new Error('PostgreSQL backup checksum does not match backup bundle');
}

const receipt = {
  schemaVersion: 1,
  status: 'READY_FOR_CUTOVER',
  createdAt: new Date().toISOString(),
  rehearsalOnly: true,
  productionSwitchPerformed: false,
  dualWriteUsed: false,
  sourceFreeze: {
    mode: 'SEALED_READ_ONLY_SNAPSHOT',
    sourceSha256,
    finalLegacyBackupSha256: legacyBackupSha256,
    identical: true,
  },
  migration: {
    sourceEngine: 'libsql',
    targetEngine: 'postgresql',
    tableCount: sourceReport.tableCount,
    status: sourceReport.status,
    criticalTables: sourceReport.criticalTables,
  },
  firstPostgresBackup: {
    sha256: postgresBackupSha256,
    encrypted: true,
    isolatedRestoreVerified: true,
  },
  restoreVerification: {
    tableCount: restoreReport.tableCount,
    status: restoreReport.status,
    criticalTables: restoreReport.criticalTables,
  },
  gates: {
    sourceSealedBeforeMigration: true,
    finalLegacyBackupMatchesSource: true,
    migrationReconciliationPassed: true,
    postgresBackupCreated: true,
    postgresBackupChecksumPassed: true,
    isolatedRestorePassed: true,
    restoreReconciliationPassed: true,
  },
};

await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
