/** Restores a populated, disposable test database. Never restores over an existing database. */
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve, join } from 'node:path';
import { createTestPostgres } from '../apps/api/src/testing';
import { buildApp } from '../apps/api/src/app';
import { loadConfig } from '../apps/api/src/config';
import { createDatabase } from '../packages/database/src/index';

const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const { Pool } = require('pg');
const container = process.env.PRISM_TEST_POSTGRES_CONTAINER ?? 'prism-test-postgres';
const fixture = await createTestPostgres();
const target = `prism_restore_${randomUUID().replaceAll('-', '')}`;
const dataDir = await mkdtemp(join(tmpdir(), 'prism-recovery-source-'));
const restoredDataDir = await mkdtemp(join(tmpdir(), 'prism-recovery-target-'));
const config = loadConfig({
  PRISM_DATA_DIR: dataDir,
  PRISM_AUTH_MODE: 'development',
  PRISM_USER_ID: fixture.userId,
  PRISM_ALLOWED_SUBJECT: fixture.subject,
});
const app = await buildApp({ db: fixture.db, config });
let restored: InstanceType<typeof Pool> | undefined;
let restoredRuntime: Awaited<ReturnType<typeof createDatabase>> | undefined;
let restoredApp: Awaited<ReturnType<typeof buildApp>> | undefined;
const post = async (path: string, body: unknown, version?: string, key = randomUUID()) => {
  const r = await app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: {
      'Idempotency-Key': key,
      ...(version ? { 'If-Match': `"${version}"` } : {}),
    },
    payload: body as never,
  });
  if (r.statusCode >= 300) throw new Error(`Fixture creation failed: ${path} ${r.statusCode} ${r.body}`);
  return r.json();
};
async function child(command: string[], input?: string, output?: string) {
  const p = spawn('docker', ['exec', ...(input ? ['-i'] : []), container, ...command], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let error = '';
  p.stderr.on('data', (chunk) => {
    error += String(chunk);
  });
  const done = new Promise<void>((yes, no) => {
    p.once('error', no);
    p.once('exit', (code) =>
      code === 0 ? yes() : no(new Error(error || `Docker database command exited ${code}`)),
    );
  });
  if (input) await pipeline(createReadStream(input), p.stdin);
  else p.stdin.end();
  if (output) await pipeline(p.stdout, createWriteStream(output, { mode: 0o600 }));
  else p.stdout.resume();
  await done;
}
async function recoveryCommand(ownerUrl: string, userId: string) {
  const process = spawn(
    globalThis.process.execPath,
    [require.resolve('tsx/cli'), resolve('scripts/database.ts'), 'after-restore'],
    {
      env: { ...globalThis.process.env, MIGRATION_DATABASE_URL: ownerUrl, PRISM_USER_ID: userId },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  process.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  process.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exitCode = await new Promise<number>((yes, no) => {
    process.once('error', no);
    process.once('close', (code) => yes(code ?? -1));
  });
  return { exit_code: exitCode, stdout, stderr };
}
try {
  const note = await post('/knowledge-items', {
    id: randomUUID(),
    title: 'Restore verification theorem',
    type: 'theorem',
    content: 'M / IM = 0 under the stated hypotheses.',
  });
  const card = await post(`/knowledge-items/${note.id}/cards`, {
    id: randomUUID(),
    card_type: 'statement',
    prompt: 'Recall',
    answer: note.content,
  });
  const phone = await post('/devices', { id: randomUUID(), name: 'Restore test phone', platform: 'ios' });
  const key = randomUUID();
  await post(
    '/review/events',
    {
      card_id: card.id,
      device_id: phone.id,
      rating: 'good',
      reviewed_at: new Date().toISOString(),
      duration_ms: 1000,
      base_version: card.version,
      idempotency_key: key,
    },
    undefined,
    key,
  );
  const project = await post('/research/projects', { id: randomUUID(), title: 'Restore research' });
  await post(`/research/projects/${project.id}/objects`, {
    id: randomUUID(),
    object_type: 'conjecture',
    title: 'Claim audit',
    content: 'To be investigated.',
    claim_status: 'conjecture',
  });
  const exercise = await post('/fitness/exercises', {
    id: randomUUID(),
    name: 'Restore bench',
    exercise_type: 'strength',
    measurement_unit: 'kg',
  });
  const session = await post('/fitness/sessions', { id: randomUUID(), started_at: new Date().toISOString() });
  const actual = await post(`/fitness/sessions/${session.id}/exercises`, {
    id: randomUUID(),
    exercise_id: exercise.id,
    position: 0,
  });
  await post(`/fitness/sessions/${session.id}/sets`, {
    id: randomUUID(),
    session_exercise_id: actual.id,
    set_order: 0,
    entered_weight: 100,
    entered_weight_unit: 'lb',
    reps: 5,
    completed_at: new Date().toISOString(),
  });
  // Derived files deliberately will not be copied to the restored application's directory.
  const readyExport = await post('/exports', { formats: ['json'] });
  await app.prism.service.processExports();
  const readyState = (await app.inject({ method: 'GET', url: `/api/v1/exports/${readyExport.id}` })).json();
  if (readyState.status !== 'ready') throw new Error('Ready export fixture failed');
  const pendingExport = await post('/exports', { formats: ['json'] });
  const runningExport = await post('/exports', { formats: ['json'] });
  const staleRunId = randomUUID();
  await fixture.admin.query("UPDATE prism.exports SET status='running' WHERE id=$1", [runningExport.id]);
  await fixture.admin.query(
    "UPDATE prism.automation_jobs SET status='running',attempts=2,lease_expires_at=now()+interval '1 day',payload=$3::jsonb WHERE user_id=$1 AND idempotency_key=$2",
    [
      config.userId,
      'export:' + runningExport.id,
      JSON.stringify({ export_id: runningExport.id, run_id: staleRunId }),
    ],
  );
  const interruptedJob = randomUUID(),
    exhaustedJob = randomUUID(),
    completedJob = randomUUID();
  for (const [id, type, attempts, status] of [
    [interruptedJob, 'arxiv_ingest', 2, 'running'],
    [exhaustedJob, 'digest', 5, 'running'],
    [completedJob, 'plan', 1, 'succeeded'],
  ] as const) {
    await fixture.admin.query(
      "INSERT INTO prism.automation_jobs(id,user_id,job_type,scheduled_at,status,attempts,lease_expires_at,idempotency_key,payload) VALUES($1,$2,$3,now(),$4,$5,CASE WHEN $4='running' THEN now()+interval '1 day' ELSE NULL END,$6,'{}')",
      [id, config.userId, type, status, attempts, 'recovery-fixture:' + id],
    );
  }
  const oldSnapshot = await post('/sync/snapshots', { device_id: phone.id });
  const oldPage = (
    await app.inject({ method: 'GET', url: `/api/v1/sync/snapshots/${oldSnapshot.id}/records` })
  ).json();
  const source = new URL(fixture.url).pathname.slice(1);
  const tables = (
    await fixture.admin.query("SELECT tablename FROM pg_tables WHERE schemaname='prism' ORDER BY tablename")
  ).rows.map((r: { tablename: string }) => r.tablename);
  const fingerprint = async (db: InstanceType<typeof Pool>) => {
    const result: Record<string, { count: number; sha256: string }> = {};
    for (const name of tables) {
      const rows = (await db.query(`SELECT to_jsonb(t) value FROM prism.${name} t ORDER BY value`)).rows.map(
        (r: { value: unknown }) => r.value,
      );
      result[name] = {
        count: rows.length,
        sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      };
    }
    return result;
  };
  const before = await fingerprint(fixture.admin),
    started = Date.now();
  await mkdir('.data/backups', { recursive: true });
  const dump = resolve('.data/backups', `${source}.dump`);
  await child(
    ['pg_dump', '-U', 'prism_admin', '-d', source, '--format=custom', '--no-owner'],
    undefined,
    dump,
  );
  await fixture.admin.query(`CREATE DATABASE ${target}`);
  await child(['pg_restore', '-U', 'prism_admin', '-d', target, '--exit-on-error', '--no-owner'], dump);
  const raw = await import('node:fs/promises').then((fs) => fs.readFile('.data/test-postgres.env', 'utf8'));
  const owner = new URL(
    raw
      .split('\n')
      .find((x) => x.startsWith('PRISM_TEST_ADMIN_DATABASE_URL='))!
      .split('=')
      .slice(1)
      .join('='),
  );
  owner.pathname = `/${target}`;
  restored = new Pool({ connectionString: owner.toString() });
  const after = await fingerprint(restored);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Restored record counts or hashes differ');
  const runtimeUrl = new URL(fixture.url);
  runtimeUrl.pathname = `/${target}`;
  restoredRuntime = await createDatabase({ url: runtimeUrl.toString(), production: true });
  restoredApp = await buildApp({ db: restoredRuntime, config: { ...config, dataDir: restoredDataDir } });
  // Exercise the operator's actual CLI as a separate process with only this disposable target URL.
  const recovery = await recoveryCommand(owner.toString(), config.userId);
  if (recovery.exit_code !== 0) throw new Error(`Recovery command failed: ${recovery.stderr}`);
  const commandSummary = JSON.parse(recovery.stdout.trim().split('\n').at(-1)!);
  if (
    !commandSummary.recovered ||
    !commandSummary.sync_stream_rotated ||
    commandSummary.derived_exports_expired !== 3 ||
    commandSummary.interrupted_jobs_released !== 2
  )
    throw new Error('Recovery CLI summary did not match seeded derived work');
  const recovered = await fingerprint(restored);
  const allowedChanges = new Set(['user_sync_state', 'exports', 'automation_jobs']);
  for (const name of tables)
    if (!allowedChanges.has(name) && JSON.stringify(after[name]) !== JSON.stringify(recovered[name]))
      throw new Error(`Recovery command changed non-derived records: ${name}`);
  const oldHead = (
    await fixture.admin.query(
      'SELECT id,revision::text revision FROM prism.user_sync_state WHERE user_id=$1',
      [config.userId],
    )
  ).rows[0];
  const newHead = (
    await restored.query('SELECT id,revision::text revision FROM prism.user_sync_state WHERE user_id=$1', [
      config.userId,
    ])
  ).rows[0];
  if (oldHead.id === newHead.id || oldHead.revision !== newHead.revision)
    throw new Error('Recovery did not rotate only the synchronization generation');
  const exportsState = (
    await restored.query('SELECT id,status FROM prism.exports WHERE user_id=$1', [config.userId])
  ).rows;
  if (
    [readyExport.id, pendingExport.id, runningExport.id].some(
      (id) =>
        !exportsState.some(
          (row: { id: string; status: string }) => row.id === id && row.status === 'expired',
        ),
    )
  )
    throw new Error('Recovery left a stale derived export available');
  const jobs = (await restored.query('SELECT * FROM prism.automation_jobs WHERE user_id=$1', [config.userId]))
    .rows;
  const runningExportJob = jobs.find(
    (row: { idempotency_key: string }) => row.idempotency_key === 'export:' + runningExport.id,
  );
  if (
    !runningExportJob ||
    runningExportJob.status !== 'dead' ||
    runningExportJob.lease_expires_at !== null ||
    runningExportJob.payload.run_id !== undefined
  )
    throw new Error('Abandoned export lease was not invalidated and fenced');
  const interrupted = jobs.find((row: { id: string }) => row.id === interruptedJob),
    exhausted = jobs.find((row: { id: string }) => row.id === exhaustedJob),
    completed = jobs.find((row: { id: string }) => row.id === completedJob);
  if (interrupted?.status !== 'failed' || interrupted.lease_expires_at !== null || interrupted.attempts !== 2)
    throw new Error('Retryable interrupted job was not released');
  if (exhausted?.status !== 'dead' || exhausted.lease_expires_at !== null || exhausted.attempts !== 5)
    throw new Error('Exhausted job regained attempts');
  if (completed?.status !== 'succeeded') throw new Error('Completed job history was altered');
  for (const id of [readyExport.id, pendingExport.id, runningExport.id]) {
    const download = await restoredApp.inject({ method: 'GET', url: `/api/v1/exports/${id}/download` });
    if (download.statusCode !== 410)
      throw new Error('Missing pre-restore generated export was not rejected as expired');
  }
  const beforeInvalidAccount = await fingerprint(restored);
  const invalidAccount = await recoveryCommand(owner.toString(), randomUUID());
  if (
    invalidAccount.exit_code === 0 ||
    JSON.stringify(beforeInvalidAccount) !== JSON.stringify(await fingerprint(restored))
  )
    throw new Error('Failed recovery command did not roll back atomically');
  const oldPull = await restoredApp.inject({
    method: 'GET',
    url: `/api/v1/sync/pull?cursor=${encodeURIComponent(oldPage.resume_sync_cursor)}`,
  });
  if (oldPull.statusCode !== 410 || oldPull.json().error.details.reason !== 'STREAM_RESET')
    throw new Error('Old cursor was not rejected after stream rotation');
  const oldResume = await restoredApp.inject({
    method: 'GET',
    url: `/api/v1/sync/snapshots/${oldSnapshot.id}/records`,
  });
  if (oldResume.statusCode !== 410) throw new Error('A snapshot from the old stream remained usable');
  const fresh = await restoredApp.inject({
    method: 'POST',
    url: '/api/v1/sync/snapshots',
    headers: { 'Idempotency-Key': randomUUID() },
    payload: { device_id: phone.id },
  });
  if (fresh.statusCode !== 201) throw new Error('Fresh snapshot after recovery failed');
  const freshPage = (
    await restoredApp.inject({ method: 'GET', url: `/api/v1/sync/snapshots/${fresh.json().id}/records` })
  ).json();
  const freshPull = await restoredApp.inject({
    method: 'GET',
    url: `/api/v1/sync/pull?cursor=${encodeURIComponent(freshPage.resume_sync_cursor)}`,
  });
  if (freshPull.statusCode !== 200) throw new Error('Fresh stream did not resume after recovery');
  await restoredApp.prism.service.processExports();
  if (
    (
      await restored.query(
        "SELECT count(*)::int count FROM prism.exports WHERE user_id=$1 AND status='ready'",
        [config.userId],
      )
    ).rows[0].count !== 0
  )
    throw new Error('Old derived export was restarted after recovery');
  const recoveryReport = {
    executed_at: new Date().toISOString(),
    result: 'passed',
    command: 'tsx scripts/database.ts after-restore',
    execution: 'separate Node process against the restored disposable PostgreSQL fixture',
    command_exit_code: recovery.exit_code,
    command_summary: commandSummary,
    checks: [
      'All table counts and row hashes equal before recovery command',
      'Only synchronization head and derived export/job metadata changed',
      'Synchronization generation rotated without changing revision or business IDs',
      'Pending, running and ready exports expired',
      'Missing pre-restore export downloads return 410 rather than server errors',
      'Abandoned export jobs dead with leases cleared and run tokens revoked',
      'Retryable interrupted jobs released without resetting attempts',
      'Exhausted jobs remain dead; succeeded job history unchanged',
      'Unknown-account command fails and rolls back atomically',
      'Old signed cursor and cached snapshot rejected; fresh snapshot/pull succeed',
      'Export processor does not restart invalidated derived work',
    ],
    privacy:
      'Only generated test data in uniquely named disposable databases; credentials passed through environment and omitted from this report',
  };
  await mkdir('docs/verification', { recursive: true });
  await writeFile('docs/verification/recovery-command.json', JSON.stringify(recoveryReport, null, 2) + '\n');

  const report = {
    executed_at: new Date().toISOString(),
    result: 'passed',
    source: 'disposable PostgreSQL 17 test fixture',
    restored_tables: tables.length,
    elapsed_ms: Date.now() - started,
    populated_tables: Object.entries(before)
      .filter(([, v]) => v.count > 0)
      .map(([name]) => name),
    checks: [
      'All table counts and row hashes equal',
      'Immutable review history restored',
      'FSRS state restored',
      'Research audit restored',
      'Generated weight columns restored',
      'Old valid signed cursor rejected after generation reset',
      'Old snapshot resume rejected after restore',
      'Actual after-restore operator command executed and derived work invalidated',
    ],
    limitation:
      'Local database restore only; production object storage, secret recovery and offsite encrypted backups require deployment configuration',
  };
  await mkdir('docs/verification', { recursive: true });
  await writeFile('docs/verification/backup-restore.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await restoredApp?.close();
  await restoredRuntime?.close();
  await restored?.end();
  await app.close();
  await fixture.admin.query(`DROP DATABASE IF EXISTS ${target}`);
  await fixture.cleanup();
}
