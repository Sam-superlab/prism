import { localDayRange } from '@prism/shared-utils';

export interface PlannerTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  pinned: boolean;
  due_at: string | null;
  hard_deadline: boolean;
  planned_date?: string | null;
  estimated_minutes: number;
  actual_minutes?: number | null;
  project_importance?: number;
  deleted_at?: string | null;
}
export interface PlannerCard {
  id: string;
  due_at: string;
  suspended?: boolean;
  deleted_at?: string | null;
}
export interface PlannerItem {
  id?: string;
  task_id: string | null;
  item_type: 'task' | 'review';
  review_card_ids: string[];
  title_snapshot: string;
  position: number;
  scheduled_minutes: number;
  status: 'planned' | 'completed' | 'skipped' | 'deferred';
  pinned: boolean;
  manually_placed: boolean;
  deferred_reason: string | null;
  priority_reason: string;
  next_available_at: string | null;
}
export interface PlanInput {
  planDate: string;
  timezone: string;
  asOf: string;
  capacityMinutes: number;
  reviewLimit?: number;
  tasks: PlannerTask[];
  cards: PlannerCard[];
  existingItems?: PlannerItem[];
  overrideManual?: boolean;
}
export interface PlanOutput {
  version: 'planner-v1';
  items: PlannerItem[];
  overloadMinutes: number;
  requiredMinutes: number;
  completedMinutes: number;
  remainingMinutes: number;
  reviewDeferredCount: number;
}
type Candidate = {
  item: PlannerItem;
  task?: PlannerTask;
  hard: boolean;
  overdueReview: boolean;
  due: number;
  importance: number;
};
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (item: PlannerItem) => (item.task_id ? `task:${item.task_id}` : 'review');

/** Pure, deterministic allocation. Does not modify tasks, deadlines or its inputs. */
export function generatePlan(input: PlanInput): PlanOutput {
  if (!Number.isInteger(input.capacityMinutes) || input.capacityMinutes < 0 || input.capacityMinutes > 1440)
    throw new Error('Invalid daily capacity');
  const asOf = Date.parse(input.asOf);
  if (!Number.isFinite(asOf)) throw new Error('Invalid planning instant');
  const range = localDayRange(input.planDate, input.timezone);
  const start = Date.parse(range.start),
    end = Date.parse(range.end);
  const weekDate = new Date(`${input.planDate}T12:00:00Z`);
  weekDate.setUTCDate(weekDate.getUTCDate() + 7);
  const weekEnd = Date.parse(localDayRange(weekDate.toISOString().slice(0, 10), input.timezone).end);
  const existing = new Map((input.existingItems ?? []).map((item) => [key(item), structuredClone(item)]));
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const retained: PlannerItem[] = [];
  const candidates: Candidate[] = [];
  let completedMinutes = 0;

  for (const old of existing.values()) {
    const task = old.task_id ? tasks.get(old.task_id) : undefined;
    if (old.status === 'completed' || task?.status === 'completed') {
      old.status = 'completed';
      retained.push(old);
      completedMinutes += task?.actual_minutes ?? old.scheduled_minutes;
    } else if (!input.overrideManual && ['skipped', 'deferred'].includes(old.status) && old.manually_placed)
      retained.push(old);
  }
  const retainedKeys = new Set(retained.map(key));

  for (const task of input.tasks) {
    if (task.deleted_at || !['ready', 'in_progress'].includes(task.status)) continue;
    if (!Number.isFinite(task.estimated_minutes) || task.estimated_minutes <= 0)
      throw new Error(`Missing task estimate: ${task.id}`);
    const old = existing.get(`task:${task.id}`);
    if (retainedKeys.has(`task:${task.id}`)) continue;
    const pinned = !input.overrideManual && old ? old.pinned : task.pinned;
    const due = task.due_at ? Date.parse(task.due_at) : Infinity;
    if (task.due_at && !Number.isFinite(due)) throw new Error(`Invalid deadline: ${task.id}`);
    const hard = task.hard_deadline && due < end;
    if (task.planned_date && task.planned_date > input.planDate && !pinned && !hard) continue;
    const manual = !input.overrideManual && !!old?.manually_placed;
    const item: PlannerItem = {
      id: old?.id,
      task_id: task.id,
      item_type: 'task',
      review_card_ids: [],
      title_snapshot: task.title,
      position: old?.position ?? 0,
      scheduled_minutes: manual ? old!.scheduled_minutes : task.estimated_minutes,
      status: 'planned',
      pinned,
      manually_placed: manual,
      deferred_reason: null,
      priority_reason: hard
        ? 'Hard deadline today'
        : pinned
          ? 'A task you pinned'
          : due < start
            ? 'Task is overdue'
            : due < end
              ? 'Due today'
              : 'Based on priority and available time',
      next_available_at: null,
    };
    candidates.push({
      item,
      task,
      hard,
      overdueReview: false,
      due,
      importance: task.project_importance ?? 3,
    });
  }

  const dueCards = input.cards
    .filter((card) => !card.deleted_at && !card.suspended && Date.parse(card.due_at) < end)
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at) || compareText(a.id, b.id));
  const reviewBudget = Math.max(
    0,
    Math.min(30, Math.floor(input.capacityMinutes * 0.25), input.reviewLimit ?? 100),
  );
  const oldReview = existing.get('review');
  const selected =
    !input.overrideManual && oldReview?.pinned
      ? oldReview.review_card_ids
          .map((id) => dueCards.find((card) => card.id === id))
          .filter((card): card is PlannerCard => !!card)
      : dueCards.slice(0, reviewBudget);
  if (selected.length && !retainedKeys.has('review')) {
    const overdueReview = selected.some((card) => Date.parse(card.due_at) < start);
    const manual = !input.overrideManual && !!oldReview?.manually_placed;
    const item: PlannerItem = {
      id: oldReview?.id,
      task_id: null,
      item_type: 'review',
      review_card_ids: selected.map((card) => card.id),
      title_snapshot: `Review ${selected.length} cards`,
      position: oldReview?.position ?? 0,
      scheduled_minutes: selected.length,
      status: 'planned',
      pinned: !input.overrideManual && !!oldReview?.pinned,
      manually_placed: manual,
      deferred_reason: null,
      priority_reason: overdueReview ? "Overdue reviews within today's time budget" : 'Reinforce knowledge due today',
      next_available_at: Date.parse(selected[0].due_at) > asOf ? selected[0].due_at : null,
    };
    candidates.push({ item, hard: false, overdueReview, due: Date.parse(selected[0].due_at), importance: 3 });
  }

  const urgency = (due: number) => (due < start ? 0 : due < end ? 1 : due < weekEnd ? 2 : 3);
  candidates.sort(
    (a, b) =>
      Number(b.hard) - Number(a.hard) ||
      Number(b.item.pinned) - Number(a.item.pinned) ||
      Number(b.overdueReview) - Number(a.overdueReview) ||
      urgency(a.due) - urgency(b.due) ||
      (b.task?.priority ?? 3) - (a.task?.priority ?? 3) ||
      b.importance - a.importance ||
      (a.due === b.due ? 0 : a.due - b.due) ||
      a.item.scheduled_minutes - b.item.scheduled_minutes ||
      compareText(key(a.item), key(b.item)),
  );

  const requiredMinutes = candidates
    .filter((c) => c.hard || c.item.pinned)
    .reduce((n, c) => n + c.item.scheduled_minutes, 0);
  const remainingCapacity = Math.max(0, input.capacityMinutes - completedMinutes);
  let free = Math.max(0, remainingCapacity - requiredMinutes);
  for (const candidate of candidates) {
    if (candidate.hard || candidate.item.pinned) continue;
    if (candidate.item.scheduled_minutes <= free) free -= candidate.item.scheduled_minutes;
    else {
      candidate.item.status = 'deferred';
      candidate.item.deferred_reason = 'Deferred to fit available time; the task and deadline are preserved.';
    }
  }
  // Manual order is a persistent user constraint among manually placed items.
  const manualItems = candidates
    .filter((c) => c.item.manually_placed)
    .sort((a, b) => a.item.position - b.item.position || compareText(key(a.item), key(b.item)));
  const automaticItems = candidates.filter((c) => !c.item.manually_placed);
  const items = [
    ...retained.sort((a, b) => a.position - b.position),
    ...manualItems.map((c) => c.item),
    ...automaticItems.map((c) => c.item),
  ].map((item, position) => ({ ...item, position }));
  const plannedMinutes = items
    .filter((item) => item.status === 'planned')
    .reduce((n, item) => n + item.scheduled_minutes, 0);
  return {
    version: 'planner-v1',
    items,
    requiredMinutes,
    completedMinutes,
    overloadMinutes: Math.max(0, completedMinutes + requiredMinutes - input.capacityMinutes),
    remainingMinutes: plannedMinutes,
    reviewDeferredCount: Math.max(0, dueCards.length - selected.length),
  };
}
