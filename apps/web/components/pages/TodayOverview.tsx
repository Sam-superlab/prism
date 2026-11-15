import Link from 'next/link';
import { useRef, useState } from 'react';
import type { ReviewProgress } from '../../lib/review-session';
import type { Today } from '../../lib/types';
import { Icon } from '../ui';
import styles from './TodayOverview.module.css';

export function TodayOverview({
  today,
  onShowPlan,
  reviewProgress,
  onReplan,
  replanning,
}: {
  today: Today;
  onShowPlan: (filter: 'pending' | 'completed' | 'deferred') => void;
  reviewProgress: ReviewProgress | null;
  onReplan: (capacityMinutes: number) => Promise<boolean>;
  replanning: boolean;
}) {
  const [capacityDraft, setCapacityDraft] = useState<string>();
  const [selectedReviewDate, setSelectedReviewDate] = useState<string>();
  const capacityDisclosure = useRef<HTMLDetailsElement>(null);
  const pending = Math.max(0, today.planned_count - today.completed_count);
  const deferred =
    today.plan?.items.filter((item) => item.status === 'deferred' || item.status === 'skipped').length ?? 0;
  const progress = today.planned_count ? Math.round((today.completed_count / today.planned_count) * 100) : 0;
  const completedMinutes =
    today.plan?.items
      .filter((item) => item.status === 'completed')
      .reduce((minutes, item) => minutes + item.scheduled_minutes, 0) ?? 0;
  const remainingMinutes = today.estimated_remaining_minutes;
  const scheduledMinutes = completedMinutes + remainingMinutes;
  const capacity = today.capacity_minutes;
  const capacityInput = capacityDraft ?? String(capacity);
  const capacityMinutes = Number(capacityInput);
  const validCapacity =
    capacityInput !== '' &&
    Number.isInteger(capacityMinutes) &&
    capacityMinutes >= 0 &&
    capacityMinutes <= 1440;
  const freeMinutes = Math.max(0, capacity - scheduledMinutes);
  const overMinutes = Math.max(0, scheduledMinutes - capacity);
  const timeScale = Math.max(capacity, scheduledMinutes, 1);
  const reviewDays = today.review_activity ?? [];
  const weeklyReviews = reviewDays.reduce((total, day) => total + day.count, 0);
  const highestDay = Math.max(1, ...reviewDays.map((day) => day.count));
  const selectedReviewDay =
    reviewDays.find((day) => day.date === (selectedReviewDate ?? today.date)) ?? reviewDays.at(-1);
  const dayLabel = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' });
  const fullDayLabel = new Intl.DateTimeFormat('en', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <section
      id="daily-overview"
      className={`panel ${styles.overview}`}
      aria-labelledby="today-overview-heading"
    >
      <div className={styles.heading}>
        <div>
          <span className="eyebrow">DAILY OVERVIEW</span>
          <h2 id="today-overview-heading">Today at a glance</h2>
        </div>
        <nav className={styles.shortcuts} aria-label="Dashboard shortcuts">
          <Link href="/research" className="button small">
            <Icon name="research" size={14} />
            Research tasks <span>{today.research_tasks_due} due</span>
          </Link>
          <Link href="/discover" className="button small" title={`${today.saved_papers} saved papers`}>
            <Icon name="discover" size={14} />
            Paper updates <span>{today.unread_papers} unread</span>
          </Link>
        </nav>
      </div>
      <div className={styles.grid}>
        <section className={styles.metric} aria-labelledby="today-progress-heading">
          <h3 id="today-progress-heading">Plan progress</h3>
          <div className={styles.progress}>
            <div className={styles.ring} aria-hidden="true">
              <svg viewBox="0 0 100 100">
                <circle className={styles.ringTrack} cx="50" cy="50" r="42" />
                {progress > 0 && (
                  <circle
                    className={styles.ringFill}
                    cx="50"
                    cy="50"
                    r="42"
                    pathLength="100"
                    strokeDasharray={`${progress} 100`}
                    transform="rotate(-90 50 50)"
                  />
                )}
              </svg>
              <strong>{today.planned_count ? `${progress}%` : '—'}</strong>
            </div>
            <div className={styles.progressDetail}>
              <strong>
                {today.planned_count
                  ? `${today.completed_count} of ${today.planned_count} completed`
                  : 'No items planned yet'}
              </strong>
              <ul className={styles.legend}>
                {(
                  [
                    ['completed', today.completed_count, 'Done'],
                    ['pending', pending, 'To do'],
                    ['deferred', deferred, 'Deferred or skipped'],
                  ] as const
                ).map(([filter, value, label]) => (
                  <li key={filter}>
                    <button type="button" onClick={() => onShowPlan(filter)}>
                      <span className={styles[filter]} aria-hidden="true" />
                      {value} {label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
        <section className={styles.metric} aria-labelledby="today-capacity-heading">
          <h3 id="today-capacity-heading">Time budget</h3>
          <p className={styles.figure}>
            <strong>{scheduledMinutes}</strong> / {capacity} min planned
          </p>
          <div className={styles.budgetChart} aria-hidden="true">
            {completedMinutes > 0 && (
              <span
                className={styles.completed}
                style={{ width: `${(completedMinutes / timeScale) * 100}%` }}
              />
            )}
            {remainingMinutes > 0 && (
              <span
                className={styles.pending}
                style={{ width: `${(remainingMinutes / timeScale) * 100}%` }}
              />
            )}
            {overMinutes > 0 && (
              <span className={styles.budgetLimit} style={{ left: `${(capacity / timeScale) * 100}%` }} />
            )}
          </div>
          <ul className={`${styles.legend} ${styles.budgetLegend}`}>
            <li>
              <button type="button" onClick={() => onShowPlan('completed')}>
                <span className={styles.completed} aria-hidden="true" />
                {completedMinutes} min in completed items
              </button>
            </li>
            <li>
              <button type="button" onClick={() => onShowPlan('pending')}>
                <span className={styles.pending} aria-hidden="true" />
                {remainingMinutes} min remaining
              </button>
            </li>
            {overMinutes > 0 ? (
              <li className={styles.over}>
                <span aria-hidden="true" />
                {today.plan?.overload_minutes
                  ? `Pinned tasks and hard deadlines exceed capacity by ${overMinutes} min.`
                  : `${overMinutes} min over capacity`}
              </li>
            ) : (
              <li>
                <span className={styles.unallocated} aria-hidden="true" />
                {freeMinutes} min unallocated
              </li>
            )}
          </ul>
          <div className={styles.budgetActions}>
            <details ref={capacityDisclosure} className={styles.capacityDisclosure}>
              <summary className="button small">
                Adjust time
                <Icon name="chevron" size={13} />
              </summary>
              <form
                className={styles.capacityForm}
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!validCapacity || replanning || !(await onReplan(capacityMinutes))) return;
                  setCapacityDraft(undefined);
                  const disclosure = capacityDisclosure.current;
                  if (!disclosure?.open) return;
                  if (disclosure.contains(document.activeElement))
                    disclosure.querySelector('summary')?.focus();
                  disclosure.open = false;
                }}
              >
                <label>
                  <span>Daily capacity</span>
                  <span className={styles.capacityField}>
                    <input
                      aria-label="Daily capacity in minutes"
                      type="number"
                      min="0"
                      max="1440"
                      step="1"
                      required
                      value={capacityInput}
                      onChange={(event) => setCapacityDraft(event.target.value)}
                    />
                    min
                  </span>
                </label>
                <button className="button small soft" type="submit" disabled={!validCapacity || replanning}>
                  Apply
                </button>
              </form>
            </details>
            <button
              className="button small"
              type="button"
              disabled={replanning}
              onClick={() => void onReplan(capacity)}
            >
              <Icon name="refresh" size={13} />
              {replanning ? 'Planning…' : 'Replan'}
            </button>
          </div>
        </section>
        <section className={styles.metric} aria-labelledby="today-review-heading">
          <h3 id="today-review-heading">Review</h3>
          <p className={styles.figure}>
            <strong>{today.reviews_due_now}</strong> due now · {today.reviews_due_by_end_of_day} due today
          </p>
          {reviewProgress && (
            <div className={styles.reviewProgress}>
              <label>
                <span>
                  {reviewProgress.reviewed} of {reviewProgress.total} reviewed
                </span>
                <progress value={reviewProgress.reviewed} max={reviewProgress.total} />
              </label>
            </div>
          )}
          <Link
            className={`button small soft ${styles.reviewAction}`}
            href={reviewProgress?.href ?? '/review/session'}
          >
            {reviewProgress ? 'Continue review' : today.reviews_due_now ? 'Start review' : 'Open review'}
            <Icon name="arrow" size={14} />
          </Link>
          {reviewDays.length > 0 && (
            <div className={styles.reviewHistory}>
              <p className={styles.historyTotal}>
                {weeklyReviews} {weeklyReviews === 1 ? 'rating' : 'ratings'} in the last 7 days
              </p>
              <ol className={styles.reviewChart} aria-label="Review ratings by day">
                {reviewDays.map(({ date, count }) => {
                  const day = new Date(`${date}T00:00:00Z`);
                  const isToday = date === today.date;
                  const description = `${fullDayLabel.format(day)}${isToday ? ', today' : ''}: ${count} ${count === 1 ? 'rating' : 'ratings'}`;
                  return (
                    <li key={date}>
                      <button
                        type="button"
                        className={isToday ? styles.currentDay : undefined}
                        aria-label={description}
                        aria-pressed={selectedReviewDay?.date === date}
                        onClick={() => setSelectedReviewDate(date)}
                      >
                        <span className={styles.barTrack} aria-hidden="true">
                          <span
                            className={styles.barFill}
                            style={{ height: `${(count / highestDay) * 100}%` }}
                          />
                        </span>
                        <span aria-hidden="true">{dayLabel.format(day)}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              {selectedReviewDay && (
                <p className={styles.dayDetail} role="status">
                  {fullDayLabel.format(new Date(`${selectedReviewDay.date}T00:00:00Z`))} ·{' '}
                  {selectedReviewDay.count} {selectedReviewDay.count === 1 ? 'rating' : 'ratings'}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
