'use client';
import { useState } from 'react';
import { api, datetime, localInputToInstant, useAction, useResource, uuid } from '../../lib/api';
import type { Page, Project, Subscription, UserPaper } from '../../lib/types';
import { Badge, Empty, ErrorState, Field, Icon, Loading, MathContent, Modal, Notice, label } from '../ui';

export function DiscoverPage() {
  const [filter, setFilter] = useState('unread');
  const [subscriptionEditor, setSubscriptionEditor] = useState(false);
  const [paperTask, setPaperTask] = useState<UserPaper | null>(null);
  const [projectPaper, setProjectPaper] = useState<UserPaper | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const feed = useResource<Page<UserPaper>>(
    `/arxiv/feed?limit=100${filter === 'saved' ? '&saved=true' : filter === 'all' ? '' : `&status=${filter}`}`,
  );
  const subscriptions = useResource<Page<Subscription>>('/arxiv/subscriptions?limit=100');
  const refresh = () => {
    feed.reload();
    subscriptions.reload();
  };
  const action = useAction(refresh);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">ARXIV DIGEST</span>
          <h1>Find research that speaks to your questions.</h1>
          <p>Clear filters. A daily digest. Reading guided by your research interests.</p>
        </div>
        <div className="heading-actions">
          <button className="button" onClick={feed.reload}>
            <Icon name="refresh" size={16} />
            Refresh feed
          </button>
          <button className="button primary" onClick={() => setSubscriptionEditor(true)}>
            <Icon name="plus" size={17} />
            Add subscription
          </button>
        </div>
      </div>
      <div className="discover-layout">
        <div>
          <div className="collection-toolbar">
            <div className="tabs">
              {[
                ['unread', 'Unread'],
                ['saved', 'Saved'],
                ['read', 'Read'],
                ['all', 'All'],
              ].map(([v, l]) => (
                <button key={v} className={filter === v ? 'active' : ''} onClick={() => setFilter(v)}>
                  {l}
                </button>
              ))}
            </div>
            <span className="muted small-text">{feed.data?.items.length || 0} papers</span>
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
          <ErrorState error={feed.error} retry={feed.reload} />
          {feed.loading && !feed.data && <Loading />}
          {feed.data?.items.length === 0 && (
            <section className="panel">
              <Empty
                icon="discover"
                title={
                  filter === 'saved'
                    ? 'Keep papers worth reading'
                    : 'Your next research discovery starts here'
                }
                action={
                  filter === 'saved' ? (
                    <button className="button" onClick={() => setFilter('unread')}>
                      Browse unread papers
                    </button>
                  ) : (
                    <button className="button primary" onClick={() => setSubscriptionEditor(true)}>
                      Set research interests
                    </button>
                  )
                }
              >
                {filter === 'saved'
                  ? 'Saved papers sync across devices. Turn any paper into a reading task.'
                  : 'Add arXiv categories, keywords, or authors. Matching papers appear after the next background update.'}
              </Empty>
            </section>
          )}
          <div className="paper-list">
            {feed.data?.items.map((up) => {
              const p = up.paper;
              const open = expanded === up.id;
              return (
                <article className="panel paper-card" key={up.id}>
                  <div className="paper-card-top">
                    <div className="inline-actions">
                      {p.categories.slice(0, 3).map((c) => (
                        <Badge key={c} tone="green">
                          {c}
                        </Badge>
                      ))}
                      <span className="small-text muted">v{p.latest_version}</span>
                      {up.status === 'read' && <Badge>Read</Badge>}
                    </div>
                    <span className="small-text muted">{datetime(p.updated_at, true)}</span>
                  </div>
                  <h2>
                    <a href={p.source_url} target="_blank" rel="noreferrer">
                      <MathContent content={p.title} />
                    </a>
                  </h2>
                  <p className="paper-authors">{p.authors.join(' · ')}</p>
                  <MathContent content={p.abstract} className={`paper-abstract ${open ? 'expanded' : ''}`} />
                  <button
                    className="text-link abstract-toggle"
                    onClick={() => setExpanded(open ? null : up.id)}
                  >
                    {open ? 'Hide abstract' : 'Show abstract'}
                  </button>
                  <div className="paper-match">
                    <span className="tiny-star">✧</span>
                    <details>
                      <summary>Why it matches · Score {up.relevance_score}</summary>
                      <ul>
                        {up.match_reasons.map((reason, i) => (
                          <li key={i}>{reason}</li>
                        ))}
                      </ul>
                      <p>
                        Scores explain the ranking. They do not measure paper quality or mathematical
                        relevance.
                      </p>
                    </details>
                  </div>
                  <div className="paper-actions">
                    <button
                      className={`button small ${up.is_saved ? 'saved' : ''}`}
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(() =>
                          up.is_saved
                            ? api(`/arxiv/papers/${p.id}/state`, {
                                method: 'PATCH',
                                version: up.version,
                                body: { is_saved: false },
                              })
                            : api(`/arxiv/papers/${p.id}/save`, { method: 'POST' }),
                        )
                      }
                    >
                      <Icon name="bookmark" size={15} />
                      {up.is_saved ? 'Saved' : 'Save'}
                    </button>
                    <button
                      className="button small"
                      disabled={action.busy || up.status === 'read'}
                      onClick={() =>
                        void action.run(() => api(`/arxiv/papers/${p.id}/mark-read`, { method: 'POST' }))
                      }
                    >
                      <Icon name="check" size={15} />
                      {up.status === 'read' ? 'Read' : 'Mark as read'}
                    </button>
                    <button className="button small" onClick={() => setPaperTask(up)}>
                      Create reading task
                    </button>
                    <button className="button small" onClick={() => setProjectPaper(up)}>
                      Link project
                    </button>
                    <a className="text-link paper-pdf" href={p.pdf_url} target="_blank" rel="noreferrer">
                      PDF
                      <Icon name="external" size={14} />
                    </a>
                    <details className="row-menu">
                      <summary aria-label="More paper actions">···</summary>
                      <div>
                        <a href={p.source_url} target="_blank" rel="noreferrer">
                          Open on arXiv
                        </a>
                        <button
                          onClick={() =>
                            void action.run(() =>
                              api(`/arxiv/papers/${p.id}/state`, {
                                method: 'PATCH',
                                version: up.version,
                                body: { status: 'not_relevant' },
                              }),
                            )
                          }
                        >
                          Mark not relevant
                        </button>
                        {up.status !== 'unread' && (
                          <button
                            onClick={() =>
                              void action.run(() =>
                                api(`/arxiv/papers/${p.id}/state`, {
                                  method: 'PATCH',
                                  version: up.version,
                                  body: { status: 'unread' },
                                }),
                              )
                            }
                          >
                            Mark as unread
                          </button>
                        )}
                      </div>
                    </details>
                  </div>
                </article>
              );
            })}
          </div>
          {feed.data?.next_cursor && (
            <button
              className="button"
              onClick={async () => {
                const next = await api<Page<UserPaper>>(
                  `/arxiv/feed?limit=100&cursor=${encodeURIComponent(feed.data!.next_cursor!)}${filter === 'saved' ? '&saved=true' : filter === 'all' ? '' : `&status=${filter}`}`,
                );
                feed.setData({ ...next, items: [...feed.data!.items, ...next.items] });
              }}
            >
              Load more
            </button>
          )}
        </div>
        <aside>
          <section className="panel subscriptions-panel">
            <div className="panel-heading">
              <h2>Your research radar</h2>
              <button
                className="icon-button"
                aria-label="Add subscription"
                onClick={() => setSubscriptionEditor(true)}
              >
                <Icon name="plus" size={17} />
              </button>
            </div>
            <ErrorState error={subscriptions.error} retry={subscriptions.reload} />
            {subscriptions.data?.items.length === 0 && (
              <p className="panel-description muted">Start with math.AC, math.AG, math.NT, or math.CO.</p>
            )}
            {subscriptions.data?.items.map((s) => (
              <div className="subscription-row" key={s.id}>
                <div>
                  <strong>{s.subscription_value}</strong>
                  <small>
                    {subscriptionLabel(s.subscription_type)} · Weight {s.weight}
                  </small>
                </div>
                <button
                  className={`toggle ${s.enabled ? 'on' : ''}`}
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${s.subscription_value}`}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(`/arxiv/subscriptions/${s.id}`, {
                        method: 'PATCH',
                        version: s.version,
                        body: { enabled: !s.enabled },
                      }),
                    )
                  }
                >
                  <span />
                </button>
                <button
                  className="icon-button danger"
                  aria-label={`Delete subscription ${s.subscription_value}`}
                  onClick={() =>
                    void action.run(() =>
                      api(`/arxiv/subscriptions/${s.id}`, { method: 'DELETE', version: s.version }),
                    )
                  }
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </section>
          <section className="quiet-card small">
            <span className="eyebrow">A QUIETER WAY TO DISCOVER</span>
            <p>
              One digest a day.
              <br />
              Stay close to what matters.
            </p>
            <small>
              Categories, keywords, and authors determine matches. Set notification times and quiet hours in
              Settings.
            </small>
            <a className="text-link" href="/settings">
              Notification settings →
            </a>
          </section>
        </aside>
      </div>
      {subscriptionEditor && (
        <SubscriptionModal
          onClose={() => setSubscriptionEditor(false)}
          onSaved={() => {
            setSubscriptionEditor(false);
            refresh();
          }}
        />
      )}{' '}
      {paperTask && (
        <PaperTaskModal
          paper={paperTask}
          onClose={() => setPaperTask(null)}
          onSaved={() => {
            setPaperTask(null);
            setMessage('Reading task created. You can schedule it in Planner.');
            refresh();
          }}
        />
      )}{' '}
      {projectPaper && (
        <PaperProjectModal
          paper={projectPaper}
          onClose={() => setProjectPaper(null)}
          onSaved={() => {
            setProjectPaper(null);
            setMessage('Paper linked to the research project.');
          }}
        />
      )}
    </>
  );
}
function subscriptionLabel(value: string) {
  return (
    (
      { category: 'arXiv category', keyword: 'Keyword', author: 'Author', topic: 'Research topic' } as Record<
        string,
        string
      >
    )[value] || value
  );
}
function SubscriptionModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [creationId] = useState(uuid);
  const [type, setType] = useState('category');
  const [value, setValue] = useState('');
  const [weight, setWeight] = useState(1);
  const a = useAction(onSaved);
  return (
    <Modal title="Follow your research interests" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api('/arxiv/subscriptions', {
              method: 'POST',
              body: {
                id: creationId,
                subscription_type: type,
                subscription_value: value.trim(),
                weight,
                enabled: true,
              },
            }),
          );
        }}
      >
        <Field label="Subscription type">
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setValue('');
            }}
          >
            {['category', 'keyword', 'author', 'topic'].map((x) => (
              <option key={x} value={x}>
                {subscriptionLabel(x)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Match value"
          hint={type === 'topic' ? 'Topics match text in paper titles and abstracts.' : undefined}
        >
          <input
            required
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              type === 'category'
                ? 'math.AC'
                : type === 'author'
                  ? 'Full author name'
                  : 'For example: monomial ideals'
            }
          />
        </Field>
        {type === 'category' && (
          <div className="quick-tags">
            {['math.AC', 'math.AG', 'math.NT', 'math.CO'].map((c) => (
              <button type="button" className="tag" key={c} onClick={() => setValue(c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        <Field label="Preference weight (1–10)">
          <input
            type="number"
            min="1"
            max="10"
            required
            value={weight}
            onChange={(e) => setWeight(Number(e.target.value))}
          />
        </Field>
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={a.busy}>
            Save subscription
          </button>
        </div>
      </form>
    </Modal>
  );
}
function PaperTaskModal({
  paper,
  onClose,
  onSaved,
}: {
  paper: UserPaper;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [creationId] = useState(uuid);
  const projects = useResource<Page<Project>>('/research/projects?limit=100');
  const [project, setProject] = useState('');
  const [title, setTitle] = useState(`Read: ${paper.paper.title}`.slice(0, 300));
  const [minutes, setMinutes] = useState(45);
  const [due, setDue] = useState('');
  const a = useAction(onSaved);
  return (
    <Modal title="Make reading your next step" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api(`/arxiv/papers/${paper.paper_id}/create-task`, {
              method: 'POST',
              body: {
                id: creationId,
                title,
                estimated_minutes: minutes,
                project_id: project || null,
                due_at: due ? localInputToInstant(due) : null,
              },
            }),
          );
        }}
      >
        <Field label="Reading task">
          <input required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="Estimated minutes">
            <input
              type="number"
              min="1"
              max="1440"
              required
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </Field>
          <Field label="Linked project (optional)">
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Independent reading</option>
              {projects.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Deadline (optional)">
          <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Notice>Each paper can have one unfinished reading task.</Notice>
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={a.busy}>
            Create reading task
          </button>
        </div>
      </form>
    </Modal>
  );
}
function PaperProjectModal({
  paper,
  onClose,
  onSaved,
}: {
  paper: UserPaper;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [creationId] = useState(uuid);
  const projects = useResource<Page<Project>>('/research/projects?limit=100');
  const [project, setProject] = useState('');
  const a = useAction(onSaved);
  return (
    <Modal title="Link a research project" onClose={onClose}>
      <p className="modal-description">{paper.paper.title}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api('/research/paper-links', {
              method: 'POST',
              body: { id: creationId, project_id: project, paper_id: paper.paper_id },
            }),
          );
        }}
      >
        <Field label="Research project">
          <select required value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Choose a project</option>
            {projects.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={a.busy}>
            Create link
          </button>
        </div>
      </form>
    </Modal>
  );
}
