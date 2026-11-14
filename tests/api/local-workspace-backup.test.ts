import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { createDatabase, localWorkspaceBackupFormat, validateLocalWorkspaceBackup, type Sql } from '../../packages/database/src/index';
import { validateLocalWorkspaceBackupArchive } from '../../packages/database/src/local-workspace-backup';

it('authenticates a transaction-consistent local backup and opens it without touching the source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-local-backup-test-'));
  const db = await createDatabase({ dataDir: join(dir, 'database') });
  const config = loadConfig({ PRISM_AUTH_MODE: 'development', PRISM_DATA_DIR: dir });
  const app = await buildApp({ config, db });
  try {
    const create = (url: string, payload: Record<string, unknown>, method: 'POST' | 'PUT' = 'POST') => app.inject({
      method, url: '/api/v1/' + url, payload, headers: { 'Idempotency-Key': randomUUID() },
    });
    const knowledgeID = randomUUID(), referenceID = randomUUID(), attachmentID = randomUUID();
    const note = { id: knowledgeID, title: 'Synthetic checkpoint', type: 'note', content: 'Only the fixture.' };
    expect((await create('knowledge-items', note)).statusCode).toBe(201);
    expect((await create('research/references', { id: referenceID, title: 'Synthetic PDF reference' })).statusCode).toBe(201);
    const bytes = Buffer.from('%PDF-1.7\nSynthetic backup attachment');
    const metadata = { id: attachmentID, format: 'pdf', file_name: 'Fixture.pdf', size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    expect((await create(`research/references/${referenceID}/attachments`, metadata)).statusCode).toBe(200);
    expect((await create(`research/attachments/${attachmentID}/chunk`, { offset: 0, data: bytes.toString('base64') }, 'PUT')).statusCode).toBe(200);
    expect((await create(`research/attachments/${attachmentID}/complete`, {})).statusCode).toBe(200);

    const trustedLocalBackupKey = randomBytes(32);
    await expect(db.snapshotLocalWorkspace(Buffer.alloc(31))).rejects.toThrow('32-byte');
    let entered!: () => void, release!: () => void;
    const firstWrite = new Promise<void>((resolve) => { entered = resolve; });
    const continueTransaction = new Promise<void>((resolve) => { release = resolve; });
    const transaction = db.transaction(config.userId, async (sql) => {
      await sql.query('UPDATE knowledge_items SET title=$2 WHERE id=$1', [knowledgeID, 'New title']);
      entered();
      await continueTransaction;
      await sql.query('UPDATE knowledge_items SET content=$2 WHERE id=$1', [knowledgeID, 'New content']);
    });
    const backup = await (async () => {
      try {
        await Promise.race([firstWrite, transaction]);
        return db.snapshotLocalWorkspace(trustedLocalBackupKey);
      } finally { release(); }
    })();
    await transaction;
    expect(backup.format).toBe(localWorkspaceBackupFormat);
    expect(backup.authentication).toMatch(/^[a-f0-9]{64}$/);
    expect(await validateLocalWorkspaceBackup(backup, trustedLocalBackupKey)).toEqual({ knowledgeItems: 1, attachments: 1 });

    const validated = await validateLocalWorkspaceBackupArchive(backup, trustedLocalBackupKey);
    const requireDatabase = createRequire(new URL('../../packages/database/package.json', import.meta.url));
    const { PGlite } = requireDatabase('@electric-sql/pglite') as {
      PGlite: { create(options: { loadDataDir: Blob }): Promise<Sql & { close(): Promise<void> }> };
    };
    const isolated = await PGlite.create({ loadDataDir: validated });
    try {
      const { rows: [item] } = await isolated.query('SELECT title,content FROM prism.knowledge_items WHERE id=$1', [knowledgeID]);
      expect(item).toEqual({ title: 'New title', content: 'New content' });
      const { rows: [chunk] } = await isolated.query<{ data: Uint8Array }>(
        'SELECT data FROM prism.research_reference_pdf_chunks WHERE pdf_id=$1', [attachmentID],
      );
      expect(Buffer.from(chunk.data)).toEqual(bytes);
      await isolated.query('UPDATE prism.knowledge_items SET title=$2 WHERE id=$1', [knowledgeID, 'Only in the validation copy']);
      expect((await db.query('SELECT title FROM prism.knowledge_items WHERE id=$1', [knowledgeID])).rows[0].title).toBe('New title');
    } finally { await isolated.close(); }

    await expect(validateLocalWorkspaceBackup(backup, randomBytes(32))).rejects.toThrow('invalid or unsupported');
    const invalid = Buffer.from(await backup.data.arrayBuffer());
    invalid[0] ^= 1;
    await expect(validateLocalWorkspaceBackup({ ...backup, data: new Blob([invalid]) }, trustedLocalBackupKey))
      .rejects.toThrow('invalid or unsupported');
    invalid.fill(0, 0, 100);
    invalid.write('/../PG_VERSION');
    invalid.fill(32, 148, 156);
    const checksum = invalid.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8);
    invalid.write(checksum, 148);
    const authentication = createHmac('sha256', trustedLocalBackupKey).update(backup.format).update('\0').update(invalid).digest('hex');
    await expect(validateLocalWorkspaceBackup({ ...backup, authentication, data: new Blob([invalid]) }, trustedLocalBackupKey))
      .rejects.toThrow('invalid or unsupported');
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
