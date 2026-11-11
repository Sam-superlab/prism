import { describe, expect, it } from 'vitest';
import { generatePlan, type PlanInput, type PlannerTask } from '../../packages/planner/src/index';

const task = (id: string, overrides: Partial<PlannerTask> = {}): PlannerTask => ({
  id,
  title: id,
  status: 'ready',
  priority: 3,
  pinned: false,
  due_at: null,
  hard_deadline: false,
  estimated_minutes: 30,
  ...overrides,
});
const base: PlanInput = {
  planDate: '2026-11-08',
  timezone: 'Europe/Budapest',
  asOf: '2026-11-08T08:00:00Z',
  capacityMinutes: 90,
  tasks: [],
  cards: [],
};

describe('deterministic capacity planning', () => {
  it('keeps pinned and hard-deadline work and reports impossible capacity', () => {
    const input = {
      ...base,
      capacityMinutes: 20,
      tasks: [
        task('pinned', { pinned: true, estimated_minutes: 30 }),
        task('deadline', { hard_deadline: true, due_at: '2026-11-08T15:00:00Z', estimated_minutes: 40 }),
        task('flexible'),
      ],
    };
    const plan = generatePlan(input);
    expect(plan.overloadMinutes).toBe(50);
    expect(plan.items.filter((item) => item.status === 'planned').map((item) => item.task_id)).toEqual([
      'deadline',
      'pinned',
    ]);
    expect(plan.items.find((item) => item.task_id === 'flexible')?.deferred_reason).toBeTruthy();
    expect(input.tasks[1].due_at).toBe('2026-11-08T15:00:00Z');
  });

  it('skips an oversized flexible task and still fits a later short task', () => {
    const plan = generatePlan({
      ...base,
      capacityMinutes: 25,
      tasks: [task('long', { priority: 5 }), task('short', { estimated_minutes: 10 })],
    });
    expect(plan.items.find((item) => item.task_id === 'long')?.status).toBe('deferred');
    expect(plan.items.find((item) => item.task_id === 'short')?.status).toBe('planned');
  });

  it('respects manual skip/defer across regeneration and explicit override releases it', () => {
    const initial = generatePlan({ ...base, tasks: [task('manual')] });
    const existingItems = initial.items.map((item) => ({
      ...item,
      status: 'skipped' as const,
      manually_placed: true,
    }));
    expect(generatePlan({ ...base, tasks: [task('manual')], existingItems }).items[0].status).toBe('skipped');
    expect(
      generatePlan({ ...base, tasks: [task('manual')], existingItems, overrideManual: true }).items[0].status,
    ).toBe('planned');
  });

  it('uses stable UUID tie order and identical input gives an identical result', () => {
    const input = { ...base, tasks: [task('b'), task('a')] };
    expect(generatePlan(input)).toEqual(generatePlan(structuredClone(input)));
    expect(generatePlan(input).items.map((item) => item.task_id)).toEqual(['a', 'b']);
  });

  it('bounds reviews and keeps future-day tasks out of today', () => {
    const plan = generatePlan({
      ...base,
      capacityMinutes: 40,
      reviewLimit: 5,
      tasks: [task('tomorrow', { planned_date: '2026-11-09' })],
      cards: Array.from({ length: 20 }, (_, n) => ({
        id: String(n).padStart(2, '0'),
        due_at: '2026-11-07T00:00:00Z',
      })),
    });
    expect(plan.items[0].review_card_ids).toHaveLength(5);
    expect(plan.reviewDeferredCount).toBe(15);
    expect(plan.items.some((item) => item.task_id === 'tomorrow')).toBe(false);
  });

  it('subtracts actual completed time and handles zero capacity honestly', () => {
    const initial = generatePlan({ ...base, tasks: [task('done')] });
    const plan = generatePlan({
      ...base,
      capacityMinutes: 0,
      tasks: [task('done', { status: 'completed', actual_minutes: 45 }), task('next')],
      existingItems: initial.items,
    });
    expect(plan.completedMinutes).toBe(45);
    expect(plan.overloadMinutes).toBe(45);
    expect(plan.items.find((item) => item.task_id === 'next')?.status).toBe('deferred');
  });
});
