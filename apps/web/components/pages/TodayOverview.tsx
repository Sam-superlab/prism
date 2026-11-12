import type { Today } from '../../lib/types';
import styles from './TodayOverview.module.css';

export function TodayOverview({
  today,
  onShowPlan,
}: {
  today: Today;
  onShowPlan: (filter: 'pending' | 'completed' | 'deferred') => void;
}) {
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
  const freeMinutes = Math.max(0, capacity - scheduledMinutes);
  const overMinutes = Math.max(0, scheduledMinutes - capacity);
  const timeScale = Math.max(capacity, scheduledMinutes, 1);
  const reviewDays = today.review_activity ?? [];
  const weeklyReviews = reviewDays.reduce((total, day) => total + day.count, 0);
  const highestDay = Math.max(1, ...reviewDays.map((day) => day.count));
  const dayLabel = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' });
  const fullDayLabel = new Intl.DateTimeFormat('en', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <section className={`panel ${styles.overview}`} aria-labelledby="today-overview-heading">
      <div className={styles.heading}>
        <span className="eyebrow">DAILY OVERVIEW</span>
        <h2 id="today-overview-heading">Today at a glance</h2>
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
              <span className={styles.completed} aria-hidden="true" />
              {completedMinutes} min in completed items
            </li>
            <li>
              <span className={styles.pending} aria-hidden="true" />
              {remainingMinutes} min remaining
            </li>
            {overMinutes > 0 ? (
              <li className={styles.over}>
                <span aria-hidden="true" />
                {overMinutes} min over capacity
              </li>
            ) : (
              <li>
                <span className={styles.unallocated} aria-hidden="true" />
                {freeMinutes} min unallocated
              </li>
            )}
          </ul>
        </section>
        {reviewDays.length > 0 && (
          <section className={styles.metric} aria-labelledby="today-review-activity-heading">
            <h3 id="today-review-activity-heading">Review activity</h3>
            <p className={styles.figure}>
              <strong>{weeklyReviews}</strong> {weeklyReviews === 1 ? 'rating' : 'ratings'} in the last 7 days
            </p>
            <ol className={styles.reviewChart} aria-label="Review ratings by day">
              {reviewDays.map(({ date, count }) => {
                const day = new Date(`${date}T00:00:00Z`);
                const isToday = date === today.date;
                return (
                  <li
                    key={date}
                    className={isToday ? styles.currentDay : undefined}
                    title={`${fullDayLabel.format(day)}: ${count} ${count === 1 ? 'rating' : 'ratings'}`}
                  >
                    <span className={styles.srOnly}>
                      {fullDayLabel.format(day)}
                      {isToday ? ', today' : ''}: {count} {count === 1 ? 'rating' : 'ratings'}
                    </span>
                    <span className={styles.dayCount} aria-hidden="true">
                      {count}
                    </span>
                    <span className={styles.barTrack} aria-hidden="true">
                      <span className={styles.barFill} style={{ height: `${(count / highestDay) * 100}%` }} />
                    </span>
                    <span aria-hidden="true">{dayLabel.format(day)}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </div>
    </section>
  );
}
