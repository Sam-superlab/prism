import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(process.env.PRISM_PGLITE_MODULE).href);
const db = new PGlite();
await db.exec(await readFile(new URL('../../database/schema.sql', import.meta.url), 'utf8'));
let checks = 0;
const ok = (v, label) => {
  assert.ok(v, label);
  checks++;
};
const id = (n) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const u = id(1),
  other = id(2),
  k = id(3),
  ko = id(4),
  cfg = id(5),
  card = id(6),
  c2 = id(7),
  dev = id(8);
async function fail(q, p, code, label) {
  let caught = false;
  try {
    await db.query(q, p);
  } catch (e) {
    caught = true;
    assert.equal(e.code, code, label + ': ' + e.message);
  }
  ok(caught, label);
}
await db.query(
  "INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,'one','one@test.invalid','One'),($2,'two','two@test.invalid','Two')",
  [u, other],
);
ok(
  (await db.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='prism'")).rows[0]
    .n === 42,
  '42 tables',
);
await db.query(
  "INSERT INTO knowledge_items(id,user_id,title,type) VALUES($1,$2,'Theorem','theorem'),($3,$4,'Secret','note')",
  [k, u, ko, other],
);
await db.exec(
  'CREATE ROLE prism_app_test;GRANT USAGE ON SCHEMA prism TO prism_app_test;GRANT SELECT ON ALL TABLES IN SCHEMA prism TO prism_app_test;SET ROLE prism_app_test;',
);
await db.query("SELECT set_config('app.user_id',$1,false)", [u]);
ok((await db.query('SELECT id FROM knowledge_items')).rows.length === 1, 'RLS isolates user');
await db.query("SELECT set_config('app.user_id','',false)");
ok((await db.query('SELECT id FROM knowledge_items')).rows.length === 0, 'RLS fails closed');
await db.exec('RESET ROLE');
await db.query(
  "INSERT INTO scheduler_configs(id,user_id,library_version,model_version,adapter_version,parameters,desired_retention) VALUES($1,$2,'fixture','fixture','1','{}',0.9)",
  [cfg, u],
);
await db.query("INSERT INTO devices(id,user_id,name,platform) VALUES($1,$2,'Phone','ios')", [dev, u]);
const cardq =
  "INSERT INTO review_cards(id,user_id,knowledge_item_id,card_type,prompt,answer,scheduler_config_id,fsrs_state,due_at) VALUES($1,$2,$3,'statement','Q','A',$4,'{}',now())";
await db.query(cardq, [card, u, k, cfg]);
await db.query(cardq, [c2, u, k, cfg]);
await fail(cardq, [id(9), u, ko, cfg], '23503', 'cross-owner FK');
const submitq =
  "INSERT INTO review_submissions(id,user_id,card_id,device_id,client_operation_id,rating,reviewed_at,duration_ms,base_version,payload,payload_hash) VALUES($1,$2,$3,$4,$5,'good',now(),1000,1,'{}','hash')";
await db.query(submitq, [id(10), u, card, dev, id(11)]);
await db.query(submitq, [id(12), u, card, dev, id(13)]);
const eventq =
  "INSERT INTO review_events(id,user_id,card_id,submission_id,rating,reviewed_at,effective_at,duration_ms,previous_state,resulting_state,scheduler_config_id,idempotency_key,card_version_before,card_version_after) VALUES($1,$2,$3,$4,'good',now(),now(),1000,'{}','{}',$5,$6,$7,$8)";
await db.query(eventq, [id(14), u, card, id(10), cfg, id(11), 1, 2]);
await fail(eventq, [id(15), u, card, id(12), cfg, id(11), 2, 3], '23505', 'permanent review key');
await fail(eventq, [id(16), u, c2, id(12), cfg, id(13), 1, 2], '23503', 'submission and event card agree');
await fail("UPDATE review_events SET rating='easy' WHERE id=$1", [id(14)], '23514', 'immutable review');
await fail('DELETE FROM review_submissions WHERE id=$1', [id(10)], '23514', 'immutable submissions');
await fail('DELETE FROM knowledge_items WHERE id=$1', [k], '23514', 'hard deletion blocked');
await db.query('UPDATE knowledge_items SET deleted_at=now(),version=version+1 WHERE id=$1', [k]);
ok((await db.query('SELECT id FROM review_events')).rows.length === 1, 'soft delete keeps history');
await db.query("UPDATE review_cards SET version=version+1,due_at=now()+interval '3 days' WHERE id=$1", [
  card,
]);
ok(
  (await db.query('SELECT version::text v FROM review_cards WHERE id=$1', [c2])).rows[0].v === '1',
  'independent card state',
);
await db.query("INSERT INTO research_projects(id,user_id,title) VALUES($1,$2,'Project')", [id(20), u]);
const claim =
  "INSERT INTO research_objects(id,user_id,project_id,object_type,title,claim_status,evidence_metadata) VALUES($1,$2,$3,'conjecture','Claim',$4,$5)";
await fail(claim, [id(21), u, id(20), 'computationally_verified', '{}'], '23514', 'evidence required');
await fail(
  claim,
  [id(21), u, id(20), 'computationally_verified', JSON.stringify({ scope: null, result: null })],
  '23514',
  'null evidence rejected',
);
await fail(claim, [id(21), u, id(20), 'proved', '{}'], '23514', 'proof required');
await db.query(claim, [id(21), u, id(20), 'conjecture', '{}']);
await db.query(
  "INSERT INTO tasks(id,user_id,project_id,research_object_id,source_type,title,estimated_minutes) VALUES($1,$2,$3,$4,'research','Task',30)",
  [id(22), u, id(20), id(21)],
);
await db.query("UPDATE tasks SET status='completed',completed_at=now(),version=version+1 WHERE id=$1", [
  id(22),
]);
ok(
  (await db.query('SELECT claim_status FROM research_objects WHERE id=$1', [id(21)])).rows[0].claim_status ===
    'conjecture',
  'task does not prove claim',
);
await db.query(
  "INSERT INTO exercises(id,user_id,name,exercise_type,measurement_unit) VALUES($1,$2,'Bench','strength','kg')",
  [id(30), u],
);
await db.query(
  "INSERT INTO workout_templates(id,user_id,title,activity_type) VALUES($1,$2,'Upper','strength')",
  [id(31), u],
);
await db.query(
  "INSERT INTO workout_sessions(id,user_id,template_id,template_snapshot,started_at,ended_at,status) VALUES($1,$2,$3,$4,now(),now(),'completed')",
  [id(32), u, id(31), JSON.stringify({ title: 'Upper' })],
);
await db.query(
  "INSERT INTO workout_session_exercises(id,user_id,session_id,exercise_id,name_snapshot,position) VALUES($1,$2,$3,$4,'Bench',0)",
  [id(33), u, id(32), id(30)],
);
const setq =
  "INSERT INTO workout_sets(id,user_id,session_id,session_exercise_id,exercise_id,set_order,entered_weight,entered_weight_unit,reps,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,'lb',$8,now())";
await db.query(setq, [id(34), u, id(32), id(33), id(30), 0, 100, 5]);
ok(
  Math.abs(
    Number((await db.query('SELECT weight_kg::text w FROM workout_sets WHERE id=$1', [id(34)])).rows[0].w) -
      45.359237,
  ) < 1e-8,
  'lb normalized',
);
await db.query(setq, [id(35), u, id(32), id(33), id(30), 1, null, 10]);
ok(
  (await db.query('SELECT weight_kg FROM workout_sets WHERE id=$1', [id(35)])).rows[0].weight_kg === null,
  'unknown external load kept null',
);
await fail(setq, [id(36), u, id(32), id(33), id(30), 2, 50, 0], '23514', 'completed reps positive');
await db.query(
  "INSERT INTO cardio_entries(id,user_id,session_id,activity_type,duration_seconds,distance,distance_unit) VALUES($1,$2,$3,'Run',600,1,'mi')",
  [id(37), u, id(32)],
);
ok(
  Number(
    (await db.query('SELECT distance_meters::text m FROM cardio_entries WHERE id=$1', [id(37)])).rows[0].m,
  ) === 1609.344,
  'miles normalized',
);
await db.query('UPDATE cardio_entries SET distance=2 WHERE id=$1', [id(37)]);
ok(
  Number(
    (await db.query('SELECT distance_meters::text m FROM cardio_entries WHERE id=$1', [id(37)])).rows[0].m,
  ) === 3218.688,
  'normalized distance recalculates',
);
await db.query("UPDATE workout_templates SET deleted_at=now(),title='Changed' WHERE id=$1", [id(31)]);
ok(
  (await db.query("SELECT template_snapshot->>'title' t FROM workout_sessions WHERE id=$1", [id(32)])).rows[0]
    .t === 'Upper',
  'template snapshot preserved',
);
await db.query('INSERT INTO user_sync_state(id,user_id) VALUES($1,$2)', [id(40), u]);
await db.exec('BEGIN');
await db.query('UPDATE user_sync_state SET revision=1 WHERE user_id=$1', [u]);
await db.query("INSERT INTO sync_change_batches(id,user_id,revision,changes) VALUES($1,$2,1,'[]')", [
  id(41),
  u,
]);
await db.exec('ROLLBACK');
ok(
  (await db.query('SELECT revision::text r FROM user_sync_state WHERE user_id=$1', [u])).rows[0].r === '0',
  'revision rollback atomic',
);
ok((await db.query('SELECT * FROM sync_change_batches')).rows.length === 0, 'batch rollback atomic');
await db.query(
  "INSERT INTO sync_operations(id,user_id,device_id,client_operation_id,entity_type,entity_id,operation_type,payload,payload_hash,status,result) VALUES($1,$2,$3,$4,'task',$5,'task.complete','{}','hash','applied','{}')",
  [id(42), u, dev, id(43), id(22)],
);
await fail(
  'UPDATE sync_operations SET result=\'{"changed":true}\' WHERE id=$1',
  [id(42)],
  '23514',
  'terminal receipt immutable',
);
const paperq =
  "INSERT INTO arxiv_papers(id,arxiv_id,latest_version,title,authors,categories,published_at,updated_at,source_url,pdf_url) VALUES($1,'math/0309136',1,'Paper',ARRAY['Author'],ARRAY['math.AC'],now(),now(),'https://arxiv.org/abs/math/0309136','https://arxiv.org/pdf/math/0309136')";
await db.query(paperq, [id(50)]);
await fail(paperq, [id(51)], '23505', 'legacy arxiv ID dedup');
await db.query("INSERT INTO user_papers(id,user_id,paper_id,status,is_saved) VALUES($1,$2,$3,'read',true)", [
  id(52),
  u,
  id(50),
]);
ok(
  (await db.query("SELECT is_saved AND status='read' ok FROM user_papers")).rows[0].ok,
  'saved and read coexist',
);
console.log(
  JSON.stringify({
    status: 'passed',
    engine: 'PGlite PostgreSQL WASM',
    checks,
    tables: 42,
    limitation: 'No multi-connection concurrency or application handler tests',
  }),
);
await db.close();
