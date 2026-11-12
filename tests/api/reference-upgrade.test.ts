import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { createDatabase } from '../../packages/database/src/index';

it('upgrades a local preview References table while preserving existing entries', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'prism-reference-upgrade-'));
  const db = await createDatabase({ memory: true });
  const app = await buildApp({
    db,
    config: loadConfig({ PRISM_AUTH_MODE: 'development', PRISM_DATA_DIR: dataDir }),
  });
  const create = (path: string, body: { id: string } & Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/${path}`,
      headers: { 'Idempotency-Key': body.id },
      payload: body,
    });
  try {
    const project = randomUUID();
    const reference = randomUUID();
    expect((await create('research/projects', { id: project, title: 'Synthetic project' })).statusCode).toBe(
      201,
    );
    expect(
      (
        await create('research/references', {
          id: reference,
          project_id: project,
          title: 'Earlier reference',
        })
      ).statusCode,
    ).toBe(201);

    await db.query('ALTER TABLE prism.research_references DROP COLUMN arxiv_id');
    await db.initialize();
    const earlier = await app.inject({ url: `/api/v1/research/references/${reference}` });
    expect(earlier.statusCode).toBe(200);
    expect(earlier.json()).toMatchObject({ id: reference, title: 'Earlier reference', arxiv_id: null });

    const arxivReference = {
      id: randomUUID(),
      project_id: project,
      title: 'New arXiv reference',
      arxiv_id: '2401.12345',
    };
    expect((await create('research/references', arxivReference)).statusCode).toBe(201);
    expect((await create('research/references', { ...arxivReference, id: randomUUID() })).statusCode).toBe(
      409,
    );
  } finally {
    await app.close();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
