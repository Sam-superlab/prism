import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const localWorkspaceBackupFormat = 'prism-pglite-18-tar-v1';
export const maximumLocalWorkspaceBackupBytes = 128 * 1024 * 1024;

export type LocalWorkspaceBackup = {
  format: typeof localWorkspaceBackupFormat;
  authentication: string;
  data: Blob;
};

const blockSize = 512;
const maximumEntries = 16_384;
const directoryNames = new Set([
  'base', 'global', 'pg_commit_ts', 'pg_dynshmem', 'pg_logical', 'pg_multixact', 'pg_notify',
  'pg_replslot', 'pg_serial', 'pg_snapshots', 'pg_stat', 'pg_stat_tmp', 'pg_subtrans',
  'pg_tblspc', 'pg_twophase', 'pg_wal', 'pg_xact',
]);
const fileNames = new Set(['PG_VERSION', 'pg_hba.conf', 'pg_ident.conf', 'postgresql.auto.conf', 'postgresql.conf', 'postmaster.pid']);

function invalidBackup(): never {
  throw new Error('The workspace backup has an invalid or unsupported archive.');
}

function tarOctal(field: Buffer) {
  const value = field.toString('latin1').replace(/[\0 ]+$/u, '').trimStart();
  if (!/^[0-7]+$/.test(value)) invalidBackup();
  return Number.parseInt(value, 8);
}

function tarName(header: Buffer) {
  const field = header.subarray(0, 100);
  const end = field.indexOf(0);
  if (end === 0 || (end > 0 && field.subarray(end).some((byte) => byte !== 0))) invalidBackup();
  const name = field.subarray(0, end === -1 ? field.length : end).toString('latin1');
  // The pinned PGlite writer places one leading slash before PGDATA-relative paths.
  const segments = name.split('/');
  if (segments.shift() !== '' || segments.some((segment) =>
    !/^[A-Za-z0-9_]/.test(segment) || /[^A-Za-z0-9_.-]/.test(segment))) invalidBackup();
  return segments.join('/');
}

function validateTar(bytes: Buffer) {
  const seen = new Map<string, boolean>();
  let offset = 0;
  while (offset + blockSize <= bytes.length) {
    const header = bytes.subarray(offset, offset + blockSize);
    if (!header.some(Boolean)) break;
    // tinytar writes atime/ctime at 476/488, outside its filename prefix.
    if (seen.size >= maximumEntries || header.toString('latin1', 257, 265) !== 'ustar\x0000' ||
        header.subarray(157, 257).some(Boolean) || header.subarray(345, 476).some(Boolean)) invalidBackup();
    const expected = tarOctal(header.subarray(148, 156));
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== expected) invalidBackup();

    const path = tarName(header);
    const directory = header[156] === 53;
    const size = tarOctal(header.subarray(124, 136));
    const lastSlash = path.lastIndexOf('/');
    const root = lastSlash === -1;
    if ((!directory && header[156] !== 48) || seen.has(path) || (directory && size !== 0) ||
        (root ? !(directory ? directoryNames : fileNames).has(path) : seen.get(path.slice(0, lastSlash)) !== true)) {
      invalidBackup();
    }
    const start = offset + blockSize;
    offset = start + Math.ceil(size / blockSize) * blockSize;
    if (offset > bytes.length || (path === 'PG_VERSION' && bytes.toString('latin1', start, start + size) !== '18\n')) invalidBackup();
    seen.set(path, directory);
  }
  if (bytes.length - offset !== blockSize * 2 || bytes.subarray(offset).some(Boolean) ||
      seen.get('PG_VERSION') !== false || seen.get('global/pg_control') !== false || seen.get('base') !== true) invalidBackup();
}

export function assertLocalWorkspaceBackupSize(dataDir: string) {
  // PGlite materializes the archive. Bound the actual file tree before it allocates the buffer.
  if (!lstatSync(dataDir).isDirectory()) throw new Error('The workspace data folder is unavailable.');
  let bytes = 2 * blockSize;
  let entries = 0;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const item = lstatSync(path);
      if (!item.isDirectory() && !item.isFile()) throw new Error('The workspace backup contains an unsupported file.');
      bytes += blockSize + (item.isFile() ? Math.ceil(item.size / blockSize) * blockSize : 0);
      if (++entries > maximumEntries || bytes > maximumLocalWorkspaceBackupBytes)
        throw new Error('The workspace is too large for this backup format.');
      if (item.isDirectory()) visit(path);
    }
  };
  visit(dataDir);
}

function authentication(key: Uint8Array, bytes: Buffer) {
  if (key.byteLength !== 32) throw new Error('A 32-byte local workspace backup key is required.');
  return createHmac('sha256', key).update(localWorkspaceBackupFormat).update('\0').update(bytes).digest();
}

export async function validateLocalWorkspaceBackupArchive(backup: LocalWorkspaceBackup, key: Uint8Array): Promise<Blob> {
  if (key.byteLength !== 32) throw new Error('A 32-byte local workspace backup key is required.');
  if (backup.format !== localWorkspaceBackupFormat || backup.authentication.length !== 64 || !/^[a-f0-9]+$/.test(backup.authentication) ||
      !(backup.data instanceof Blob) || backup.data.size < blockSize * 4 ||
      backup.data.size > maximumLocalWorkspaceBackupBytes || backup.data.size % blockSize !== 0) invalidBackup();
  const bytes = Buffer.from(await backup.data.arrayBuffer());
  if (!timingSafeEqual(authentication(key, bytes), Buffer.from(backup.authentication, 'hex'))) invalidBackup();
  validateTar(bytes);
  return new Blob([bytes], { type: 'application/x-tar' });
}

export async function createLocalWorkspaceBackup(data: Blob, key: Uint8Array): Promise<LocalWorkspaceBackup> {
  if (data.size > maximumLocalWorkspaceBackupBytes) throw new Error('The workspace is too large for this backup format.');
  const bytes = Buffer.from(await data.arrayBuffer());
  validateTar(bytes);
  return { format: localWorkspaceBackupFormat, authentication: authentication(key, bytes).toString('hex'), data };
}
