import { constants } from 'node:fs';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { localWorkspaceBackupFormat, maximumLocalWorkspaceBackupBytes, restoreLocalWorkspaceBackupAsCopy,
  validateLocalWorkspaceBackup, type Database, type LocalWorkspaceBackup } from '@prism/database';

const legacyMagic = Buffer.from('PRISM-WORKSPACE-BACKUP-V1\n');
const encryptedMagic = Buffer.from('PRISM-WORKSPACE-BACKUP-V2\n');
const authLength = 65;
const nonceLength = 12;
const tagLength = 16;
const encryptionKey = (key: Buffer) => Buffer.from(hkdfSync('sha256', key, 'PRISM backup', 'workspace v2 AES-256-GCM', 32));

async function writeEncryptedArchive(archive: string, backup: LocalWorkspaceBackup, key: Buffer, markCreated: () => void) {
  const file = await open(archive, 'wx', 0o600);
  markCreated();
  const nonce = randomBytes(nonceLength);
  const secret = encryptionKey(key);
  try {
    const cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(encryptedMagic);
    await file.writeFile(Buffer.concat([encryptedMagic, nonce, cipher.update(backup.authentication + '\n')]));
    const data = backup.data.stream().getReader();
    try {
      for (;;) {
        const chunk = await data.read();
        if (chunk.done) break;
        await file.writeFile(cipher.update(chunk.value));
      }
    } finally { data.releaseLock(); }
    await file.writeFile(Buffer.concat([cipher.final(), cipher.getAuthTag()]));
    await file.sync();
  } finally { secret.fill(0); await file.close(); }
}

async function readArchive(archive: string, key: Buffer): Promise<LocalWorkspaceBackup> {
  const file = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= legacyMagic.length + authLength ||
        info.size > encryptedMagic.length + nonceLength + authLength + tagLength + maximumLocalWorkspaceBackupBytes) throw new Error('invalid');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size || (await file.stat()).size !== info.size) throw new Error('invalid');
    let contents: Buffer<ArrayBuffer>;
    if (bytes.subarray(0, legacyMagic.length).equals(legacyMagic)) {
      contents = bytes.subarray(legacyMagic.length);
    } else if (bytes.subarray(0, encryptedMagic.length).equals(encryptedMagic)) {
      const start = encryptedMagic.length + nonceLength;
      const end = bytes.length - tagLength;
      if (end - start <= authLength) throw new Error('invalid');
      const secret = encryptionKey(key);
      try {
        const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(encryptedMagic.length, start));
        decipher.setAAD(encryptedMagic);
        decipher.setAuthTag(bytes.subarray(end));
        contents = decipher.update(bytes.subarray(start, end));
        decipher.final();
      } finally { secret.fill(0); }
    } else throw new Error('invalid');
    if (contents[authLength - 1] !== 10 || contents.length > authLength + maximumLocalWorkspaceBackupBytes) throw new Error('invalid');
    return { format: localWorkspaceBackupFormat, authentication: contents.toString('latin1', 0, authLength - 1),
      data: new Blob([contents.subarray(authLength)]) };
  } finally { await file.close(); }
}

export function enableLocalWorkspaceBackup(db: Database, scratch: string, userId: string) {
  if (!process.send || !isAbsolute(scratch) || db.kind !== 'pglite') return;
  let busy = false;
  process.on('message', (input: unknown) => {
    if (!input || typeof input !== 'object') return;
    const message = input as Record<string, unknown>;
    const { id, key, operation } = message;
    if (message.type !== 'prism-workspace-backup' || typeof id !== 'string' || id.length !== 32 || !/^[a-f0-9]+$/.test(id) ||
        typeof key !== 'string' || key.length !== 64 || !/^[a-f0-9]+$/.test(key) ||
        !['create', 'validate', 'restore'].includes(String(operation))) return;
    const unavailable = busy;
    if (!unavailable) busy = true;
    const trustedLocalBackupKey = Buffer.from(key, 'hex');
    void perform().finally(() => { trustedLocalBackupKey.fill(0); if (!unavailable) busy = false; });

    async function perform() {
      const folder = join(resolve(scratch), id as string);
      try {
        for (const path of [scratch, folder]) {
          const info = await lstat(path);
          if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) return;
        }
      } catch { return; }
      const archive = join(folder, 'archive.prismbackup');
      let result: { ok: boolean; knowledgeItems?: number; attachments?: number; reason?: string };
      let created = false;
      try {
        if (unavailable) {
          result = { ok: false, reason: 'busy' };
        } else if (operation === 'create') {
          const backup = await db.snapshotLocalWorkspace(trustedLocalBackupKey);
          await writeEncryptedArchive(archive, backup, trustedLocalBackupKey, () => { created = true; });
          result = { ok: true };
        } else {
          const backup = await readArchive(archive, trustedLocalBackupKey);
          if (operation === 'restore') {
            await restoreLocalWorkspaceBackupAsCopy(backup, trustedLocalBackupKey, join(folder, 'database'), userId);
            result = { ok: true };
          } else {
            const counts = await validateLocalWorkspaceBackup(backup, trustedLocalBackupKey);
            result = { ok: true, ...counts };
          }
        }
      } catch (error) {
        if (created) await unlink(archive).catch(() => {});
        result = { ok: false, reason: operation !== 'create' ? 'invalid' :
          error instanceof Error && error.message.includes('too large') ? 'too-large' : 'unavailable' };
      }
      const pending = join(folder, 'result.pending');
      try {
        const file = await open(pending, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(result)); } finally { await file.close(); }
        await rename(pending, join(folder, 'result.json'));
      } catch { await unlink(pending).catch(() => {}); }
    }
  });
}
