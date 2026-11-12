export interface Entity {
  id: string;
  version: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export interface Knowledge extends Entity {
  title: string;
  type: string;
  subject: string;
  tags: string[];
  content: string;
  proof_content: string | null;
  source_reference: string | null;
  verification_status: string;
}
export interface ProofStep {
  id: string;
  hint: string;
}
export interface Card extends Entity {
  knowledge_item_id: string;
  card_type: string;
  prompt: string;
  answer: string;
  due_at: string;
  last_reviewed_at: string | null;
  review_count: number;
  lapse_count: number;
  suspended: boolean;
  proof_steps?: ProofStep[];
}
export interface ReviewEvent {
  id: string;
  card_id: string;
  rating: string;
  reviewed_at: string;
  duration_ms: number;
  resulting_state: Record<string, unknown>;
  proof_stuck_steps?: ProofStep[];
}
export interface Project extends Entity {
  title: string;
  description: string;
  research_area: string;
  status: string;
  importance: number;
  started_at: string | null;
  deadline: string | null;
  notes: string;
  source_code_locations: string[];
}
export interface ResearchObject extends Entity {
  project_id: string;
  object_type: string;
  title: string;
  content: string;
  claim_status: string;
  proof_content: string | null;
  evidence_reference: string | null;
  evidence_metadata: Record<string, unknown>;
}
export interface ResearchEvent {
  id: string;
  event_type: string;
  created_at: string;
  event_payload: Record<string, unknown>;
}
export interface Task extends Entity {
  project_id: string | null;
  research_object_id: string | null;
  user_paper_id: string | null;
  workout_template_id: string | null;
  source_type: string;
  title: string;
  description: string;
  priority: number;
  status: string;
  due_at: string | null;
  hard_deadline: boolean;
  planned_date: string | null;
  estimated_minutes: number;
  pinned: boolean;
  actual_minutes: number | null;
  completed_at: string | null;
}
export interface PlanItem extends Entity {
  daily_plan_id: string;
  task_id: string | null;
  item_type: string;
  review_card_ids: string[];
  position: number;
  title_snapshot: string;
  scheduled_minutes: number;
  status: string;
  pinned: boolean;
  manually_placed: boolean;
  deferred_reason: string | null;
  priority_reason: string;
  next_available_at: string | null;
}
export interface Plan extends Entity {
  plan_date: string;
  timezone: string;
  capacity_minutes: number;
  generation_version: string;
  input_hash: string;
  overload_minutes: number;
  items: PlanItem[];
}
export interface Today {
  date: string;
  timezone: string;
  as_of: string;
  reviews_due_now: number;
  reviews_due_by_end_of_day: number;
  review_activity?: { date: string; count: number }[];
  research_tasks_due: number;
  planned_workout: Task | null;
  unread_papers: number;
  saved_papers: number;
  capacity_minutes: number;
  estimated_remaining_minutes: number;
  completed_count: number;
  planned_count: number;
  continuation_note?: string | null;
  plan: Plan | null;
}
export interface Exercise extends Entity {
  name: string;
  exercise_type: string;
  measurement_unit: string;
}
export interface TemplateExercise extends Entity {
  exercise_id: string;
  position: number;
  target_sets: number;
  target_reps: number | null;
  target_weight_kg: number | null;
  rest_seconds: number | null;
}
export interface Template extends Entity {
  title: string;
  activity_type: string;
  exercises: TemplateExercise[];
}
export interface SessionExercise extends Entity {
  session_id: string;
  exercise_id: string;
  name_snapshot: string;
  position: number;
}
export interface WorkoutSet extends Entity {
  session_id: string;
  session_exercise_id: string;
  exercise_id: string;
  set_order: number;
  entered_weight: number | null;
  entered_weight_unit: string;
  weight_kg: number | null;
  reps: number;
  rpe: number | null;
  rir: number | null;
  completed_at: string | null;
}
export interface Cardio extends Entity {
  session_id: string;
  activity_type: string;
  duration_seconds: number;
  distance: number;
  distance_unit: string;
  distance_meters: number;
  average_heart_rate: number | null;
  perceived_intensity: number | null;
}
export interface Session extends Entity {
  template_id: string | null;
  planned_task_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  notes: string;
  template_snapshot: Record<string, unknown>;
  exercises: SessionExercise[];
  sets: WorkoutSet[];
  cardio: Cardio[];
  volume_kg_reps: number;
}
export interface Paper {
  id: string;
  arxiv_id: string;
  latest_version: number;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  published_at: string;
  updated_at: string;
  source_url: string;
  pdf_url: string;
}
export interface UserPaper extends Entity {
  paper_id: string;
  for_you_reaction?: 'interested' | 'liked' | 'not_interested' | 'skip' | null;
  status: string;
  is_saved: boolean;
  saved_at: string | null;
  read_at: string | null;
  relevance_score: number;
  match_reasons: string[];
  paper: Paper;
}
export interface Subscription extends Entity {
  subscription_type: string;
  subscription_value: string;
  enabled: boolean;
  weight: number;
}
export interface User {
  id: string;
  display_name: string;
  email: string;
  timezone: string;
  version: string;
}
export interface Preferences {
  desired_retention: number;
  daily_review_limit: number;
  default_study_capacity_minutes: number;
  notification_preferences: {
    push_enabled: boolean;
    quiet_start: string;
    quiet_end: string;
    shutdown_reminder_time?: string | null;
  };
  digest_preferences: { enabled: boolean; time: string };
  version: string;
}
export interface Conflict extends Entity {
  entity_type: string;
  entity_id: string;
  client_operation_id: string;
  conflict_type: string;
  base_payload: Record<string, unknown> | null;
  client_payload: Record<string, unknown>;
  server_payload: Record<string, unknown>;
  resolution: string | null;
  resolved_at: string | null;
}
export interface InboxEntry extends Entity {
  content: string;
  classified_task_id: string | null;
  classified_knowledge_id: string | null;
}
export interface Job {
  id: string;
  job_type: string;
  scheduled_at: string;
  status: string;
  attempts: number;
  error_message: string | null;
}
export interface ExportJob {
  id: string;
  status: string;
  expires_at: string | null;
  error_message: string | null;
}
