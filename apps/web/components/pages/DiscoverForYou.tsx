'use client';

import { useRef, useState } from 'react';
import { api, datetime, useAction, useResource, uuid } from '../../lib/api';
import type { UserPaper } from '../../lib/types';
import { Badge, Empty, ErrorState, Field, Icon, Loading, MathContent, Notice } from '../ui';
import styles from './DiscoverForYou.module.css';

type Reaction = 'interested' | 'liked' | 'not_interested' | 'skip';
type KeywordMode = 'follow' | 'less';
type DailyQueue = {
  date: string;
  round: number;
  can_review_more: boolean;
  items: { paper: UserPaper; reason: string; done: boolean; reaction: Reaction | null }[];
  keywords: { term: string; mode: KeywordMode }[];
  suggestions: string[];
};
type Decision = Reaction | 'save';
type Command =
  | { paper_id: string; action: Decision }
  | { term: string; mode: KeywordMode | 'remove' }
  | { date: string; round: number };

const decisions: { action: Decision; label: string }[] = [
  { action: 'interested', label: 'Interested' },
  { action: 'liked', label: 'Like' },
  { action: 'save', label: 'Save' },
  { action: 'not_interested', label: 'Not interested' },
  { action: 'skip', label: 'Skip' },
];
const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

export function DiscoverForYou({
  onExplore,
  onLinkResearch,
}: {
  onExplore: () => void;
  onLinkResearch: (paper: UserPaper) => void;
}) {
  const queue = useResource<DailyQueue>('/arxiv/for-you');
  const action = useAction();
  const [term, setTerm] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const inFlight = useRef(false);
  const retry = useRef<{ signature: string; key: string } | null>(null);

  async function readQueue() {
    queue.setData(await api<DailyQueue>('/arxiv/for-you'));
    setNeedsReload(false);
  }

  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await action.run(work);
    } finally {
      inFlight.current = false;
    }
  }

  function submit(body: Command, onSaved?: () => void) {
    if (needsReload) return;
    const endpoint = 'action' in body ? 'reaction' : 'term' in body ? 'keywords' : 'more';
    void run(async () => {
      const signature = JSON.stringify(body);
      const key = retry.current?.signature === signature ? retry.current.key : uuid();
      retry.current = { signature, key };
      await api(`/arxiv/for-you/${endpoint}`, { method: 'POST', body, key });
      retry.current = null;
      setNeedsReload(true);
      onSaved?.();
      await readQueue();
    });
  }

  const data = queue.data;
  const disabled = action.busy || queue.loading || needsReload || !!queue.error;
  const completed = data?.items.filter((item) => item.done).length ?? 0;
  const total = data?.items.length ?? 0;
  const current = data?.items.find((item) => !item.done);
  const paper = current?.paper.paper;
  const canReviewMore = !current && data?.can_review_more;

  function addKeyword(mode: KeywordMode) {
    const value = term.trim();
    if (value) submit({ term: value, mode }, () => setTerm(''));
  }

  return (
    <>
      <ErrorState error={queue.error} retry={queue.reload} />
      {queue.loading && !data && <Loading />}
      {action.error && (
        <div className={styles.feedback} role="alert">
          <Notice tone="error">
            {needsReload ? 'Your change was saved, but the queue could not be reloaded.' : action.error}
            {needsReload && (
              <button className="button small" disabled={action.busy} onClick={() => void run(readQueue)}>
                Reload queue
              </button>
            )}
          </Notice>
        </div>
      )}
      {data && (
        <div className="discover-layout">
          <section className={styles.queue} aria-label="Daily recommendations">
            <div className={styles.queueHeader}>
              <div>
                <span className="eyebrow">DAILY QUEUE{data.round > 1 ? ` · ROUND ${data.round}` : ''}</span>
                <time className="small-text muted" dateTime={data.date}>
                  {dateFormat.format(new Date(`${data.date}T00:00:00Z`))}
                </time>
              </div>
              <span className="small-text muted" role="status">
                {action.busy
                  ? 'Updating queue…'
                  : total
                    ? `${completed} of ${total} reviewed`
                    : 'No papers to review'}
              </span>
            </div>
            {total > 0 && (
              <progress
                className={styles.progress}
                max={total}
                value={completed}
                aria-label="Daily queue progress"
              />
            )}
            {current && paper ? (
              <article className="panel paper-card" aria-label="Recommended paper">
                <div className="paper-card-top">
                  <div className="inline-actions">
                    {paper.categories.slice(0, 3).map((category) => (
                      <Badge key={category} tone="green">
                        {category}
                      </Badge>
                    ))}
                    {current.paper.is_saved && <Badge>Saved</Badge>}
                  </div>
                  <span className="small-text muted">{datetime(paper.updated_at, true)}</span>
                </div>
                <h2>
                  <a href={paper.source_url} target="_blank" rel="noreferrer">
                    <MathContent content={paper.title} />
                  </a>
                </h2>
                <p className="paper-authors">{paper.authors.join(' · ')}</p>
                <MathContent content={paper.abstract} className="paper-abstract expanded" />
                <div className={styles.reason}>
                  <span className="eyebrow">WHY THIS PAPER</span>
                  <p>{current.reason}</p>
                </div>
                <div className={styles.decisions} aria-label="Paper feedback" role="group">
                  {decisions.map(({ action: decision, label }) => (
                    <button
                      key={decision}
                      type="button"
                      className={`button small${decision === 'interested' ? ' primary' : ''}`}
                      disabled={disabled}
                      onClick={() => submit({ paper_id: paper.id, action: decision })}
                    >
                      {decision === 'save' && <Icon name="bookmark" size={15} />}
                      {label}
                    </button>
                  ))}
                  <button className="button small" type="button" onClick={() => onLinkResearch(current.paper)}>
                    Link to research
                  </button>
                  <a className="text-link" href={paper.pdf_url} target="_blank" rel="noreferrer">
                    PDF <Icon name="external" size={14} />
                  </a>
                </div>
              </article>
            ) : (
              <section className="panel">
                <Empty
                  icon={total ? 'check' : 'discover'}
                  title={
                    canReviewMore ? 'Round complete' : total ? 'You’re caught up' : 'No recommendations yet'
                  }
                  action={
                    <div className="inline-actions centered">
                      {canReviewMore && (
                        <button
                          className="button primary"
                          disabled={disabled}
                          onClick={() => submit({ date: data.date, round: data.round })}
                        >
                          Review more
                        </button>
                      )}
                      <button className="button" onClick={onExplore}>
                        Open Explore
                      </button>
                    </div>
                  }
                >
                  {canReviewMore
                    ? 'You reviewed every paper in this round. You can start another round when you’re ready.'
                    : total
                      ? 'You’ve reached the end of today’s recommendations. Browse the feed or revisit saved papers in Explore.'
                      : 'New matches from your arXiv subscriptions can appear here. Manage subscriptions in Explore.'}
                </Empty>
              </section>
            )}
          </section>
          <aside className={`panel subscriptions-panel ${styles.keywords}`} aria-label="Research interests">
            <div className="panel-heading">
              <h2>Research interests</h2>
            </div>
            <p className="panel-description muted">
              Follow topics you want to see more often, or show less of a topic. Active projects and their
              linked notes and papers also guide new rounds.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                addKeyword('follow');
              }}
            >
              <Field label="Keyword">
                <input
                  value={term}
                  maxLength={100}
                  onChange={(event) => setTerm(event.target.value)}
                  placeholder="e.g. monomial ideals"
                  disabled={disabled}
                />
              </Field>
              <div className="inline-actions">
                <button className="button small primary" type="submit" disabled={disabled || !term.trim()}>
                  Follow
                </button>
                <button
                  className="button small"
                  type="button"
                  disabled={disabled || !term.trim()}
                  onClick={() => addKeyword('less')}
                >
                  Show less
                </button>
              </div>
            </form>
            {data.keywords.length > 0 && (
              <ul className={styles.keywordList}>
                {data.keywords.map((keyword) => (
                  <li className={styles.keywordRow} key={keyword.term}>
                    <div>
                      <span>{keyword.term}</span>
                      <small className="muted">
                        {keyword.mode === 'follow' ? 'Following' : 'Showing less'}
                      </small>
                    </div>
                    <div className="inline-actions">
                      <button
                        className="text-link"
                        aria-label={`${keyword.mode === 'follow' ? 'Show less of' : 'Follow'} ${keyword.term}`}
                        disabled={disabled}
                        onClick={() =>
                          submit({ term: keyword.term, mode: keyword.mode === 'follow' ? 'less' : 'follow' })
                        }
                      >
                        {keyword.mode === 'follow' ? 'Show less' : 'Follow'}
                      </button>
                      <button
                        className="icon-button danger"
                        aria-label={`Remove keyword ${keyword.term}`}
                        disabled={disabled}
                        onClick={() => submit({ term: keyword.term, mode: 'remove' })}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {data.suggestions.length > 0 && (
              <div className={styles.suggestions}>
                <h3 className="section-small-title">Suggested keywords</h3>
                <p className="panel-description muted">
                  Terms from the{' '}
                  <a href="https://encyclopediaofmath.org/wiki/Main_Page" target="_blank" rel="noreferrer">
                    Encyclopedia of Mathematics
                  </a>{' '}
                  that recur in papers you’ve liked, saved, or marked Interested.
                </p>
                <div className="inline-actions">
                  {data.suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      className="button small"
                      aria-label={`Follow ${suggestion}`}
                      disabled={disabled}
                      onClick={() => submit({ term: suggestion, mode: 'follow' })}
                    >
                      <Icon name="plus" size={13} />
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
