'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, datetime, localInputToInstant, useAction, useResource, uuid } from '../../lib/api';
import type { GuideLanguage } from '../../lib/getting-started-copy';
import {
  isPaperShelf,
  paperShelfQuery,
  paperShelves,
  shelvesForPaper,
  usePaperFolderFeed,
  usePaperFolders,
} from '../../lib/paper-folders';
import {
  FolderGlyph,
  OrganizePaperFolders,
  PaperFolderBar,
  PaperFolderEditor,
  type FolderEditorTarget,
} from '../PaperFolders';
import { ResearchLinkModal } from '../ResearchLinks';
import type { Job, Page, Project, Subscription, UserPaper } from '../../lib/types';
import { Badge, Empty, ErrorState, Field, Icon, Loading, MathContent, Modal, Notice, label } from '../ui';
import { DiscoverForYou } from './DiscoverForYou';
import styles from './DiscoverForYou.module.css';

const exploreFilters = {
  unread: { label: 'Unread', query: '&status=unread' },
  saved: { label: paperShelves.saved, query: paperShelfQuery('saved') },
  interested: { label: paperShelves.interested, query: paperShelfQuery('interested') },
  liked: { label: paperShelves.liked, query: paperShelfQuery('liked') },
  read: { label: 'Read', query: '&status=read' },
  all: { label: 'All', query: '' },
};
type ExploreFilter = keyof typeof exploreFilters;

function exploreFeedPath(filter: ExploreFilter, cursor?: string) {
  const pagination = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
  return `/arxiv/feed?limit=100${exploreFilters[filter].query}${pagination}`;
}

export function DiscoverPage({
  initialView = 'explore',
  initialRefreshJob,
  onOpenInterests,
  guideLanguage,
  userId,
}: {
  initialView?: 'for-you' | 'explore';
  initialRefreshJob?: string;
  onOpenInterests?: () => void;
  guideLanguage?: GuideLanguage;
  userId?: string;
}) {
  const [view, setView] = useState(initialView);
  const [filter, setFilter] = useState<ExploreFilter>('unread');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [folderEditor, setFolderEditor] = useState<FolderEditorTarget | null>(null);
  const [organizing, setOrganizing] = useState<UserPaper | null>(null);
  const [subscriptionEditor, setSubscriptionEditor] = useState(false);
  const [paperTask, setPaperTask] = useState<UserPaper | null>(null);
  const [projectPaper, setProjectPaper] = useState<UserPaper | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [refreshJobId, setRefreshJobId] = useState<string | null>(initialRefreshJob ?? null);
  const folderStore = usePaperFolders(userId);
  const shelf = isPaperShelf(filter) ? filter : null;
  const shelfFolders = shelf ? folderStore.folders.filter((folder) => folder.shelf === shelf) : [];
  const selectedFolder = shelfFolders.find((folder) => folder.id === selectedFolderId) ?? null;
  const feed = useResource<Page<UserPaper>>(selectedFolder ? null : exploreFeedPath(filter));
  const folderFeed = usePaperFolderFeed(selectedFolder);
  const visibleFeed = selectedFolder ? folderFeed : feed;
  const reloadVisibleFeed = visibleFeed.reload;
  const subscriptions = useResource<Page<Subscription>>('/arxiv/subscriptions?limit=100');
  const pagination = useAction();
  const pageRequest = useRef<AbortController | null>(null);
  const reloadFeed = useCallback(() => {
    pageRequest.current?.abort();
    pagination.setError(null);
    reloadVisibleFeed();
  }, [reloadVisibleFeed, pagination.setError]);
  const refresh = () => {
    reloadFeed();
    subscriptions.reload();
  };
  const action = useAction(refresh);
  const requestRefresh = useAction();
  const jobStatus = useResource<Job>(refreshJobId ? `/automation/jobs/${refreshJobId}` : null);
  const job = jobStatus.data?.id === refreshJobId ? jobStatus.data : null;
  const refreshing = requestRefresh.busy || (!!refreshJobId && !jobStatus.error && job?.status !== 'dead');
  function openExplore() {
    if (view === 'explore') return;
    setView('explore');
    reloadFeed();
  }

  function selectFilter(next: ExploreFilter) {
    if (next === filter) {
      selectFolder(null);
      return;
    }
    resetPagination();
    setSelectedFolderId(null);
    setFilter(next);
  }

  function resetPagination() {
    pageRequest.current?.abort();
    pagination.setError(null);
    feed.setData(null);
  }

  function selectFolder(id: string | null) {
    if (id === selectedFolderId) return;
    resetPagination();
    if (id === null && !selectedFolder) feed.reload();
    setSelectedFolderId(id);
  }

  function loadMore() {
    const cursor = feed.data?.next_cursor;
    if (!cursor || feed.loading || pageRequest.current) return;
    const controller = new AbortController();
    pageRequest.current = controller;
    void pagination.run(async () => {
      try {
        const next = await api<Page<UserPaper>>(exploreFeedPath(filter, cursor), {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          feed.setData((page) =>
            page?.next_cursor === cursor ? { ...next, items: [...page.items, ...next.items] } : page,
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        pageRequest.current = null;
      }
    });
  }

  useEffect(() => () => pageRequest.current?.abort(), []);

  useEffect(() => {
    if (!job || jobStatus.error || job.status === 'dead') return;
    if (job.status === 'succeeded') {
      reloadFeed();
      setMessage('Feed refreshed.');
      setRefreshJobId(null);
      return;
    }
    const timer = setTimeout(jobStatus.reload, job.status === 'failed' ? 5000 : 1500);
    return () => clearTimeout(timer);
  }, [job, jobStatus.error, jobStatus.reload, reloadFeed]);

  const reactionEmpty =
    filter === 'liked'
      ? { title: 'No liked papers yet', description: 'Papers you like in For You appear here.' }
      : filter === 'interested'
        ? {
            title: 'No papers marked Interested',
            description: 'Mark a paper Interested in For You to find it here.',
          }
        : null;

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">ARXIV DIGEST</span>
          <h1>Discover</h1>
          <p>
            {view === 'for-you'
              ? 'A short queue of papers chosen for your research interests.'
              : 'Browse and filter recent arXiv papers.'}
          </p>
        </div>
        <div className="heading-actions">
          {onOpenInterests && (
            <button className="button" onClick={onOpenInterests}>
              Choose interests
            </button>
          )}
          <button
            className="button"
            disabled={refreshing}
            onClick={() => {
              setMessage('');
              setRefreshJobId(null);
              void requestRefresh.run(async () => {
                const queued = await api<Job>('/arxiv/refresh', { method: 'POST' });
                setRefreshJobId(queued.id);
              });
            }}
          >
            <Icon name="refresh" size={16} />
            {refreshing ? 'Refreshing feed…' : 'Refresh feed'}
          </button>
          {view === 'explore' && (
            <button className="button primary" onClick={() => setSubscriptionEditor(true)}>
              <Icon name="plus" size={17} />
              Add subscription
            </button>
          )}
        </div>
      </div>
      <div className="collection-toolbar">
        <div className="tabs" role="group" aria-label="Discover view">
          <button
            className={view === 'for-you' ? 'active' : ''}
            aria-pressed={view === 'for-you'}
            onClick={() => setView('for-you')}
          >
            For You
          </button>
          <button
            className={view === 'explore' ? 'active' : ''}
            aria-pressed={view === 'explore'}
            onClick={openExplore}
          >
            Explore
          </button>
        </div>
      </div>
      {requestRefresh.error && <Notice tone="error">{requestRefresh.error}</Notice>}
      {refreshJobId && <ErrorState error={jobStatus.error} retry={jobStatus.reload} />}
      <div role="status">
        {refreshing && !job?.error_message && <Notice>Checking arXiv for your enabled subscriptions…</Notice>}
        {job?.status === 'failed' && (
          <Notice tone="warning">
            arXiv refresh failed. Another attempt is scheduled for {datetime(job.scheduled_at)}.{' '}
            {job.error_message}
          </Notice>
        )}
        {job?.status === 'dead' && (
          <Notice tone="error">The arXiv feed could not be refreshed. {job.error_message}</Notice>
        )}
      </div>
      {view === 'for-you' && !refreshing && (
        <DiscoverForYou
          onExplore={openExplore}
          onLinkResearch={setProjectPaper}
          firstRoundGuideLanguage={initialView === 'for-you' ? guideLanguage : undefined}
        />
      )}
      <div className={`discover-layout ${styles.explore}`} hidden={view !== 'explore'}>
        <div>
          <div className="collection-toolbar">
            <div className="tabs inline-actions" role="group" aria-label="Explore filters">
              {(Object.keys(exploreFilters) as ExploreFilter[]).map((value) => (
                <button
                  key={value}
                  className={`${filter === value ? 'active' : ''} ${isPaperShelf(value) ? styles.folderTab : ''}`}
                  aria-pressed={filter === value}
                  onClick={() => selectFilter(value)}
                >
                  {isPaperShelf(value) && <FolderGlyph />}
                  {exploreFilters[value].label}
                </button>
              ))}
            </div>
            <span className="muted small-text">{visibleFeed.data?.items.length || 0} papers</span>
          </div>
          {userId && shelf && (
            <PaperFolderBar
              shelf={shelf}
              folders={shelfFolders}
              current={selectedFolder}
              onSelect={selectFolder}
              onEdit={setFolderEditor}
            />
          )}
          {message && (
            <Notice>
              {message}
              <button className="icon-button" aria-label="Dismiss message" onClick={() => setMessage('')}>
                <Icon name="close" size={14} />
              </button>
            </Notice>
          )}
          {action.error && <Notice tone="error">{action.error}</Notice>}
          <ErrorState error={visibleFeed.error} retry={reloadFeed} />
          {pagination.error && <Notice tone="error">{pagination.error}</Notice>}
          {visibleFeed.loading && !visibleFeed.data && <Loading />}
          {visibleFeed.data?.items.length === 0 && (
            <section className="panel">
              <Empty
                icon="discover"
                title={
                  selectedFolder
                    ? 'No papers in this folder'
                    : (reactionEmpty?.title ?? (filter === 'saved' ? 'No saved papers yet' : 'No papers yet'))
                }
                action={
                  selectedFolder ? (
                    <button className="button" onClick={() => selectFolder(null)}>
                      Browse {paperShelves[selectedFolder.shelf]}
                    </button>
                  ) : reactionEmpty ? (
                    <button className="button" onClick={() => setView('for-you')}>
                      Open For You
                    </button>
                  ) : filter === 'saved' ? (
                    <button className="button" onClick={() => selectFilter('unread')}>
                      Browse unread papers
                    </button>
                  ) : (
                    <button className="button primary" onClick={() => setSubscriptionEditor(true)}>
                      Set research interests
                    </button>
                  )
                }
              >
                {selectedFolder
                  ? 'Use Organize folders on a paper to add it here.'
                  : (reactionEmpty?.description ??
                    (filter === 'saved'
                      ? 'Saved papers sync across devices. Turn any paper into a reading task.'
                      : 'Add arXiv categories, keywords, or authors. Refresh the feed to check for matching papers.'))}
              </Empty>
            </section>
          )}
          <div className="paper-list">
            {visibleFeed.data?.items.map((up) => {
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
                      {up.for_you_reaction === 'liked' && <Badge tone="purple">Liked</Badge>}
                      {up.for_you_reaction === 'interested' && <Badge tone="purple">Interested</Badge>}
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
                      Link to research
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
                        {userId && shelvesForPaper(up).length > 0 && (
                          <button
                            type="button"
                            onClick={(event) => {
                              const menu = event.currentTarget.closest('details');
                              if (menu) menu.open = false;
                              setOrganizing(up);
                            }}
                          >
                            Organize folders
                          </button>
                        )}
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
          {visibleFeed.data?.next_cursor && (
            <button className="button" disabled={pagination.busy || feed.loading} onClick={loadMore}>
              {pagination.busy ? 'Loading more…' : 'Load more'}
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
              <p className="panel-description muted">Choose the fields you’d like to follow.</p>
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
                  type="button"
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
                />
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
            <span className="eyebrow">DAILY DIGEST</span>
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
      {folderEditor && (
        <PaperFolderEditor target={folderEditor} store={folderStore} onClose={() => setFolderEditor(null)} />
      )}
      {organizing && (
        <OrganizePaperFolders paper={organizing} store={folderStore} onClose={() => setOrganizing(null)} />
      )}
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
        <ResearchLinkModal
          key={projectPaper.paper_id}
          material={{ kind: 'paper', id: projectPaper.paper_id, title: projectPaper.paper.title }}
          onClose={() => setProjectPaper(null)}
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
  const [weight, setWeight] = useState('1');
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
                weight: Number(weight),
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
            onChange={(e) => setWeight(e.target.value)}
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
  const [minutes, setMinutes] = useState('45');
  const [due, setDue] = useState('');
  const a = useAction(onSaved);
  return (
    <Modal title="Create a reading task" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api(`/arxiv/papers/${paper.paper_id}/create-task`, {
              method: 'POST',
              body: {
                id: creationId,
                title,
                estimated_minutes: Number(minutes),
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
              onChange={(e) => setMinutes(e.target.value)}
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
