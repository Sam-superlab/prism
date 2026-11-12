'use client';
import { localDayRange } from '@prism/shared-utils';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api,
  datetime,
  instantToLocalInput,
  localInputToInstant,
  todayDate,
  useAction,
  useResource,
  uuid,
} from '../../lib/api';
import type { InboxEntry, Page, PlanItem, Task, Today, User } from '../../lib/types';
import { Badge, Empty, ErrorState, Field, Icon, Loading, Modal, Notice, label } from '../ui';
import { DailyReviewDrafts } from './DailyReviewDrafts';
import { TodayOverview } from './TodayOverview';
import { FocusTimer, type FocusTimerController } from './FocusTimer';

function previousDate(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function canPlanTask(task: Task, date: string, endOfDay: number) {
  return (
    task.source_type !== 'workout' &&
    ['ready', 'in_progress'].includes(task.status) &&
    (!task.planned_date ||
      task.planned_date <= date ||
      task.pinned ||
      (task.hard_deadline && task.due_at !== null && Date.parse(task.due_at) < endOfDay))
  );
}

function taskPlanFeedback(task: Task, day: Today, item: PlanItem | undefined, planError: boolean) {
  if (item?.status === 'planned') return { text: `Added to today’s plan: ${task.title}` };
  if (item?.status === 'completed') return { text: `Completed: ${task.title}` };
  if (item?.status === 'deferred' || item?.status === 'skipped') {
    const reason = item.deferred_reason ? ` ${item.deferred_reason}` : '';
    return { text: `Saved in Deferred: ${task.title}.${reason}`, destination: 'deferred' as const };
  }
  if (!canPlanTask(task, day.date, Date.parse(localDayRange(day.date, day.timezone).end))) {
    const reason =
      task.planned_date && task.planned_date > day.date
        ? `Planned for ${task.planned_date}.`
        : 'Only ready or in-progress tasks go into today’s plan.';
    return { text: `Saved in Task library: ${task.title}. ${reason}`, destination: 'library' as const };
  }
  if (planError) return { text: `Saved in Task library: ${task.title}.`, destination: 'library' as const };
  return { text: 'Task saved. Updating today’s plan…' };
}

export function TodayPage({
  gettingStarted,
  focusTimer,
}: {
  gettingStarted?: (reload: () => void) => ReactNode;
  focusTimer: FocusTimerController;
}) {
  const me = useResource<User>('/me');
  const timezone = me.data?.timezone;
  const [date, setDate] = useState('');
  const today = useResource<Today>(date ? `/today?date=${date}` : null);
  const tasks = useResource<Page<Task>>('/tasks?limit=500');
  const inbox = useResource<Page<InboxEntry>>('/inbox?limit=100');
  const [editingTask, setEditingTask] = useState<Task | undefined>();
  const [poolFilter, setPoolFilter] = useState('pending');
  const [capacityDraft, setCapacityDraft] = useState<string | null>(null);
  const [tab, setTab] = useState('pending');
  const [addTask, setAddTask] = useState(false);
  const [savedTask, setSavedTask] = useState<Task | null>(null);
  const [shutdown, setShutdown] = useState(false);
  const [defer, setDefer] = useState<PlanItem | null>(null);
  const [reason, setReason] = useState('Focusing on other work today');
  const [message, setMessage] = useState('');
  const [autoPlanning, setAutoPlanning] = useState(false);
  const [autoError, setAutoError] = useState('');
  const attempted = useRef('');
  const planPanel = useRef<HTMLElement>(null);
  const taskLibrary = useRef<HTMLDetailsElement>(null);
  const focusPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!timezone) return;
    const update = () => setDate(todayDate(timezone));
    update();
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, [timezone]);
  const refresh = () => {
    today.reload();
    tasks.reload();
    inbox.reload();
  };
  const action = useAction(refresh);
  const d = today.data?.date === date ? today.data : null;
  const capacity = capacityDraft === null ? (d?.capacity_minutes ?? 180) : Number(capacityDraft);
  const capacityValid =
    capacityDraft !== '' && Number.isInteger(capacity) && capacity >= 0 && capacity <= 1440;
  const draftDate =
    process.env.NEXT_PUBLIC_PRISM_AI_REVIEW_DRAFTS === 'true' && d ? previousDate(d.date) : null;
  const reloadToday = today.reload;
  useEffect(() => {
    if (!d || today.loading || autoPlanning || action.busy || (d.plan && (tasks.loading || !tasks.data)))
      return;
    let request = d.date;
    if (d.plan) {
      const included = new Set(d.plan.items.map((item) => item.task_id));
      const endOfDay = Date.parse(localDayRange(d.date, d.timezone).end);
      const available = new Map(tasks.data?.items.map((task) => [task.id, task]));
      if (savedTask && !available.has(savedTask.id)) available.set(savedTask.id, savedTask);
      const missing = [...available.values()]
        .filter((task) => !included.has(task.id) && canPlanTask(task, d.date, endOfDay))
        .map((task) => task.id)
        .sort();
      if (!missing.length) {
        attempted.current = '';
        return;
      }
      request += ':' + missing.join(',');
    }
    if (attempted.current === request) return;
    attempted.current = request;
    setAutoError('');
    setAutoPlanning(true);
    void api('/daily-plans/generate', {
      method: 'POST',
      body: {
        plan_date: d.date,
        timezone: d.timezone,
        capacity_minutes: d.capacity_minutes,
        ...(d.plan ? { override_manual: false } : { if_missing: true }),
      },
    })
      .then(reloadToday)
      .catch(() =>
        setAutoError(
          d.plan
            ? 'Could not refresh today’s plan. Try Replan.'
            : 'Could not prepare the plan automatically. Try Plan today.',
        ),
      )
      .finally(() => setAutoPlanning(false));
  }, [d, today.loading, tasks.data, tasks.loading, autoPlanning, action.busy, reloadToday, savedTask]);
  const plan = d?.plan;
  const savedPlanItem = plan?.items.find((item) => item.task_id === savedTask?.id);
  const savedTaskFeedback =
    savedTask && d
      ? taskPlanFeedback(savedTask, d, savedPlanItem, Boolean(autoError || tasks.error || today.error))
      : null;
  const items = [...(plan?.items || [])].sort((a, b) => a.position - b.position);
  const active = items.filter(
    (x) =>
      tab === 'all' ||
      (tab === 'pending'
        ? x.status === 'planned'
        : tab === 'completed'
          ? x.status === 'completed'
          : x.status === 'deferred' || x.status === 'skipped'),
  );
  const workspaceTasks = tasks.data?.items.filter((t) => t.source_type !== 'workout') ?? [];
  const taskById = new Map(workspaceTasks.map((t) => [t.id, t]));
  async function generate() {
    if (!capacityValid) return;
    setAutoError('');
    await action.run(() =>
      api('/daily-plans/generate', {
        method: 'POST',
        body: {
          plan_date: date,
          timezone: me.data?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
          capacity_minutes: capacity,
          override_manual: false,
        },
      }),
    );
  }
  async function move(item: PlanItem, direction: -1 | 1) {
    if (!plan) return;
    const next = [...items];
    const i = next.findIndex((x) => x.id === item.id);
    if (i + direction < 0 || i + direction >= next.length) return;
    [next[i], next[i + direction]] = [next[i + direction], next[i]];
    await action.run(() =>
      api(`/daily-plans/${plan.id}/reorder`, {
        method: 'POST',
        version: plan.version,
        body: { item_ids: next.map((x) => x.id) },
      }),
    );
  }
  async function completeTask(task: Task) {
    await action.run(async () => {
      await api(`/tasks/${task.id}/complete`, {
        method: 'POST',
        version: task.version,
        body: { completed_at: new Date().toISOString() },
      });
      focusTimer.finishTask(task.id);
    });
  }
  function complete(item: PlanItem) {
    const task = item.task_id && taskById.get(item.task_id);
    if (task) void completeTask(task);
  }
  async function start(item: PlanItem) {
    const task = item.task_id && taskById.get(item.task_id);
    if (!task) return;
    await action.run(async () => {
      await api(`/tasks/${task.id}`, {
        method: 'PATCH',
        version: task.version,
        body: { status: 'in_progress' },
      });
      setMessage(`Started: ${task.title}`);
    });
  }
  function focusOn(task: Task) {
    if (!focusTimer.startTask({ id: task.id, title: task.title })) return;
    const reducedMotion =
      document.documentElement.dataset.reducedMotion === 'true' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    focusPanel.current?.querySelector('h2')?.focus({ preventScroll: true });
    focusPanel.current?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'instant' : 'smooth' });
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {me.data &&
              new Intl.DateTimeFormat('en-US', {
                month: 'long',
                day: 'numeric',
                weekday: 'long',
                timeZone: me.data.timezone,
              })
                .format(new Date())
                .toUpperCase()}
          </div>
          <h1>Dashboard</h1>
        </div>
        <div className="heading-meta">
          <span className="timezone">
            <Icon name="clock" size={15} />
            {me.data?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}
          </span>
          <button className="button" disabled={!plan} onClick={() => setShutdown(true)}>
            Daily reflection
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </div>
      {gettingStarted?.(reloadToday)}
      <ErrorState error={me.error || today.error} retry={me.error ? me.reload : today.reload} />
      {(me.loading || today.loading) && !d && <Loading />}
      {d && (
        <>
          {d.continuation_note && (
            <section className="panel continuation-note" aria-label="Yesterday’s next step">
              <span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
              <p>{d.continuation_note}</p>
            </section>
          )}
          <div className="summary-grid">
            <Link href="/review/session" className="summary-card purple">
              <div className="summary-icon">
                <Icon name="knowledge" />
              </div>
              <div>
                <span className="card-label">Reviews due</span>
                <strong>
                  {d.reviews_due_now}
                  <small>cards</small>
                </strong>
                <span className="card-footnote">Due today: {d.reviews_due_by_end_of_day} cards</span>
              </div>
              <Icon name="arrow" className="summary-arrow" size={17} />
            </Link>
            <Link href="/research" className="summary-card blue">
              <div className="summary-icon">
                <Icon name="research" />
              </div>
              <div>
                <span className="card-label">Research tasks</span>
                <strong>
                  {d.research_tasks_due}
                  <small>due</small>
                </strong>
              </div>
              <Icon name="arrow" className="summary-arrow" size={17} />
            </Link>
            <Link href="/discover" className="summary-card green">
              <div className="summary-icon">
                <Icon name="discover" />
              </div>
              <div>
                <span className="card-label">Paper updates</span>
                <strong>
                  {d.unread_papers}
                  <small>unread</small>
                </strong>
                <span className="card-footnote">Saved: {d.saved_papers} papers</span>
              </div>
              <Icon name="arrow" className="summary-arrow" size={17} />
            </Link>
          </div>
          <TodayOverview
            today={d}
            onShowPlan={(filter) => {
              setTab(filter);
              planPanel.current?.focus({ preventScroll: true });
              planPanel.current?.scrollIntoView({ block: 'start' });
            }}
          />
          <div className="today-layout">
            <section
              ref={planPanel}
              className="panel plan-panel"
              tabIndex={-1}
              aria-labelledby="today-plan-heading"
            >
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">YOUR DAILY FOCUS</span>
                  <h2 id="today-plan-heading">Today’s plan</h2>
                </div>
                <button
                  className="button small"
                  onClick={() => {
                    setEditingTask(undefined);
                    setAddTask(true);
                  }}
                >
                  <Icon name="plus" size={16} />
                  Add task
                </button>
              </div>
              <div className="plan-toolbar">
                <div className="tabs">
                  {[
                    ['pending', 'To do'],
                    ['completed', 'Completed'],
                    ['deferred', 'Deferred'],
                    ['all', 'All'],
                  ].map(([v, l]) => (
                    <button key={v} className={tab === v ? 'active' : ''} onClick={() => setTab(v)}>
                      {l}
                    </button>
                  ))}
                </div>
                <span className="subtle small-text">{d.estimated_remaining_minutes} min remaining</span>
              </div>
              {message && (
                <Notice>
                  {message}
                  <button className="icon-button" aria-label="Dismiss message" onClick={() => setMessage('')}>
                    <Icon name="close" size={14} />
                  </button>
                </Notice>
              )}
              {action.error && <Notice tone="error">{action.error}</Notice>}
              {savedTaskFeedback && (
                <Notice>
                  <span role="status">{savedTaskFeedback.text}</span>
                  {savedTaskFeedback.destination === 'deferred' && (
                    <button className="button small" onClick={() => setTab('deferred')}>
                      Show deferred
                    </button>
                  )}
                  {savedTaskFeedback.destination === 'library' && (
                    <button
                      className="button small"
                      onClick={() => {
                        if (!taskLibrary.current) return;
                        setPoolFilter('pending');
                        taskLibrary.current.open = true;
                        taskLibrary.current.querySelector('summary')?.focus();
                      }}
                    >
                      Open Task library
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label="Dismiss task update"
                    onClick={() => setSavedTask(null)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </Notice>
              )}
              {autoError && <Notice tone="error">{autoError}</Notice>}
              {!plan && autoPlanning ? (
                <Loading />
              ) : !plan ? (
                <Empty
                  icon="planner"
                  title="Give today a clear plan"
                  action={
                    <button
                      className="button primary"
                      onClick={() => void generate()}
                      disabled={action.busy || !capacityValid}
                    >
                      Plan today
                      <Icon name="arrow" size={16} />
                    </button>
                  }
                >
                  Set your available time to bring reviews, research, and personal tasks together.
                </Empty>
              ) : active.length === 0 ? (
                <Empty icon="check" title={tab === 'pending' ? 'All clear here' : 'Nothing here yet'}>
                  {tab === 'pending'
                    ? 'Check Deferred or the Task library for tasks outside today’s schedule.'
                    : 'Completed and adjusted items will appear here.'}
                </Empty>
              ) : (
                <div className="task-list">
                  {active.map((item, index) => {
                    const task = item.task_id ? taskById.get(item.task_id) : null;
                    return (
                      <article
                        className={`task-row ${item.status === 'completed' ? 'done' : ''}`}
                        key={item.id}
                      >
                        <div className="task-order">{String(index + 1).padStart(2, '0')}</div>
                        <button
                          className={`task-check ${item.status === 'completed' ? 'checked' : ''}`}
                          aria-label={`Complete ${item.title_snapshot}`}
                          disabled={action.busy || item.item_type === 'review' || item.status === 'completed'}
                          onClick={() => void complete(item)}
                        >
                          {item.status === 'completed' && <Icon name="check" size={13} />}
                        </button>
                        <div className="task-main">
                          <h3>
                            {item.title_snapshot}
                            {item.pinned && <Icon name="pin" size={13} />}
                          </h3>
                          <div className="task-meta">
                            <Badge
                              tone={
                                item.item_type === 'review'
                                  ? 'purple'
                                  : task?.source_type === 'research'
                                    ? 'blue'
                                    : ''
                              }
                            >
                              {item.item_type === 'review'
                                ? 'FSRS REVIEW'
                                : label(task?.source_type || 'general')}
                            </Badge>
                            <span>
                              <Icon name="clock" size={12} />
                              {item.scheduled_minutes} min
                            </span>
                            {task?.hard_deadline && (
                              <span className="deadline">Hard deadline · {datetime(task.due_at, true)}</span>
                            )}
                            {task?.status === 'in_progress' && (
                              <span className="active-label">In progress</span>
                            )}
                          </div>
                          {item.deferred_reason ? (
                            <p className="task-reason">{item.deferred_reason}</p>
                          ) : (
                            <p className="task-reason">{item.priority_reason}</p>
                          )}
                        </div>
                        <div className="task-row-actions">
                          {task && item.status === 'planned' && (
                            <button
                              className="button small"
                              disabled={!focusTimer.ready}
                              onClick={() => focusOn(task)}
                              aria-label={`Focus on ${task.title}`}
                            >
                              <Icon name="clock" size={15} />
                              {focusTimer.taskId === task.id ? 'View timer' : 'Focus'}
                            </button>
                          )}
                          {item.status === 'planned' &&
                            (item.item_type === 'review' ? (
                              <Link className="button small soft" href="/review/session">
                                Start review
                                <Icon name="arrow" size={14} />
                              </Link>
                            ) : (
                              <button
                                className="button small soft"
                                disabled={action.busy}
                                onClick={() => void start(item)}
                              >
                                Start
                                <Icon name="arrow" size={14} />
                              </button>
                            ))}
                          <details className="row-menu">
                            <summary aria-label="Task options">···</summary>
                            <div>
                              {task && (
                                <button
                                  onClick={() => {
                                    setEditingTask(task);
                                    setAddTask(true);
                                  }}
                                >
                                  Edit task
                                </button>
                              )}
                              <button
                                onClick={() =>
                                  void action.run(() =>
                                    api(`/daily-plans/${plan.id}/items/${item.id}`, {
                                      method: 'PATCH',
                                      version: item.version,
                                      body: { pinned: !item.pinned },
                                    }),
                                  )
                                }
                              >
                                {item.pinned ? 'Unpin' : 'Pin to today'}
                              </button>
                              <button onClick={() => void move(item, -1)}>Move up</button>
                              <button onClick={() => void move(item, 1)}>Move down</button>
                              <button
                                onClick={() => {
                                  setDefer(item);
                                  setReason('Focusing on other work today');
                                }}
                              >
                                Defer
                              </button>
                              <button
                                onClick={() =>
                                  void action.run(() =>
                                    api(`/daily-plans/${plan.id}/items/${item.id}`, {
                                      method: 'PATCH',
                                      version: item.version,
                                      body: { status: 'skipped' },
                                    }),
                                  )
                                }
                              >
                                Skip today
                              </button>
                            </div>
                          </details>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              <div className="panel-bottom-note">
                Your plan adapts as you progress. Manual choices are preserved.
              </div>
            </section>
            <aside className="today-side">
              <div ref={focusPanel}>
                <FocusTimer timer={focusTimer} />
              </div>
              <section className="panel capacity-panel">
                <div className="panel-heading">
                  <h2>How much time do you have?</h2>
                  <Icon name="clock" size={18} />
                </div>
                <p className="muted">Give your day a realistic limit.</p>
                <div className="capacity-input">
                  <input
                    aria-label="Daily capacity in minutes"
                    type="number"
                    min="0"
                    max="1440"
                    value={capacityDraft ?? d.capacity_minutes}
                    onChange={(e) => setCapacityDraft(e.target.value)}
                  />
                  <span>Minutes</span>
                </div>
                <div className="capacity-presets">
                  {[60, 120, 180, 240].map((n) => (
                    <button
                      key={n}
                      className={capacityValid && capacity === n ? 'selected' : ''}
                      onClick={() => setCapacityDraft(String(n))}
                    >
                      {n / 60} h
                    </button>
                  ))}
                </div>
                {(plan?.overload_minutes || 0) > 0 ? (
                  <Notice tone="warning">
                    Pinned tasks and hard deadlines exceed capacity by {plan!.overload_minutes} min. Increase
                    your capacity or adjust the plan.
                  </Notice>
                ) : (
                  <div className="capacity-hint">
                    <span className="status-dot" />
                    {!capacityValid
                      ? 'Enter a whole number from 0 to 1440 minutes'
                      : d.estimated_remaining_minutes <= capacity
                        ? 'Your workload fits the available time'
                        : 'Generate a plan to see which tasks need more time'}
                  </div>
                )}
                <button
                  className="button primary full"
                  onClick={() => void generate()}
                  disabled={action.busy || autoPlanning || !capacityValid}
                >
                  {action.busy ? 'Planning…' : plan ? 'Replan' : 'Generate plan'}
                  <Icon name="refresh" size={15} />
                </button>
              </section>
            </aside>
          </div>
        </>
      )}
      {draftDate && <DailyReviewDrafts key={draftDate} date={draftDate} />}
      <details className="panel task-pool" ref={taskLibrary}>
        <summary>
          <span>
            <Icon name="planner" size={17} />
            Task library{' '}
            <span className="count-label">
              {workspaceTasks.filter((t) => !['completed', 'archived'].includes(t.status)).length || 0}
            </span>
          </span>
          <span>
            Browse unscheduled tasks and full history <Icon name="chevron" size={15} />
          </span>
        </summary>
        <div className="panel-filter">
          <select
            aria-label="Task library filter"
            value={poolFilter}
            onChange={(e) => setPoolFilter(e.target.value)}
          >
            {[
              ['pending', 'All unfinished'],
              ['backlog', 'Backlog'],
              ['blocked', 'Blocked'],
              ['completed', 'Completed'],
              ['archived', 'Archived'],
              ['all', 'All'],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <ErrorState error={tasks.error} retry={tasks.reload} />
        <div className="task-pool-list">
          {workspaceTasks
            .filter(
              (t) =>
                poolFilter === 'all' ||
                (poolFilter === 'pending'
                  ? !['completed', 'archived'].includes(t.status)
                  : t.status === poolFilter),
            )
            .map((t) => (
              <article key={t.id}>
                <button
                  className={`task-check ${t.status === 'completed' ? 'checked' : ''}`}
                  aria-label={`Complete task ${t.title}`}
                  disabled={t.status === 'completed' || action.busy}
                  onClick={() => void completeTask(t)}
                >
                  {t.status === 'completed' && <Icon name="check" size={13} />}
                </button>
                <div>
                  <button
                    className="task-title-button"
                    onClick={() => {
                      setEditingTask(t);
                      setAddTask(true);
                    }}
                  >
                    {t.title}
                  </button>
                  <div className="task-meta">
                    <Badge>{label(t.source_type)}</Badge>
                    <span>{label(t.status)}</span>
                    <span>{t.estimated_minutes} min</span>
                    {t.due_at && <span>{datetime(t.due_at)}</span>}
                    {t.pinned && <Icon name="pin" size={12} />}
                  </div>
                </div>
                <div className="inline-actions">
                  {['ready', 'in_progress'].includes(t.status) && (
                    <button
                      className="icon-button"
                      aria-label={`Focus on ${t.title}`}
                      title={focusTimer.taskId === t.id ? 'View timer' : 'Focus'}
                      disabled={!focusTimer.ready}
                      onClick={() => focusOn(t)}
                    >
                      <Icon name="clock" size={15} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={`Edit task ${t.title}`}
                    onClick={() => {
                      setEditingTask(t);
                      setAddTask(true);
                    }}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                </div>
              </article>
            ))}
        </div>
        {tasks.data && workspaceTasks.length === 0 && (
          <p className="panel-description muted">No tasks yet. Add a clear next step.</p>
        )}
      </details>
      <section className="panel inbox-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">A PLACE FOR YOUR THOUGHTS</span>
            <h2>
              Inbox{' '}
              <span className="count-label">
                {inbox.data?.items.filter((x) => !x.classified_task_id && !x.classified_knowledge_id)
                  .length || 0}
              </span>
            </h2>
          </div>
          <span className="muted small-text">Capture first. Organize later.</span>
        </div>
        <ErrorState error={inbox.error} retry={inbox.reload} />
        {inbox.data &&
          inbox.data.items.filter((x) => !x.classified_task_id && !x.classified_knowledge_id).length ===
            0 && (
            <div className="inbox-empty">
              <Icon name="plus" size={17} />
              <p>Ideas, questions, next steps. Use Quick capture to keep them here.</p>
            </div>
          )}
        {inbox.data?.items
          .filter((x) => !x.classified_task_id && !x.classified_knowledge_id)
          .map((entry) => (
            <div className="inbox-row" key={entry.id}>
              <p>{entry.content}</p>
              <span>{datetime(entry.created_at, true)}</span>
              <button
                className="button small"
                onClick={() =>
                  void action.run(() =>
                    api(`/inbox/${entry.id}/classify`, {
                      method: 'POST',
                      version: entry.version,
                      body: {
                        destination: 'knowledge',
                        item: {
                          id: uuid(),
                          title: entry.content.slice(0, 60),
                          type: 'note',
                          content: entry.content,
                        },
                      },
                    }),
                  )
                }
              >
                Save as knowledge
              </button>
              <button
                className="button small"
                onClick={() =>
                  void action.run(() =>
                    api(`/inbox/${entry.id}/classify`, {
                      method: 'POST',
                      version: entry.version,
                      body: {
                        destination: 'task',
                        item: {
                          id: uuid(),
                          title: entry.content.slice(0, 60),
                          description: entry.content,
                          source_type: 'general',
                          estimated_minutes: 30,
                        },
                      },
                    }),
                  )
                }
              >
                Create task
              </button>
              <button
                className="icon-button"
                aria-label="Archive capture"
                onClick={() =>
                  void action.run(() =>
                    api(`/inbox/${entry.id}`, { method: 'DELETE', version: entry.version }),
                  )
                }
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
      </section>
      {addTask && (
        <TaskModal
          task={editingTask}
          defaultPlannedDate={date}
          onClose={() => setAddTask(false)}
          onSaved={(saved) => {
            setAddTask(false);
            setSavedTask(editingTask ? null : (saved ?? null));
            if (!editingTask && saved) setTab('pending');
            refresh();
          }}
        />
      )}
      {defer && plan && (
        <Modal title="Leave this task for later" onClose={() => setDefer(null)}>
          <p className="modal-description">{defer.title_snapshot}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                await api(`/daily-plans/${plan.id}/items/${defer.id}`, {
                  method: 'PATCH',
                  version: defer.version,
                  body: { status: 'deferred', deferred_reason: reason },
                });
                setDefer(null);
              });
            }}
          >
            <Field label="Reason for deferral">
              <textarea required value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            </Field>
            <Notice>The task and its deadline stay unchanged. Only today’s plan is adjusted.</Notice>
            <div className="modal-footer">
              <button className="button" type="button" onClick={() => setDefer(null)}>
                Cancel
              </button>
              <button className="button primary" disabled={action.busy}>
                Confirm deferral
              </button>
            </div>
          </form>
        </Modal>
      )}
      {shutdown && plan && (
        <ShutdownModal key={plan.id} date={date} planId={plan.id} onClose={() => setShutdown(false)} />
      )}
    </>
  );
}
export function TaskModal({
  onClose,
  onSaved,
  projectId,
  objectId,
  task,
  defaultPlannedDate,
}: {
  onClose: () => void;
  onSaved: (saved?: Task) => void;
  projectId?: string;
  objectId?: string;
  task?: Task;
  defaultPlannedDate?: string;
}) {
  const [creationId] = useState(uuid);
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [minutes, setMinutes] = useState(String(task?.estimated_minutes ?? 30));
  const [priority, setPriority] = useState(task?.priority || 3);
  const [due, setDue] = useState(instantToLocalInput(task?.due_at));
  const [dueChanged, setDueChanged] = useState(false);
  const [hard, setHard] = useState(task?.hard_deadline || false);
  const [planned, setPlanned] = useState(task ? (task.planned_date ?? '') : (defaultPlannedDate ?? ''));
  const [status, setStatus] = useState(task?.status || 'ready');
  const [pinned, setPinned] = useState(task?.pinned || false);
  const action = useAction();
  async function save() {
    await action.run(async () => {
      const saved = await api<Task>(task ? `/tasks/${task.id}` : '/tasks', {
        method: task ? 'PATCH' : 'POST',
        version: task?.version,
        body: {
          ...(task
            ? {}
            : {
                id: creationId,
                source_type: projectId ? 'research' : 'general',
                ...(projectId ? { project_id: projectId } : {}),
                ...(objectId ? { research_object_id: objectId } : {}),
              }),
          title,
          description,
          estimated_minutes: Number(minutes),
          priority,
          ...(!task || dueChanged ? { due_at: due ? localInputToInstant(due) : null } : {}),
          hard_deadline: Boolean(due && hard),
          planned_date: planned || null,
          pinned,
          ...(status === 'completed' ? {} : { status }),
        },
      });
      onSaved(saved);
    });
  }
  return (
    <Modal title={task ? 'Edit task' : 'Next step'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Task title">
          <input
            required
            maxLength={300}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="A clear, actionable next step"
          />
        </Field>
        <Field label="Description">
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="Estimated minutes">
            <input
              type="number"
              required
              min="1"
              max="1440"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((x) => (
                <option key={x} value={x}>
                  {x} · {x === 5 ? 'Highest' : x === 1 ? 'Lowest' : 'Normal'}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Planned date (optional)">
            <input type="date" value={planned} onChange={(e) => setPlanned(e.target.value)} />
          </Field>
          <Field label="Status">
            <select
              value={status}
              disabled={status === 'completed'}
              onChange={(e) => setStatus(e.target.value)}
            >
              {['backlog', 'ready', 'in_progress', 'blocked', ...(task ? ['archived'] : [])].map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
              {status === 'completed' && <option value="completed">Completed</option>}
            </select>
          </Field>
        </div>
        <Field label="Deadline (optional, in your time zone)">
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => {
              setDue(e.target.value);
              setDueChanged(true);
            }}
          />
        </Field>
        <label className="check-label">
          <input type="checkbox" checked={hard} onChange={(e) => setHard(e.target.checked)} disabled={!due} />
          This is a hard deadline
        </label>
        <label className="check-label">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          Pin to daily plan
        </label>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          {task && (
            <button
              type="button"
              className="button danger"
              disabled={action.busy}
              onClick={() => {
                if (confirm('Archive this task? Its history will be preserved.'))
                  void action.run(async () => {
                    await api(`/tasks/${task.id}`, { method: 'DELETE', version: task.version });
                    onSaved();
                  });
              }}
            >
              Archive task
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={action.busy}>
            {action.busy ? 'Saving…' : task ? 'Save changes' : 'Create task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ShutdownModal({ date, planId, onClose }: { date: string; planId: string; onClose: () => void }) {
  const preview = useResource<{
    completed_task_ids: string[];
    deferred_item_ids: string[];
    review_count: number;
    research_event_count: number;
    papers_read_count?: number;
    rating_counts: Record<string, number>;
    note: string;
  }>(`/today/shutdown?date=${date}`);
  const [draft, setDraft] = useState<string | null>(null);
  const note = draft ?? preview.data?.note ?? '';
  const [saved, setSaved] = useState(false);
  const action = useAction(() => setSaved(true));
  return (
    <Modal title="Daily reflection" onClose={onClose}>
      <ErrorState error={preview.error} retry={preview.reload} />
      {preview.loading ? (
        <Loading />
      ) : (
        preview.data && (
          <>
            <div className="shutdown-stats">
              {[
                [preview.data.completed_task_ids.length, 'Tasks completed'],
                [preview.data.review_count, 'Review cards'],
                [preview.data.research_event_count, 'Research updates'],
                [preview.data.papers_read_count ?? 0, 'Papers read'],
              ].map(([v, l]) => (
                <div key={l}>
                  <strong>{v}</strong>
                  <span>{l}</span>
                </div>
              ))}
            </div>
            <p className="muted">
              {preview.data.deferred_item_ids.length} items deferred. Unfinished tasks remain available.
            </p>
            <Field label="Where will you pick up tomorrow?">
              <textarea
                rows={3}
                value={note}
                placeholder="One sentence to get you started tomorrow."
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSaved(false);
                }}
              />
            </Field>
            {saved && <Notice>Daily reflection saved.</Notice>}
            {action.error && <Notice tone="error">{action.error}</Notice>}
            <div className="modal-footer">
              <button className="button" onClick={onClose}>
                Close
              </button>
              <button
                className="button primary"
                disabled={saved || action.busy}
                onClick={() =>
                  void action.run(() =>
                    api(`/daily-plans/${planId}/shutdown`, { method: 'POST', body: { note } }),
                  )
                }
              >
                {saved ? 'Saved' : 'Save reflection'}
              </button>
            </div>
          </>
        )
      )}
    </Modal>
  );
}
