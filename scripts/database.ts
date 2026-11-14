import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const { Client } = require('pg');
const url = process.env.MIGRATION_DATABASE_URL;
if (!url)
  throw new Error(
    'Set MIGRATION_DATABASE_URL to the controlled migration-owner connection. Runtime DATABASE_URL is deliberately not used.',
  );
const client = new Client({ connectionString: url });
await client.connect();
const command = process.argv[2];
try {
  if (command === 'migrate') {
    const ddl = await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(ddl).digest('hex');
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('prism-schema-migration'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS public.prism_migrations(id text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const prior = await client.query("SELECT checksum FROM public.prism_migrations WHERE id='001_initial'");
    if (prior.rows[0]) {
      if (prior.rows[0].checksum !== checksum)
        throw new Error(
          'Initial migration checksum changed. Create an explicit subsequent migration; do not rewrite applied history.',
        );
    } else {
      const present = await client.query("SELECT to_regclass('prism.users') present");
      if (present.rows[0].present)
        throw new Error('Existing untracked schema requires a reviewed baseline before migration.');
      await client.query(ddl.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''));
      await client.query("INSERT INTO public.prism_migrations(id,checksum) VALUES('001_initial',$1)", [
        checksum,
      ]);
    }
    for (const migrationId of [
      '002_arxiv_for_you',
      '003_arxiv_for_you_rounds',
      '004_ai_review_drafts',
      '005_proof_recall',
      '006_research_project_knowledge',
      '007_research_references',
      '008_reference_arxiv_identifiers',
      '009_standalone_references',
      '010_project_reference_links',
      '011_literature_collections',
      '012_reference_merge',
      '013_literature_saved_searches',
      '014_reference_pdfs',
      '015_pdf_annotations',
      '016_pdf_text_index',
      '017_reference_relations',
      '018_pdf_reading_positions',
      '019_pdf_sticky_notes',
      '020_attachment_formats',
      '021_webpage_snapshots',
      '022_reference_knowledge_links',
      '023_literature_search_conditions',
      '024_pdf_area_annotations',
      '025_literature_feeds',
      '026_literature_feed_schedule',
      '027_pdf_ink_annotations',
      '028_private_team_libraries',
      '029_pdf_annotation_tags',
      '030_team_library_visibility',
      '031_team_library_attachments',
      '032_team_library_notes',
      '033_team_pdf_annotations',
      '034_developer_literature_tokens',
      '035_pdf_text_index_mode',
      '036_text_attachment_annotations',
      '037_reference_creators',
      '038_export_attachment_option',
      '039_reference_import_source',
      '040_developer_literature_scopes',
      '041_research_questions',
    ]) {
      const migrationDdl = await readFile(
        new URL(`../database/migrations/${migrationId}.sql`, import.meta.url),
        'utf8',
      );
      const migrationChecksum = createHash('sha256').update(migrationDdl).digest('hex');
      const applied = await client.query('SELECT checksum FROM public.prism_migrations WHERE id=$1', [
        migrationId,
      ]);
      if (!applied.rows.length) {
        await client.query(migrationDdl);
        await client.query('INSERT INTO public.prism_migrations(id,checksum) VALUES($1,$2)', [
          migrationId,
          migrationChecksum,
        ]);
      } else if (applied.rows[0].checksum !== migrationChecksum) {
        throw new Error(`Migration ${migrationId} checksum changed. Do not rewrite applied history.`);
      }
    }
    await client.query('COMMIT');
    console.log('PRISM database migrations are current.');
  } else if (command === 'provision') {
    const id = process.env.PRISM_USER_ID,
      subject = process.env.PRISM_ALLOWED_SUBJECT;
    const email = process.env.PRISM_USER_EMAIL,
      name = process.env.PRISM_DISPLAY_NAME ?? '研究者';
    if (!id || !subject || !email)
      throw new Error('PRISM_USER_ID, PRISM_ALLOWED_SUBJECT and PRISM_USER_EMAIL are required.');
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id',$1,true)", [id]);
    await client.query(
      'INSERT INTO prism.users(id,oidc_subject,email,display_name,timezone) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
      [id, subject, email, name, process.env.PRISM_TIMEZONE ?? 'Europe/Budapest'],
    );
    const user = await client.query('SELECT oidc_subject FROM prism.users WHERE id=$1', [id]);
    if (user.rows[0]?.oidc_subject !== subject)
      throw new Error('Provisioned UUID already belongs to a different OIDC subject.');
    await client.query(
      'INSERT INTO prism.user_preferences(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',
      [randomUUID(), id],
    );
    await client.query(
      'INSERT INTO prism.user_sync_state(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',
      [randomUUID(), id],
    );
    await client.query('COMMIT');
    console.log('Allowlisted user, preferences and synchronization state provisioned.');
  } else if (command === 'runtime-role') {
    const role = process.env.PRISM_RUNTIME_ROLE ?? 'prism_runtime';
    const password = process.env.PRISM_RUNTIME_DB_PASSWORD;
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || !password)
      throw new Error('Provide a safe PRISM_RUNTIME_ROLE and PRISM_RUNTIME_DB_PASSWORD.');
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!exists.rows.length)
      await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    const literal = await client.query('SELECT quote_literal($1::text) value', [password]);
    await client.query(`ALTER ROLE ${role} PASSWORD ${literal.rows[0].value}`);
    await client.query(`GRANT USAGE ON SCHEMA prism TO ${role}`);
    const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='prism'");
    const immutable = new Set([
      'review_events',
      'research_events',
      'scheduler_configs',
      'review_submissions',
      'conflict_resolution_events',
      'sync_change_batches',
      'api_idempotency',
      'arxiv_paper_versions',
    ]);
    for (const { tablename } of tables.rows) {
      const global = ['arxiv_papers', 'arxiv_paper_versions'].includes(tablename);
      const worker = process.env.PRISM_ROLE_KIND === 'worker';
      const privileges = tablename === 'literature_feed_entries'
        ? 'SELECT,INSERT,UPDATE,DELETE'
        : tablename === 'team_library_events' ? 'INSERT'
        : global && !worker ? 'SELECT' : immutable.has(tablename) ? 'SELECT,INSERT' : 'SELECT,INSERT,UPDATE';
      await client.query(`GRANT ${privileges} ON prism.${tablename} TO ${role}`);
    }
    await client.query(`GRANT EXECUTE ON FUNCTION prism.principal() TO ${role}`);
    await client.query(`GRANT EXECUTE ON FUNCTION prism.team_library_role(uuid),prism.team_library_account_name(uuid,uuid) TO ${role}`);
    await client.query(`GRANT EXECUTE ON FUNCTION prism.public_team_libraries(uuid,uuid,integer),
      prism.public_team_library_references(uuid,timestamptz,uuid,integer),prism.team_library_public(uuid),
      prism.team_library_open(uuid) TO ${role}`);
    await client.query(`GRANT EXECUTE ON FUNCTION prism.team_library_attachment_permission(uuid,boolean) TO ${role}`);
    await client.query(`REVOKE UPDATE ON prism.team_library_attachments,prism.team_library_attachment_chunks FROM ${role}`);
    await client.query(`GRANT UPDATE (deleted_at,version) ON prism.team_library_attachments TO ${role}`);
    await client.query(`GRANT UPDATE (data) ON prism.team_library_attachment_chunks TO ${role}`);
    await client.query(`REVOKE UPDATE ON prism.team_library_notes FROM ${role}`);
    await client.query(`GRANT UPDATE (title,content,updated_by,updated_by_name,updated_at,version,deleted_at)
      ON prism.team_library_notes TO ${role}`);
    await client.query(`REVOKE UPDATE ON prism.team_pdf_annotations FROM ${role}`);
    await client.query(`GRANT UPDATE (page,kind,color,text,comment,tags,rects,ink_path,updated_by,updated_by_name,updated_at,version,deleted_at)
      ON prism.team_pdf_annotations TO ${role}`);
    await client.query(`REVOKE ALL ON prism.developer_literature_tokens FROM ${role}`);
    await client.query(`REVOKE EXECUTE ON FUNCTION prism.developer_literature_token_account(uuid,text) FROM ${role}`);
    if (process.env.PRISM_ROLE_KIND !== 'worker') {
      await client.query(`GRANT INSERT,SELECT (id,user_id,name,created_at,expires_at,revoked_at,scope),UPDATE (revoked_at)
        ON prism.developer_literature_tokens TO ${role}`);
      await client.query(`GRANT EXECUTE ON FUNCTION prism.developer_literature_token_account(uuid,text) TO ${role}`);
    }
    console.log(`Runtime role ${role} configured without ownership, DDL or BYPASSRLS.`);
  } else if (command === 'after-restore') {
    const id = process.env.PRISM_USER_ID;
    if (!id) throw new Error('PRISM_USER_ID is required to recover the restored account.');
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id',$1,true)", [id]);
    const head = await client.query(
      'SELECT id,revision FROM prism.user_sync_state WHERE user_id=$1 FOR UPDATE',
      [id],
    );
    if (!head.rows.length) throw new Error('Provision the account before recovery.');
    await client.query(
      'UPDATE prism.user_sync_state SET id=$2,updated_at=now(),version=version+1 WHERE user_id=$1',
      [id, randomUUID()],
    );
    // Generated download files are replaceable; do not advertise missing pre-restore files as ready.
    const expired = await client.query(
      "UPDATE prism.exports SET status='expired',updated_at=now(),version=version+1 WHERE user_id=$1 AND status IN('pending','running','ready')",
      [id],
    );
    await client.query(
      "UPDATE prism.automation_jobs SET status='dead',error_message='Derived export invalidated after restore; request a new export',payload=payload-'run_id',lease_expires_at=NULL,updated_at=now(),version=version+1 WHERE user_id=$1 AND job_type='export' AND status IN('pending','running','failed')",
      [id],
    );
    const retry = await client.query(
      "UPDATE prism.automation_jobs SET status=CASE WHEN attempts>=5 THEN 'dead' ELSE 'failed' END,lease_expires_at=NULL,scheduled_at=now(),error_message='Interrupted by database restoration',updated_at=now(),version=version+1 WHERE user_id=$1 AND job_type<>'export' AND status='running'",
      [id],
    );
    await client.query('COMMIT');
    console.log(
      JSON.stringify({
        recovered: true,
        sync_stream_rotated: true,
        revision: String(head.rows[0].revision),
        derived_exports_expired: expired.rowCount,
        interrupted_jobs_released: retry.rowCount,
      }),
    );
  } else throw new Error('Usage: database.ts migrate | provision | runtime-role | after-restore');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end();
}
