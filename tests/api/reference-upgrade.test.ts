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

    await db.query('DROP TABLE prism.research_question_links');
    await db.query('ALTER TABLE prism.research_objects DROP COLUMN question_status');
    await db.query('DROP TABLE prism.research_reference_knowledge_links');
    await db.query('DROP TABLE prism.research_pdf_reading_positions');
    await db.query('DROP TABLE prism.research_reference_relations');
    await db.query('DROP TABLE prism.research_pdf_page_text,prism.research_pdf_text_indexes');
    await db.query('DROP TABLE prism.research_pdf_annotations');
    await db.query('DROP TABLE prism.research_text_annotations');
    await db.query('DROP FUNCTION prism.protect_text_annotation_anchor()');
    await db.query('DROP TABLE prism.research_reference_pdf_chunks,prism.research_reference_pdfs');
    await db.query('DROP TABLE prism.literature_saved_searches');
    await db.query('DROP TABLE prism.literature_collection_memberships,prism.literature_collections');
    await db.query('DROP TABLE prism.research_reference_links');
    await db.query(`ALTER TABLE prism.research_references
      DROP COLUMN arxiv_id,DROP COLUMN citation_key,DROP COLUMN publication,DROP COLUMN tags,DROP COLUMN citation_aliases,DROP COLUMN merged_into_id,ALTER COLUMN project_id SET NOT NULL`);
    await db.initialize();
    const earlier = await app.inject({ url: `/api/v1/research/references/${reference}` });
    expect(earlier.statusCode).toBe(200);
    expect(earlier.json()).toMatchObject({
      id: reference, project_id: project, title: 'Earlier reference', arxiv_id: null, citation_key: null, publication: {},
    });

    const standalone = randomUUID();
    expect((await create('research/references', { id: standalone, title: 'Standalone reference' })).statusCode).toBe(201);
    expect((await create('research/reference-links', {
      id: randomUUID(), reference_id: standalone, project_id: project,
    })).statusCode).toBe(201);

    const collection = randomUUID();
    expect((await create('research/library/collections', { id: collection, name: 'Fixture collection' })).statusCode).toBe(201);
    expect((await create('research/library/memberships', {
      id: randomUUID(), reference_id: reference, collection_id: collection,
    })).statusCode).toBe(201);

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
