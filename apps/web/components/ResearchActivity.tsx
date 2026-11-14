'use client';

import Link from 'next/link';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, useResource } from '../lib/api';
import { researchQuestionHref } from '../lib/research-question-links';
import { ErrorState, Loading, Modal } from './ui';
import styles from './ResearchActivity.module.css';

type Activity = { start_date: string; end_date: string; days: { date: string; count: number }[] };
type Event = {
  id: string;
  project_id: string;
  project_title: string;
  project_open: boolean;
  object_id: string | null;
  object_title: string | null;
  object_type: string | null;
  created_at: string;
  event_type: string;
  event_payload: Record<string, unknown>;
};
type ActivityDay = { items: Event[]; timezone: string; next_cursor: string | null };

const dateLabel = new Intl.DateTimeFormat('en', { dateStyle: 'full', timeZone: 'UTC' });
const monthLabel = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' });
const dayInMs = 86_400_000;
const dayDate = (date: string) => new Date(date + 'T00:00:00Z');
const countLabel = (count: number) => `${count} research ${count === 1 ? 'change' : 'changes'}`;
const eventLabels: Record<string, string> = {
  project_created: 'Project created',
  project_updated: 'Project edited',
  object_created: 'Research record added',
  object_updated: 'Research record edited',
  object_deleted: 'Research record archived',
  object_archived: 'Research record archived',
  claim_status_changed: 'Claim status changed',
  question_status_changed: 'Question status changed',
  question_link_added: 'Question link added',
  question_link_removed: 'Question link removed',
  task_completed: 'Research task completed',
};

const fieldLabels: Record<string, string> = {
  content: 'content', title: 'title', proof_content: 'proof', evidence_reference: 'evidence reference',
  evidence_metadata: 'computational evidence', claim_status: 'claim status', question_status: 'question status',
  object_type: 'record type', description: 'description', notes: 'notes', importance: 'importance',
  status: 'status', research_area: 'research area', deadline: 'deadline',
  source_code_locations: 'source code locations', started_at: 'start date',
};

function eventHref(event: Event) {
  if (!event.project_open) return;
  if (!event.object_id) return `/research/${event.project_id}`;
  if (event.object_type === 'question') return researchQuestionHref(event.project_id, event.object_id);
  if (event.object_type) return `/research/${event.project_id}?object=${event.object_id}`;
}

export function ResearchActivity({ projectId }: { projectId?: string }) {
  const heading = useId();
  const params = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  const activity = useResource<Activity>(`/research/activity${params}`);
  const [selected, setSelected] = useState<string>();
  const [focusDate, setFocusDate] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const reload = activity.reload;
  useEffect(() => {
    window.addEventListener('prism:research-history-changed', reload);
    window.addEventListener('focus', reload);
    return () => {
      window.removeEventListener('prism:research-history-changed', reload);
      window.removeEventListener('focus', reload);
    };
  }, [reload]);

  const summary = activity.data;
  const endDate = summary?.end_date;
  useLayoutEffect(() => {
    if (endDate && scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, [endDate]);
  const title = projectId ? 'Research timeline' : 'Research activity';

  function navigateDays(event: KeyboardEvent<HTMLButtonElement>) {
    const directions: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
    const offset = directions[event.key];
    const grid = event.currentTarget.closest('[data-research-calendar]');
    if (offset === undefined || !grid) return;
    event.preventDefault();
    const target = new Date(dayDate(event.currentTarget.dataset.day!).getTime() + offset * dayInMs);
    const button = grid.querySelector<HTMLButtonElement>(`[data-day="${target.toISOString().slice(0, 10)}"]`);
    button?.focus();
  }

  const counts = new Map(summary?.days.map(({ date, count }) => [date, count]));
  const first = summary ? dayDate(summary.start_date) : new Date(0);
  const total = summary?.days.reduce((sum, day) => sum + day.count, 0) ?? 0;
  const weekStart = (first.getUTCDay() + 6) % 7;
  const dates = summary ? Array.from({ length: 365 }, (_, index) => {
    const day = new Date(first.getTime() + index * dayInMs);
    const date = day.toISOString().slice(0, 10);
    const cell = index + weekStart;
    return { day, date, col: Math.floor(cell / 7) + 2, row: cell % 7 + 2, count: counts.get(date) ?? 0 };
  }) : [];
  const months = new Map<number, string>();
  for (const { day, col } of dates) {
    if ((day.getUTCDate() === 1 || months.size === 0) && !months.has(col)) months.set(col, monthLabel.format(day));
  }
  // Reserve a few columns for the label of each month.
  let lastMonth = -3;
  const monthPositions = [...months].filter(([col]) => {
    if (col - lastMonth < 3) return false;
    lastMonth = col;
    return true;
  });

  return (
    <section className={`panel ${styles.panel}`} aria-labelledby={heading}>
      <div className={styles.heading}>
        <h2 id={heading}>{title}</h2>
        {summary && <p>{countLabel(total)} in the past year</p>}
      </div>
      <ErrorState error={activity.error} retry={reload} />
      {activity.loading && !summary && <Loading />}
      {summary && <>
        <div className={styles.scroller} ref={scroll}>
          <div className={styles.calendar} data-research-calendar aria-label="Research activity by date"
            role="group" style={{ gridTemplateColumns: `2.25rem repeat(${dates.at(-1)!.col - 1}, minmax(12px, 1fr))` }}>
            {monthPositions.map(([col, title]) => <span key={col} aria-hidden="true" className={styles.month}
              style={{ gridColumn: `${col} / span ${Math.min(3, dates.at(-1)!.col - col + 1)}`, gridRow: 1 }}>{title}</span>)}
            {[['Mon', 2], ['Wed', 4], ['Fri', 6]].map(([label, row]) =>
              <span key={label} className={styles.weekday} aria-hidden="true" style={{ gridRow: row, gridColumn: 1 }}>{label}</span>)}
            {dates.map(({ date, day, col, row, count }) => {
              const name = `${dateLabel.format(day)} · ${countLabel(count)}`;
              const level = count >= 8 ? 4 : count >= 4 ? 3 : count >= 2 ? 2 : count;
              return <button type="button" key={date} className={styles.cell} data-day={date} data-level={level}
                style={{ gridColumn: col, gridRow: row }} title={name} aria-label={name} aria-haspopup="dialog"
                tabIndex={(focusDate ?? summary.end_date) === date ? 0 : -1}
                onFocus={() => setFocusDate(date)} onKeyDown={navigateDays} onClick={() => setSelected(date)} />;
            })}
          </div>
        </div>
        <div className={styles.legend} aria-hidden="true">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => <span className={styles.swatch} data-level={level} key={level} />)}
          <span>More</span>
        </div>
      </>}
      {selected && <DayHistory key={selected} date={selected} projectId={projectId} onClose={() => setSelected(undefined)} />}
    </section>
  );
}

function DayHistory({ date, projectId, onClose }: { date: string; projectId?: string; onClose: () => void }) {
  const query = new URLSearchParams({ date, limit: '50', ...(projectId && { project_id: projectId }) });
  const path = `/research/activity/day?${query}`;
  const day = useResource<ActivityDay>(path);
  const [moreError, setMoreError] = useState<Error | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  async function loadMore() {
    const cursor = day.data?.next_cursor;
    if (!cursor || loadingMore) return;
    setMoreError(null);
    setLoadingMore(true);
    try {
      const next = await api<ActivityDay>(`${path}&cursor=${encodeURIComponent(cursor)}`);
      day.setData((current) => current?.next_cursor === cursor ? {
        ...next, items: [...current.items, ...next.items],
      } : current);
    } catch (error) {
      setMoreError(error instanceof Error ? error : new Error('Unable to load more research changes.'));
    } finally {
      setLoadingMore(false);
    }
  }

  return <Modal title={dateLabel.format(dayDate(date))} onClose={onClose} wide>
    <ErrorState error={day.error} retry={day.reload} />
    {day.loading && !day.data && <Loading />}
    {day.data && (day.data.items.length === 0 ? <p className="muted">No research changes were recorded on this date.</p> :
      <ol className={styles.events} aria-label="Recorded research changes">
        {day.data.items.map((event) => {
          const payload = event.event_payload;
          const title = typeof payload.title === 'string' ? payload.title :
            event.object_title ?? event.project_title;
          const href = eventHref(event);
          const before = event.event_type === 'question_status_changed' ? payload.previous_question_status : payload.previous_status;
          const after = event.event_type === 'question_status_changed' ? payload.question_status : payload.claim_status;
          const changed = Array.isArray(payload.changed_fields)
            ? payload.changed_fields.filter((field): field is string => typeof field === 'string').map((field) => fieldLabels[field] ?? field.replaceAll('_', ' '))
            : [];
          const time = new Date(event.created_at).toLocaleTimeString([], { timeZone: day.data!.timezone, hour: 'numeric', minute: '2-digit' });
          return <li key={event.id}>
            <time dateTime={event.created_at}>{time}</time>
            <div>
              <h3>{eventLabels[event.event_type] ?? event.event_type.replaceAll('_', ' ')}</h3>
              {href ? <Link className="text-link" href={href} onClick={onClose}>{title}</Link> : <p>{title}</p>}
              {!projectId && event.project_title !== title && <p className="muted">{event.project_title}</p>}
              {typeof before === 'string' && typeof after === 'string' && before !== after &&
                <p className="muted">{before.replaceAll('_', ' ')} → {after.replaceAll('_', ' ')}</p>}
              {changed.length > 0 && <p className="muted">Changed {changed.join(', ')}</p>}
            </div>
          </li>;
        })}
      </ol>)}
    <ErrorState error={moreError} />
    {day.data?.next_cursor && <button className="button small" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
      {loadingMore ? 'Loading…' : 'Load more changes'}
    </button>}
  </Modal>;
}
