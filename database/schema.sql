-- PRISM MVP PostgreSQL 16+ schema. Migration owner applies to an empty database.
BEGIN;
CREATE SCHEMA prism;
SET search_path=prism,public;
CREATE FUNCTION principal() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('app.user_id',true),'')::uuid
$$;
CREATE FUNCTION protect_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable history' USING ERRCODE='23514'; END;
$$;
CREATE TABLE users(
 id uuid PRIMARY KEY,oidc_subject text NOT NULL UNIQUE,email text NOT NULL,display_name text NOT NULL,
 timezone text NOT NULL DEFAULT 'Europe/Budapest',version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz
);
CREATE UNIQUE INDEX users_email_unique ON users(lower(email));
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON users USING(id=principal()) WITH CHECK(id=principal());


CREATE TABLE user_preferences(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,UNIQUE(user_id),desired_retention numeric NOT NULL DEFAULT .9 CHECK(desired_retention BETWEEN .7 AND .99),
daily_review_limit integer NOT NULL DEFAULT 100 CHECK(daily_review_limit BETWEEN 0 AND 1000),
default_study_capacity_minutes integer NOT NULL DEFAULT 180 CHECK(default_study_capacity_minutes BETWEEN 0 AND 1440),
notification_preferences jsonb NOT NULL DEFAULT '{"push_enabled":false,"quiet_start":"22:00","quiet_end":"08:00"}',
digest_preferences jsonb NOT NULL DEFAULT '{"enabled":true,"time":"08:00"}');

CREATE TABLE devices(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,name text NOT NULL,platform text NOT NULL CHECK(platform IN('web','ios')),push_token_ciphertext text,last_seen_at timestamptz,last_ack_revision bigint NOT NULL DEFAULT 0);

CREATE TABLE scheduler_configs(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),library_version text NOT NULL,model_version text NOT NULL,adapter_version text NOT NULL,parameters jsonb NOT NULL CHECK(jsonb_typeof(parameters)='object'),desired_retention numeric NOT NULL CHECK(desired_retention BETWEEN .7 AND .99),fuzz_enabled boolean NOT NULL DEFAULT false);

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON scheduler_configs FOR EACH ROW EXECUTE FUNCTION protect_history();

CREATE TABLE knowledge_items(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,title text NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
type text NOT NULL CHECK(type IN('definition','theorem','lemma','proposition','corollary','proof','example','counterexample','exercise','note')),
subject text NOT NULL DEFAULT '',tags text[] NOT NULL DEFAULT '{}',content text NOT NULL DEFAULT '',proof_content text,source_reference text,
verification_status text NOT NULL DEFAULT 'unverified' CHECK(verification_status IN('unverified','user_verified','source_verified')));

CREATE TABLE knowledge_relations(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,source_item_id uuid NOT NULL,target_item_id uuid NOT NULL,relation_type text NOT NULL CHECK(relation_type IN('related','depends_on','example_of','proof_of')),CHECK(source_item_id<>target_item_id),FOREIGN KEY(user_id,source_item_id) REFERENCES knowledge_items(user_id,id),FOREIGN KEY(user_id,target_item_id) REFERENCES knowledge_items(user_id,id));

CREATE TABLE review_cards(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,knowledge_item_id uuid NOT NULL,card_type text NOT NULL CHECK(card_type IN('statement','hypotheses','proof','example','counterexample','application','custom')),prompt text NOT NULL,answer text NOT NULL,suspended boolean NOT NULL DEFAULT false,
scheduler_config_id uuid NOT NULL,fsrs_state jsonb NOT NULL CHECK(jsonb_typeof(fsrs_state)='object'),due_at timestamptz NOT NULL,
last_reviewed_at timestamptz,review_count integer NOT NULL DEFAULT 0 CHECK(review_count>=0),lapse_count integer NOT NULL DEFAULT 0 CHECK(lapse_count>=0),FOREIGN KEY(user_id,knowledge_item_id) REFERENCES knowledge_items(user_id,id),FOREIGN KEY(user_id,scheduler_config_id) REFERENCES scheduler_configs(user_id,id));

CREATE TABLE research_projects(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,title text NOT NULL,description text NOT NULL DEFAULT '',research_area text NOT NULL DEFAULT '',
status text NOT NULL DEFAULT 'active' CHECK(status IN('active','paused','completed','archived')),importance integer NOT NULL DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),
started_at date,deadline timestamptz,source_code_locations text[] NOT NULL DEFAULT '{}',notes text NOT NULL DEFAULT '');

CREATE TABLE research_objects(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,project_id uuid NOT NULL,object_type text NOT NULL CHECK(object_type IN('question','conjecture','theorem','lemma','proof_attempt','counterexample','experiment','observation','literature_note')),
title text NOT NULL,content text NOT NULL DEFAULT '',claim_status text NOT NULL DEFAULT 'needs_verification' CHECK(claim_status IN('conjecture','computationally_verified','proved','disproved','needs_verification')),
proof_content text,evidence_reference text,evidence_metadata jsonb NOT NULL DEFAULT '{}',UNIQUE(user_id,project_id,id),
CHECK(claim_status<>'computationally_verified' OR (coalesce(length(btrim(evidence_metadata->>'scope')),0)>0 AND coalesce(length(btrim(evidence_metadata->>'result')),0)>0)),
CHECK(claim_status<>'proved' OR coalesce(length(btrim(proof_content)),0)>0 OR coalesce(length(btrim(evidence_reference)),0)>0),FOREIGN KEY(user_id,project_id) REFERENCES research_projects(user_id,id));

CREATE TABLE research_events(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),project_id uuid NOT NULL,object_id uuid,event_type text NOT NULL,event_payload jsonb NOT NULL,FOREIGN KEY(user_id,project_id,object_id) REFERENCES research_objects(user_id,project_id,id),FOREIGN KEY(user_id,project_id) REFERENCES research_projects(user_id,id));

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON research_events FOR EACH ROW EXECUTE FUNCTION protect_history();

CREATE TABLE research_knowledge_links(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,research_object_id uuid NOT NULL,knowledge_item_id uuid NOT NULL,FOREIGN KEY(user_id,research_object_id) REFERENCES research_objects(user_id,id),FOREIGN KEY(user_id,knowledge_item_id) REFERENCES knowledge_items(user_id,id));

CREATE TABLE exercises(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,name text NOT NULL,exercise_type text NOT NULL CHECK(exercise_type IN('strength','cardio','recovery')),measurement_unit text NOT NULL CHECK(measurement_unit IN('kg','lb','bodyweight','seconds','meters')));

CREATE TABLE workout_templates(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,title text NOT NULL,activity_type text NOT NULL CHECK(activity_type IN('strength','cardio','recovery')));

CREATE TABLE workout_template_exercises(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,template_id uuid NOT NULL,exercise_id uuid NOT NULL,position integer NOT NULL CHECK(position>=0),target_sets integer NOT NULL CHECK(target_sets BETWEEN 1 AND 100),target_reps integer CHECK(target_reps BETWEEN 0 AND 10000),target_weight_kg numeric CHECK(target_weight_kg>=0),rest_seconds integer CHECK(rest_seconds BETWEEN 0 AND 3600),FOREIGN KEY(user_id,template_id) REFERENCES workout_templates(user_id,id),FOREIGN KEY(user_id,exercise_id) REFERENCES exercises(user_id,id));

CREATE TABLE workout_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,template_id uuid,template_snapshot jsonb NOT NULL DEFAULT '{}',started_at timestamptz NOT NULL,ended_at timestamptz,status text NOT NULL DEFAULT 'in_progress' CHECK(status IN('in_progress','completed','cancelled')),notes text NOT NULL DEFAULT '',CHECK(ended_at IS NULL OR ended_at>=started_at),CHECK(status<>'completed' OR ended_at IS NOT NULL),FOREIGN KEY(user_id,template_id) REFERENCES workout_templates(user_id,id));

CREATE TABLE workout_session_exercises(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,session_id uuid NOT NULL,exercise_id uuid NOT NULL,name_snapshot text NOT NULL,position integer NOT NULL CHECK(position>=0),UNIQUE(user_id,session_id,exercise_id,id),FOREIGN KEY(user_id,session_id) REFERENCES workout_sessions(user_id,id),FOREIGN KEY(user_id,exercise_id) REFERENCES exercises(user_id,id));

CREATE TABLE workout_sets(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,session_id uuid NOT NULL,session_exercise_id uuid NOT NULL,exercise_id uuid NOT NULL,set_order integer NOT NULL CHECK(set_order>=0),
entered_weight numeric CHECK(entered_weight>=0),entered_weight_unit text NOT NULL CHECK(entered_weight_unit IN('kg','lb')),
weight_kg numeric GENERATED ALWAYS AS(CASE entered_weight_unit WHEN 'lb' THEN entered_weight*0.45359237 ELSE entered_weight END) STORED,
reps integer NOT NULL CHECK(reps BETWEEN 0 AND 10000),rpe numeric CHECK(rpe BETWEEN 0 AND 10),rir numeric CHECK(rir BETWEEN 0 AND 20),completed_at timestamptz,
CHECK(completed_at IS NULL OR reps>0),FOREIGN KEY(user_id,session_id,exercise_id,session_exercise_id) REFERENCES workout_session_exercises(user_id,session_id,exercise_id,id),FOREIGN KEY(user_id,session_id) REFERENCES workout_sessions(user_id,id));

CREATE TABLE cardio_entries(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,session_id uuid NOT NULL,activity_type text NOT NULL,duration_seconds integer NOT NULL CHECK(duration_seconds>0),distance_meters numeric GENERATED ALWAYS AS(CASE distance_unit WHEN 'km' THEN distance*1000 WHEN 'mi' THEN distance*1609.344 ELSE distance END) STORED,distance numeric NOT NULL CHECK(distance>=0),distance_unit text NOT NULL CHECK(distance_unit IN('m','km','mi')),average_heart_rate integer CHECK(average_heart_rate BETWEEN 20 AND 300),perceived_intensity integer CHECK(perceived_intensity BETWEEN 1 AND 10),FOREIGN KEY(user_id,session_id) REFERENCES workout_sessions(user_id,id));

CREATE TABLE arxiv_papers(id uuid PRIMARY KEY,arxiv_id text NOT NULL UNIQUE,latest_version integer NOT NULL CHECK(latest_version>0),
title text NOT NULL,abstract text NOT NULL DEFAULT '',authors text[] NOT NULL,categories text[] NOT NULL,published_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
ingested_at timestamptz NOT NULL DEFAULT now(),source_url text NOT NULL CHECK(source_url LIKE 'https://arxiv.org/abs/%'),pdf_url text NOT NULL CHECK(pdf_url LIKE 'https://arxiv.org/pdf/%'));
CREATE TABLE arxiv_paper_versions(id uuid PRIMARY KEY,paper_id uuid NOT NULL REFERENCES arxiv_papers(id),version integer NOT NULL CHECK(version>0),
updated_at timestamptz NOT NULL,metadata_snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(paper_id,version));
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON arxiv_paper_versions FOR EACH ROW EXECUTE FUNCTION protect_history();

CREATE TABLE arxiv_subscriptions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,subscription_type text NOT NULL CHECK(subscription_type IN('category','keyword','author','topic')),subscription_value text NOT NULL,enabled boolean NOT NULL DEFAULT true,weight integer NOT NULL DEFAULT 1 CHECK(weight BETWEEN 1 AND 10));

CREATE TABLE user_papers(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,paper_id uuid NOT NULL REFERENCES arxiv_papers(id),status text NOT NULL DEFAULT 'unread' CHECK(status IN('unread','read','not_relevant')),is_saved boolean NOT NULL DEFAULT false,saved_at timestamptz,read_at timestamptz,relevance_score numeric NOT NULL DEFAULT 0,match_reasons jsonb NOT NULL DEFAULT '[]',UNIQUE(user_id,paper_id));

CREATE TABLE research_paper_links(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,project_id uuid NOT NULL,paper_id uuid NOT NULL REFERENCES arxiv_papers(id),FOREIGN KEY(user_id,project_id) REFERENCES research_projects(user_id,id));

CREATE TABLE tasks(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,project_id uuid,research_object_id uuid,user_paper_id uuid,workout_template_id uuid,
source_type text NOT NULL DEFAULT 'general' CHECK(source_type IN('general','research','reading','workout')),title text NOT NULL,description text NOT NULL DEFAULT '',
priority integer NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),status text NOT NULL DEFAULT 'ready' CHECK(status IN('backlog','ready','in_progress','blocked','completed','archived')),
due_at timestamptz,hard_deadline boolean NOT NULL DEFAULT false,planned_date date,estimated_minutes integer NOT NULL CHECK(estimated_minutes BETWEEN 1 AND 1440),
pinned boolean NOT NULL DEFAULT false,source_code_reference text,completed_at timestamptz,actual_minutes integer CHECK(actual_minutes>=0),
FOREIGN KEY(user_id,project_id,research_object_id) REFERENCES research_objects(user_id,project_id,id),
CHECK(research_object_id IS NULL OR project_id IS NOT NULL),
CHECK((source_type='general' AND num_nonnulls(research_object_id,user_paper_id,workout_template_id)=0) OR
(source_type='research' AND project_id IS NOT NULL AND user_paper_id IS NULL AND workout_template_id IS NULL) OR
(source_type='reading' AND user_paper_id IS NOT NULL AND research_object_id IS NULL AND workout_template_id IS NULL) OR
(source_type='workout' AND workout_template_id IS NOT NULL AND research_object_id IS NULL AND user_paper_id IS NULL)),
CHECK(NOT hard_deadline OR due_at IS NOT NULL),CHECK((status='completed')=(completed_at IS NOT NULL)),FOREIGN KEY(user_id,project_id) REFERENCES research_projects(user_id,id),FOREIGN KEY(user_id,user_paper_id) REFERENCES user_papers(user_id,id),FOREIGN KEY(user_id,workout_template_id) REFERENCES workout_templates(user_id,id));

ALTER TABLE workout_sessions ADD COLUMN planned_task_id uuid;ALTER TABLE workout_sessions ADD FOREIGN KEY(user_id,planned_task_id) REFERENCES tasks(user_id,id);

CREATE TABLE inbox_entries(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,content text NOT NULL,classified_task_id uuid,classified_knowledge_id uuid,CHECK(num_nonnulls(classified_task_id,classified_knowledge_id)<=1),FOREIGN KEY(user_id,classified_task_id) REFERENCES tasks(user_id,id),FOREIGN KEY(user_id,classified_knowledge_id) REFERENCES knowledge_items(user_id,id));

CREATE TABLE daily_plans(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,plan_date date NOT NULL,timezone text NOT NULL,capacity_minutes integer NOT NULL CHECK(capacity_minutes BETWEEN 0 AND 1440),generation_version text NOT NULL,input_hash text NOT NULL,overload_minutes integer NOT NULL DEFAULT 0 CHECK(overload_minutes>=0),UNIQUE(user_id,plan_date));

CREATE TABLE daily_plan_items(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,daily_plan_id uuid NOT NULL,task_id uuid,item_type text NOT NULL CHECK(item_type IN('task','review')),position integer NOT NULL CHECK(position>=0),title_snapshot text NOT NULL,scheduled_minutes integer NOT NULL CHECK(scheduled_minutes>0),status text NOT NULL DEFAULT 'planned' CHECK(status IN('planned','completed','skipped','deferred')),pinned boolean NOT NULL DEFAULT false,manually_placed boolean NOT NULL DEFAULT false,deferred_reason text,priority_reason text NOT NULL,UNIQUE(user_id,id,item_type),CHECK((item_type='task')=(task_id IS NOT NULL)),CHECK(status<>'deferred' OR coalesce(length(btrim(deferred_reason)),0)>0),FOREIGN KEY(user_id,daily_plan_id) REFERENCES daily_plans(user_id,id),FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id));

CREATE TABLE daily_plan_review_cards(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,plan_item_id uuid NOT NULL,card_id uuid NOT NULL,position integer NOT NULL CHECK(position>=0),item_type text NOT NULL DEFAULT 'review' CHECK(item_type='review'),FOREIGN KEY(user_id,plan_item_id,item_type) REFERENCES daily_plan_items(user_id,id,item_type),FOREIGN KEY(user_id,card_id) REFERENCES review_cards(user_id,id));

CREATE TABLE daily_shutdowns(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,daily_plan_id uuid NOT NULL,summary jsonb NOT NULL,note text NOT NULL DEFAULT '',UNIQUE(user_id,daily_plan_id),FOREIGN KEY(user_id,daily_plan_id) REFERENCES daily_plans(user_id,id));

CREATE TABLE review_submissions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),card_id uuid NOT NULL,device_id uuid NOT NULL,client_operation_id uuid NOT NULL,rating text NOT NULL CHECK(rating IN('again','hard','good','easy')),reviewed_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),duration_ms integer NOT NULL CHECK(duration_ms BETWEEN 0 AND 86400000),base_version bigint NOT NULL CHECK(base_version>0),depends_on_operation_id uuid,payload jsonb NOT NULL,payload_hash text NOT NULL,UNIQUE(user_id,client_operation_id),FOREIGN KEY(user_id,card_id) REFERENCES review_cards(user_id,id),FOREIGN KEY(user_id,device_id) REFERENCES devices(user_id,id));

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON review_submissions FOR EACH ROW EXECUTE FUNCTION protect_history();

CREATE TABLE review_events(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),card_id uuid NOT NULL,submission_id uuid NOT NULL,rating text NOT NULL CHECK(rating IN('again','hard','good','easy')),reviewed_at timestamptz NOT NULL,effective_at timestamptz NOT NULL,duration_ms integer NOT NULL CHECK(duration_ms BETWEEN 0 AND 86400000),previous_state jsonb NOT NULL,resulting_state jsonb NOT NULL,scheduler_config_id uuid NOT NULL,idempotency_key uuid NOT NULL,card_version_before bigint NOT NULL,card_version_after bigint NOT NULL,CHECK(card_version_after=card_version_before+1),UNIQUE(user_id,submission_id),UNIQUE(user_id,idempotency_key),UNIQUE(user_id,card_id,card_version_after),FOREIGN KEY(user_id,card_id) REFERENCES review_cards(user_id,id),FOREIGN KEY(user_id,submission_id) REFERENCES review_submissions(user_id,id),FOREIGN KEY(user_id,scheduler_config_id) REFERENCES scheduler_configs(user_id,id));

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON review_events FOR EACH ROW EXECUTE FUNCTION protect_history();

CREATE TABLE sync_conflicts(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,entity_type text NOT NULL,entity_id uuid NOT NULL,client_operation_id uuid NOT NULL,conflict_type text NOT NULL CHECK(conflict_type IN('version','clock','deleted','dependency')),base_payload jsonb,client_payload jsonb NOT NULL,server_payload jsonb NOT NULL,resolution text CHECK(resolution IN('keep_server','apply_client','merged','review_again')),resolved_at timestamptz,resolved_payload jsonb,UNIQUE(user_id,client_operation_id));

CREATE TABLE conflict_resolution_events(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),conflict_id uuid NOT NULL,client_operation_id uuid NOT NULL,resolution text NOT NULL,payload jsonb NOT NULL,UNIQUE(user_id,client_operation_id),FOREIGN KEY(user_id,conflict_id) REFERENCES sync_conflicts(user_id,id));

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON conflict_resolution_events FOR EACH ROW EXECUTE FUNCTION protect_history();

CREATE TABLE user_sync_state(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),min_available_revision bigint NOT NULL DEFAULT 0 CHECK(min_available_revision>=0),UNIQUE(user_id));

CREATE TABLE sync_change_batches(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),revision bigint NOT NULL CHECK(revision>0),changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='array'),operation_ids uuid[] NOT NULL DEFAULT '{}',UNIQUE(user_id,revision));

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON sync_change_batches FOR EACH ROW EXECUTE FUNCTION protect_history();

CREATE TABLE sync_operations(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,device_id uuid NOT NULL,client_operation_id uuid NOT NULL,entity_type text NOT NULL,entity_id uuid NOT NULL,operation_type text NOT NULL,payload jsonb NOT NULL,payload_hash text NOT NULL,status text NOT NULL CHECK(status IN('applied','conflict','rejected','blocked')),result jsonb NOT NULL,UNIQUE(user_id,client_operation_id),FOREIGN KEY(user_id,device_id) REFERENCES devices(user_id,id));

CREATE TABLE sync_snapshots(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,base_revision bigint NOT NULL CHECK(base_revision>=0),records jsonb NOT NULL CHECK(jsonb_typeof(records)='array'),schema_version text NOT NULL,expires_at timestamptz NOT NULL);

CREATE TABLE api_idempotency(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),idempotency_key uuid NOT NULL,method text NOT NULL,path text NOT NULL,request_hash text NOT NULL,response_status integer NOT NULL,response_body jsonb NOT NULL,UNIQUE(user_id,idempotency_key));

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON api_idempotency FOR EACH ROW EXECUTE FUNCTION protect_history();

CREATE TABLE automation_jobs(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,job_type text NOT NULL,scheduled_at timestamptz NOT NULL,started_at timestamptz,finished_at timestamptz,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','succeeded','failed','dead')),attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),lease_expires_at timestamptz,error_message text,idempotency_key text NOT NULL,payload jsonb NOT NULL DEFAULT '{}',UNIQUE(user_id,idempotency_key));

CREATE TABLE outbox_events(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,event_type text NOT NULL,payload jsonb NOT NULL,dedupe_key text NOT NULL,published_at timestamptz,lease_expires_at timestamptz,attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),UNIQUE(user_id,dedupe_key));

CREATE TABLE notification_events(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,notification_type text NOT NULL,payload jsonb NOT NULL,scheduled_at timestamptz NOT NULL,delivered_at timestamptz,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','delivered','failed','cancelled')),dedupe_key text NOT NULL,UNIQUE(user_id,dedupe_key));

CREATE TABLE exports(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version>0),deleted_at timestamptz,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','ready','failed','expired')),formats text[] NOT NULL CHECK(cardinality(formats)>0 AND formats <@ ARRAY['json','markdown']::text[]),object_key text,sha256 text,bytes bigint CHECK(bytes>=0),expires_at timestamptz,error_message text);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON user_preferences USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;ALTER TABLE devices FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON devices USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE scheduler_configs ENABLE ROW LEVEL SECURITY;ALTER TABLE scheduler_configs FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON scheduler_configs USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE knowledge_items ENABLE ROW LEVEL SECURITY;ALTER TABLE knowledge_items FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON knowledge_items USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE knowledge_relations ENABLE ROW LEVEL SECURITY;ALTER TABLE knowledge_relations FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON knowledge_relations USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE review_cards ENABLE ROW LEVEL SECURITY;ALTER TABLE review_cards FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON review_cards USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE research_projects ENABLE ROW LEVEL SECURITY;ALTER TABLE research_projects FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON research_projects USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE research_objects ENABLE ROW LEVEL SECURITY;ALTER TABLE research_objects FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON research_objects USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE research_events ENABLE ROW LEVEL SECURITY;ALTER TABLE research_events FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON research_events USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE research_knowledge_links ENABLE ROW LEVEL SECURITY;ALTER TABLE research_knowledge_links FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON research_knowledge_links USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE exercises ENABLE ROW LEVEL SECURITY;ALTER TABLE exercises FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON exercises USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE workout_templates ENABLE ROW LEVEL SECURITY;ALTER TABLE workout_templates FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON workout_templates USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE workout_template_exercises ENABLE ROW LEVEL SECURITY;ALTER TABLE workout_template_exercises FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON workout_template_exercises USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE workout_sessions ENABLE ROW LEVEL SECURITY;ALTER TABLE workout_sessions FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON workout_sessions USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE workout_session_exercises ENABLE ROW LEVEL SECURITY;ALTER TABLE workout_session_exercises FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON workout_session_exercises USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE workout_sets ENABLE ROW LEVEL SECURITY;ALTER TABLE workout_sets FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON workout_sets USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE cardio_entries ENABLE ROW LEVEL SECURITY;ALTER TABLE cardio_entries FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON cardio_entries USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE arxiv_subscriptions ENABLE ROW LEVEL SECURITY;ALTER TABLE arxiv_subscriptions FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON arxiv_subscriptions USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE user_papers ENABLE ROW LEVEL SECURITY;ALTER TABLE user_papers FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON user_papers USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE research_paper_links ENABLE ROW LEVEL SECURITY;ALTER TABLE research_paper_links FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON research_paper_links USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;ALTER TABLE tasks FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON tasks USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE inbox_entries ENABLE ROW LEVEL SECURITY;ALTER TABLE inbox_entries FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON inbox_entries USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE daily_plans ENABLE ROW LEVEL SECURITY;ALTER TABLE daily_plans FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON daily_plans USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE daily_plan_items ENABLE ROW LEVEL SECURITY;ALTER TABLE daily_plan_items FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON daily_plan_items USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE daily_plan_review_cards ENABLE ROW LEVEL SECURITY;ALTER TABLE daily_plan_review_cards FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON daily_plan_review_cards USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE daily_shutdowns ENABLE ROW LEVEL SECURITY;ALTER TABLE daily_shutdowns FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON daily_shutdowns USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE review_submissions ENABLE ROW LEVEL SECURITY;ALTER TABLE review_submissions FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON review_submissions USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE review_events ENABLE ROW LEVEL SECURITY;ALTER TABLE review_events FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON review_events USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE sync_conflicts ENABLE ROW LEVEL SECURITY;ALTER TABLE sync_conflicts FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON sync_conflicts USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE conflict_resolution_events ENABLE ROW LEVEL SECURITY;ALTER TABLE conflict_resolution_events FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON conflict_resolution_events USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE user_sync_state ENABLE ROW LEVEL SECURITY;ALTER TABLE user_sync_state FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON user_sync_state USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE sync_change_batches ENABLE ROW LEVEL SECURITY;ALTER TABLE sync_change_batches FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON sync_change_batches USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE sync_operations ENABLE ROW LEVEL SECURITY;ALTER TABLE sync_operations FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON sync_operations USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE sync_snapshots ENABLE ROW LEVEL SECURITY;ALTER TABLE sync_snapshots FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON sync_snapshots USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE api_idempotency ENABLE ROW LEVEL SECURITY;ALTER TABLE api_idempotency FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON api_idempotency USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE automation_jobs ENABLE ROW LEVEL SECURITY;ALTER TABLE automation_jobs FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON automation_jobs USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON outbox_events USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;ALTER TABLE notification_events FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON notification_events USING(user_id=principal()) WITH CHECK(user_id=principal());

ALTER TABLE exports ENABLE ROW LEVEL SECURITY;ALTER TABLE exports FORCE ROW LEVEL SECURITY;CREATE POLICY owner ON exports USING(user_id=principal()) WITH CHECK(user_id=principal());

CREATE INDEX ON review_cards(user_id,due_at,id);

CREATE INDEX ON review_events(user_id,card_id,reviewed_at,id);

CREATE INDEX ON tasks(user_id,status,due_at,id);

CREATE INDEX ON research_objects(user_id,project_id);

CREATE INDEX ON workout_sessions(user_id,started_at,id);

CREATE INDEX ON automation_jobs(status,scheduled_at);

CREATE INDEX ON outbox_events(published_at,created_at);

CREATE UNIQUE INDEX ON knowledge_relations(user_id,source_item_id,target_item_id,relation_type) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ON research_knowledge_links(user_id,research_object_id,knowledge_item_id) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ON research_paper_links(user_id,project_id,paper_id) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ON workout_template_exercises(user_id,template_id,position) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ON workout_session_exercises(user_id,session_id,position) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ON workout_sets(user_id,session_id,session_exercise_id,set_order) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ON daily_plan_items(user_id,daily_plan_id,position) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ON daily_plan_review_cards(user_id,plan_item_id,card_id) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ON arxiv_subscriptions(user_id,subscription_type,lower(subscription_value)) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ON tasks(user_id,user_paper_id) WHERE source_type='reading' AND status NOT IN('completed','archived') AND deleted_at IS NULL;

-- Runtime roles: non-owner, no BYPASSRLS, no DDL/TRUNCATE. API SELECT only on global arxiv metadata. Every product mutation uses per-user sync lock; version increments are explicit in shared handlers.


ALTER TABLE review_submissions ADD UNIQUE(user_id,card_id,id);
ALTER TABLE review_events ADD FOREIGN KEY(user_id,card_id,submission_id) REFERENCES review_submissions(user_id,card_id,id);
ALTER TABLE scheduler_configs ADD CHECK(NOT fuzz_enabled);
CREATE FUNCTION protect_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status<>'blocked' OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id
 OR NEW.client_operation_id<>OLD.client_operation_id OR NEW.device_id<>OLD.device_id
 OR NEW.entity_type<>OLD.entity_type OR NEW.entity_id<>OLD.entity_id OR NEW.operation_type<>OLD.operation_type
 OR NEW.payload_hash<>OLD.payload_hash OR NEW.payload<>OLD.payload
 THEN RAISE EXCEPTION 'receipt identity and terminal result are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER receipt_guard BEFORE UPDATE ON sync_operations FOR EACH ROW EXECUTE FUNCTION protect_receipt();
CREATE TRIGGER snapshot_immutable BEFORE UPDATE ON sync_snapshots FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON user_preferences FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON devices FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON knowledge_items FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON knowledge_relations FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON review_cards FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON research_projects FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON research_objects FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON research_knowledge_links FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON exercises FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON workout_templates FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON workout_template_exercises FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON workout_sessions FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON workout_session_exercises FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON workout_sets FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON cardio_entries FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON arxiv_papers FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON arxiv_subscriptions FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON user_papers FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON research_paper_links FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON inbox_entries FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON daily_plans FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON daily_plan_items FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON daily_plan_review_cards FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON daily_shutdowns FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON sync_conflicts FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON user_sync_state FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON sync_operations FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON sync_snapshots FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON automation_jobs FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON outbox_events FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON notification_events FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER no_hard_delete BEFORE DELETE ON exports FOR EACH ROW EXECUTE FUNCTION protect_history();

COMMIT;