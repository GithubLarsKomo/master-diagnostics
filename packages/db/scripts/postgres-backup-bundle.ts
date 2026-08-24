import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, type CipherGCM } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import postgres from 'postgres';
import { readBackupEncryptionKey } from '../src/services/backup-bundle';

const MAGIC = Buffer.from('MDPGBK01', 'ascii');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', (chunk) => hash.update(chunk));
  await once(input, 'end');
  return hash.digest('hex');
}

async function waitForChild(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
    throw new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${String(code)}`}${suffix}`);
  }
}

async function run(command: string, args: string[], label: string): Promise<void> {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  await waitForChild(child, label);
}

async function runToFile(command: string, args: string[], path: string, label: string): Promise<void> {
  const output = createWriteStream(path, { mode: 0o600 });
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (!child.stdout) throw new Error(`${label} did not expose stdout`);
  await Promise.all([pipeline(child.stdout, output), waitForChild(child, label)]);
  await chmod(path, 0o600);
}

function encryptionTransform(hash: ReturnType<typeof createHash>, cipher: CipherGCM) {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      try {
        const tag = cipher.getAuthTag();
        hash.update(tag);
        this.push(tag);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

async function createBundle(): Promise<void> {
  const databaseUrl = required('DATABASE_URL');
  const keyFile = required('BACKUP_KEY_FILE');
  const targetDir = required('POSTGRES_BACKUP_DIR');
  const key = await readBackupEncryptionKey(keyFile);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(join(tmpdir(), 'md-pg-backup-'));
  const dumpPath = join(workDir, 'database.dump');
  const rolesPath = join(workDir, 'roles.sql');
  const manifestPath = join(workDir, 'manifest.json');
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[-:.]/g, '');
  const fileName = `master-diagnostics-postgres-${timestamp}.pgbak`;
  const outputPath = join(targetDir, fileName);
  const checksumPath = `${outputPath}.sha256`;

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath, databaseUrl], 'pg_dump');
    await chmod(dumpPath, 0o600);
    await runToFile(
      'pg_dumpall',
      ['--roles-only', '--no-role-passwords', '--database', databaseUrl],
      rolesPath,
      'pg_dumpall roles backup',
    );

    const [serverVersion] = await sql<{ server_version: string }[]>`SHOW server_version`;
    const [ownership] = await sql<{ database_name: string; database_owner: string; runtime_role: string }[]>`
      SELECT current_database() AS database_name,
             pg_catalog.pg_get_userbyid(datdba) AS database_owner,
             current_user AS runtime_role
      FROM pg_database
      WHERE datname = current_database()
    `;
    const manifest = {
      bundleVersion: 1,
      databaseEngine: 'postgresql',
      createdAt,
      encryption: 'AES-256-GCM',
      dumpFormat: 'pg_dump-custom',
      restoreReconciliationRequired: true,
      serverVersion: serverVersion?.server_version ?? 'unknown',
      databaseName: ownership?.database_name ?? 'unknown',
      databaseOwner: ownership?.database_owner ?? 'unknown',
      runtimeRole: ownership?.runtime_role ?? 'unknown',
      files: {
        'database.dump': await sha256File(dumpPath),
        'roles.sql': await sha256File(rolesPath),
      },
    } as const;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const header = Buffer.concat([MAGIC, iv]);
    const hash = createHash('sha256');
    hash.update(header);
    const output = createWriteStream(outputPath, { mode: 0o600 });
    output.write(header);
    const tar = spawn('tar', ['-C', workDir, '-cf', '-', 'database.dump', 'roles.sql', 'manifest.json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!tar.stdout) throw new Error('tar did not expose stdout');
    await Promise.all([
      pipeline(tar.stdout, cipher, encryptionTransform(hash, cipher), output),
      waitForChild(tar, 'backup tar'),
    ]);
    const digest = hash.digest('hex');
    await writeFile(checksumPath, `${digest}  ${fileName}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ fileName, outputPath, checksumPath, sha256: digest, manifest })}\n`);
  } finally {
    await sql.end({ timeout: 5 });
    await rm(workDir, { recursive: true, force: true });
  }
}

async function restoreBundle(): Promise<void> {
  const bundlePath = required('POSTGRES_BACKUP_FILE');
  const checksumPath = process.env.POSTGRES_BACKUP_CHECKSUM_FILE?.trim() || `${bundlePath}.sha256`;
  const restoreUrl = required('RESTORE_DATABASE_URL');
  const key = await readBackupEncryptionKey(required('BACKUP_KEY_FILE'));
  const expectedChecksum = (await readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expectedChecksum)) throw new Error('PostgreSQL backup checksum file is invalid');
  const actualChecksum = await sha256File(bundlePath);
  if (actualChecksum !== expectedChecksum) throw new Error('PostgreSQL backup checksum mismatch');

  const info = await stat(bundlePath);
  if (info.size <= MAGIC.length + IV_LENGTH + TAG_LENGTH) throw new Error('PostgreSQL backup bundle is truncated');
  const handle = await open(bundlePath, 'r');
  const header = Buffer.alloc(MAGIC.length + IV_LENGTH);
  const tag = Buffer.alloc(TAG_LENGTH);
  try {
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, info.size - TAG_LENGTH);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('PostgreSQL backup magic is invalid');
  const iv = header.subarray(MAGIC.length);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const workDir = await mkdtemp(join(tmpdir(), 'md-pg-restore-'));
  try {
    const tar = spawn('tar', ['-C', workDir, '-xf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    if (!tar.stdin) throw new Error('restore tar did not expose stdin');
    const encryptedBody = createReadStream(bundlePath, {
      start: MAGIC.length + IV_LENGTH,
      end: info.size - TAG_LENGTH - 1,
    });
    await Promise.all([
      pipeline(encryptedBody, decipher, tar.stdin),
      waitForChild(tar, 'restore tar'),
    ]);

    const manifest = JSON.parse(await readFile(join(workDir, 'manifest.json'), 'utf8')) as {
      bundleVersion: number;
      databaseEngine: string;
      files: Record<string, string>;
    };
    if (manifest.bundleVersion !== 1 || manifest.databaseEngine !== 'postgresql') {
      throw new Error('PostgreSQL backup manifest is unsupported');
    }
    for (const name of ['database.dump', 'roles.sql']) {
      const expected = manifest.files[name];
      if (!expected || await sha256File(join(workDir, name)) !== expected) {
        throw new Error(`PostgreSQL backup manifest checksum mismatch: ${name}`);
      }
    }

    if (process.env.POSTGRES_RESTORE_ROLES === 'true') {
      const adminUrl = required('POSTGRES_ADMIN_URL');
      await run('psql', [adminUrl, '--set', 'ON_ERROR_STOP=1', '--file', join(workDir, 'roles.sql')], 'roles restore');
    }
    await run(
      'pg_restore',
      ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', restoreUrl, join(workDir, 'database.dump')],
      'pg_restore',
    );
    process.stdout.write(`${JSON.stringify({ restored: true, bundle: basename(bundlePath), manifest })}\n`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const command = process.argv[2];
if (command === 'create') await createBundle();
else if (command === 'restore') await restoreBundle();
else throw new Error('Usage: postgres-backup-bundle.ts create|restore');
