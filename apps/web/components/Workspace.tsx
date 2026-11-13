'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Activity, useCallback, useEffect, useState, type MouseEvent } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import { scopedPath, type StudyScope } from '../lib/knowledge-scope';
import { shortcutPlatform, workspaceShortcutFor } from '../lib/workspace-shortcuts';
import type { Page, Project, Today, User } from '../lib/types';
import { ErrorState, Field, Icon, Loading, Modal, Notice } from './ui';
import { TodayPage } from './pages/Today';
import { FocusCompletionNotice, FocusTimerStatus, useFocusTimer } from './pages/FocusTimer';
import { KnowledgePage, ReviewPage } from './pages/Knowledge';
import { ResearchPage } from './pages/Research';
import { DiscoverPage } from './pages/Discover';
import { SettingsPage } from './pages/Settings';
import { PracticePage } from './pages/Practice';
import { GettingStarted, useGettingStarted } from './GettingStarted';
import { WorkspaceGraphPage } from './ConnectionGraph';
import { destinations, tabDestination, tabPath, useWorkspaceTabs, WorkspaceTabList } from './WorkspaceTabs';

const navigation = destinations.filter(({ path }) => path !== 'settings');
const sidebarPreference = 'prism.sidebar.pinned';
const layoutPreference = 'prism.tabs.layout';

function chapterBound(value: string | null) {
  return value && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : undefined;
}

function entityId(value: string | null) {
  return value && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value) ? value : undefined;
}

export default function Workspace() {
  const router = useRouter();
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const [vertical, setVertical] = useState(false);
  const [newTab, setNewTab] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState(true);
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const [capture, setCapture] = useState(false);
  const [search, setSearch] = useState(false);
  const [dashboardRevision, setDashboardRevision] = useState(0);
  const [online, setOnline] = useState(true);
  const [searchKeys, setSearchKeys] = useState('⌘ K');
  const me = useResource<User>('/me');
  const tabState = useWorkspaceTabs(query ? `${pathname}?${query}` : pathname, me.data?.id);
  const focusTimer = useFocusTimer(me.data?.id);
  useEffect(() => {
    const openFocus = () => {
      const timer = document.querySelector<HTMLElement>('main:not([hidden]) #focus-timer');
      if (timer) {
        timer.scrollIntoView({ block: 'start' });
        timer.querySelector<HTMLElement>('#focus-timer-heading')?.focus({ preventScroll: true });
      } else router.push('/today#focus-timer');
    };
    window.addEventListener('prism:open-focus', openFocus);
    return () => window.removeEventListener('prism:open-focus', openFocus);
  }, [router]);
  const guide = useGettingStarted(me.data?.id, pathname === '/today');
  function openInterests() {
    guide.update({ ...guide.progress, status: 'welcome' });
  }
  function openFirstRound(jobId?: string) {
    const query = new URLSearchParams({ view: 'for-you' });
    if (jobId) query.set('refresh', jobId);
    router.push(`/discover?${query}`);
  }
  const projects = useResource<Page<Project>>('/research/projects?limit=5');
  const active = tabDestination(pathname)?.path;
  function openTabPicker() {
    setMobileNav(false);
    setSidebarPeek(false);
    setNewTab(true);
    setSearch(true);
  }

  function toggleTabLayout() {
    setVertical(!vertical);
    if (!vertical && !sidebarPinned) toggleSidebar();
    try {
      localStorage.setItem(layoutPreference, vertical ? 'horizontal' : 'vertical');
    } catch {
      // Keep the layout for this session.
    }
  }

  function openLinkInTab(event: MouseEvent) {
    if (!(event.metaKey || event.ctrlKey || event.button === 1) || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || link.target || link.download || link.origin !== location.origin) return;
    if (!tabDestination(link.pathname) || link.pathname === '/knowledge/export') return;
    event.preventDefault();
    tabState.open(link.pathname + link.search + link.hash);
    setSidebarPeek(false);
    setMobileNav(false);
    setSearch(false);
  }

  useEffect(() => {
    try {
      setSidebarPinned(window.localStorage.getItem(sidebarPreference) !== 'false');
      setVertical(localStorage.getItem(layoutPreference) === 'vertical');
    } catch {
      // The sidebar can still be toggled when storage is unavailable.
    }
    const update = () => setOnline(navigator.onLine);
    update();
    setSearchKeys(shortcutPlatform(navigator.userAgent) === 'apple' ? '⌘ K' : 'Ctrl K');
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const toggleSidebar = useCallback(() => {
    const pinned = !sidebarPinned;
    setSidebarPinned(pinned);
    setSidebarPeek(false);
    try {
      window.localStorage.setItem(sidebarPreference, String(pinned));
    } catch {
      // Keep the choice for this view even if it cannot be persisted.
    }
  }, [sidebarPinned]);
  useEffect(() => {
    const openSettings = () => {
      if (document.querySelector('dialog[open]')) return;
      setMobileNav(false);
      setSidebarPeek(false);
      router.push('/settings');
    };
    const handleKey = (event: KeyboardEvent) => {
      const action = workspaceShortcutFor(event);
      if (!action) return;
      if (action === 'escape') {
        setSidebarPeek(false);
        setMobileNav(false);
        return; // Native dialog cancellation handles Escape.
      }
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      switch (action) {
        case 'settings':
          openSettings();
          break;
        case 'search':
          setNewTab(false);
          setSearch(true);
          break;
        case 'capture':
          setCapture(true);
          break;
        case 'sidebar':
          if (window.matchMedia('(max-width: 800px)').matches) setMobileNav((open) => !open);
          else toggleSidebar();
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    window.addEventListener('prism:open-settings', openSettings);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('prism:open-settings', openSettings);
    };
  }, [router, toggleSidebar]);
  return (
    <div
      className={`app-shell workspace-with-tabs ${sidebarPinned ? '' : 'sidebar-collapsed'}`}
      data-tab-layout={vertical ? 'vertical' : 'horizontal'}
      onClickCapture={openLinkInTab}
      onAuxClickCapture={(event) => { if (event.button === 1) openLinkInTab(event); }}
    >
      {mobileNav && (
        <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />
      )}
      <div
        className={`sidebar-region ${sidebarPeek ? 'is-peeking' : ''}`}
        onPointerEnter={(event) => {
          if (!sidebarPinned && event.pointerType === 'mouse' && event.currentTarget.clientWidth)
            setSidebarPeek(true);
        }}
        onPointerLeave={() => setSidebarPeek(false)}
      >
        <aside
          id="workspace-sidebar"
          className={`sidebar ${mobileNav ? 'is-open' : ''}`}
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('a')) {
              setSidebarPeek(false);
              setMobileNav(false);
            }
          }}
        >
          <Link href="/today" className="brand" aria-label="PRISM Dashboard">
            <span className="prism-symbol">
              <img src="/prism-mark.svg" width={36} height={36} alt="" />
            </span>
            <span>
              PRISM
            </span>
          </Link>
          {vertical && <WorkspaceTabList state={tabState} onOpen={openTabPicker} />}
          <div className="sidebar-caption">WORKSPACE</div>
          <nav aria-label="Main navigation">
            {navigation.map((item) => (
              <Link
                key={item.path}
                href={`/${item.path}`}
                className={`nav-link ${active === item.path ? 'active' : ''}`}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {active === item.path && <i />}
              </Link>
            ))}
          </nav>
          <div className="sidebar-divider" />
          <div className="sidebar-caption project-caption">
            ACTIVE PROJECTS
            <Link href="/research" aria-label="Manage research projects">
              <Icon name="plus" size={16} />
            </Link>
          </div>
          <div className="project-shortcuts">
            {projects.data?.items
              .filter((x) => x.status === 'active')
              .map((p) => (
                <Link key={p.id} href={`/research/${p.id}`}>
                  <span className="project-dot" />
                  {p.title}
                  <Icon name="chevron" size={13} />
                </Link>
              ))}
            {projects.data?.items.length === 0 && (
              <span className="sidebar-empty">No active projects.</span>
            )}
          </div>
          <div className="sidebar-bottom">
            <Link
              href="/settings"
              className={`nav-link settings-link ${active === 'settings' ? 'active' : ''}`}
            >
              <Icon name="settings" />
              <span>Settings</span>
            </Link>
            <div className="profile">
              <span className="avatar">{me.data?.display_name?.slice(0, 1).toUpperCase() || 'P'}</span>
              <div>
                <strong>{me.data?.display_name || 'My workspace'}</strong>
                <small>Personal workspace</small>
              </div>
              <span className="status-dot" />
            </div>
          </div>
        </aside>
      </div>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button sidebar-toggle"
              aria-label={sidebarPinned ? 'Collapse sidebar' : 'Pin sidebar open'}
              title={sidebarPinned ? 'Collapse sidebar' : 'Pin sidebar open'}
              aria-controls="workspace-sidebar"
              aria-expanded={sidebarPinned || sidebarPeek}
              onClick={toggleSidebar}
            >
              <Icon name="menu" />
            </button>
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              aria-controls="workspace-sidebar"
              aria-expanded={mobileNav}
              onClick={() => setMobileNav(true)}
            >
              <Icon name="menu" />
            </button>
          </div>
          <div className="workspace-horizontal-tabs">
            <WorkspaceTabList state={tabState} onOpen={openTabPicker} />
          </div>
          <div className="topbar-actions">
            {active !== 'today' && <FocusTimerStatus timer={focusTimer} />}
            <button
              type="button"
              className="icon-button tab-layout-toggle"
              aria-label={vertical ? 'Switch to horizontal tabs' : 'Switch to vertical tabs'}
              title={vertical ? 'Horizontal tabs' : 'Vertical tabs'}
              onClick={toggleTabLayout}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                <path d={vertical ? 'M6 3v10' : 'M2 6.5h12'} />
              </svg>
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => { setNewTab(false); setSearch(true); }}
              aria-label="Search and navigate"
              title={`Search workspace (${searchKeys})`}
            >
              <Icon name="search" size={17} />
            </button>
            <button type="button" className="icon-button workspace-capture" aria-label="Quick capture" title="Quick capture" onClick={() => setCapture(true)}>
              <Icon name="plus" size={17} />
            </button>
          </div>
        </header>
        {!online && (
          <div className="offline-banner">
            You are offline. Loaded content is still available. Retry unsent changes when you reconnect.
            Mobile supports offline entry.
          </div>
        )}
        {tabState.tabs.map((tab) => {
          const route = tabPath(tab.href);
          const section = tabDestination(tab.href);
          const active = section?.path;
          const params = new URL(tab.href, 'https://prism.local').searchParams;
          const from = chapterBound(params.get('chapter_from'));
          const to = chapterBound(params.get('chapter_to'));
          const subject = params.get('subject') ?? undefined;
          const studyScope: StudyScope = {
            subject,
            chapters: subject !== undefined && from !== undefined && to !== undefined && from <= to
              ? { from, to }
              : undefined,
          };
          const reviewCardId = entityId(params.get('card'));
          const researchObjectId = entityId(params.get('object'));
          const discoverView = params.get('view') === 'for-you' ? 'for-you' : undefined;
          const discoverRefresh = discoverView ? entityId(params.get('refresh')) : undefined;
          const selected = tab.id === tabState.selected;
          return (
            <Activity key={tab.id} mode={selected ? 'visible' : 'hidden'}>
              <main
                className={`main-content${route === 'graph' ? ' workspace-graph-content' : ''}`}
                hidden={!selected}
                key={route}
                ref={(element) => {
                  if (!element || !selected || !/^(knowledge|research)\/[^/]+$/.test(route)) return;
                  const syncTitle = () => {
                    const title = element.querySelector('.page-heading h1')?.textContent?.trim();
                    if (title) tabState.name(tab.id, route, title);
                  };
                  const observer = new MutationObserver(syncTitle);
                  syncTitle();
                  observer.observe(element, { childList: true, subtree: true, characterData: true });
                  return () => observer.disconnect();
                }}
              >
                {active === 'today' && (
                  <TodayPage
                    key={dashboardRevision}
                    focusTimer={focusTimer}
                    gettingStarted={(reloadToday) =>
                      guide.progress && (
                        <GettingStarted
                          progress={guide.progress}
                          update={guide.update}
                          language={guide.language}
                          onLanguageChange={guide.changeLanguage}
                          onCardSaved={reloadToday}
                          onDiscover={openFirstRound}
                        />
                      )
                    }
                  />
                )}
                {active === 'graph' && <WorkspaceGraphPage />}
                {active === 'knowledge' && route !== 'review/session' && (
                  <KnowledgePage
                    id={route.split('/')[1]}
                    scope={studyScope}
                    guideUserId={me.data?.id}
                    guideLanguage={guide.language}
                  />
                )}
                {route === 'review/session' && (
                  <ReviewPage
                    key={reviewCardId || scopedPath('/review/session', studyScope)}
                    scope={studyScope}
                    cardId={reviewCardId}
                  />
                )}
                {active === 'practice' && (
                  me.data ? <PracticePage key={me.data.id} userId={me.data.id} guideLanguage={guide.language} /> :
                    me.error ? <ErrorState error={me.error} retry={me.reload} /> : <Loading />
                )}
                {active === 'research' && (
                  <ResearchPage
                    id={route.split('/')[1]}
                    selectedObjectId={researchObjectId}
                    guideUserId={me.data?.id}
                    guideLanguage={guide.language}
                  />
                )}
                {active === 'discover' && (
                  <>
                    <DiscoverPage
                      key={discoverRefresh ?? discoverView ?? 'explore'}
                      initialView={discoverView}
                      initialRefreshJob={discoverRefresh}
                      onOpenInterests={me.data ? openInterests : undefined}
                      guideLanguage={guide.language}
                      userId={me.data?.id}
                    />
                    {selected && guide.progress?.status === 'welcome' && (
                      <GettingStarted
                        progress={guide.progress}
                        update={guide.update}
                        language={guide.language}
                        onLanguageChange={guide.changeLanguage}
                        onCardSaved={() => {}}
                        onDiscover={openFirstRound}
                      />
                    )}
                  </>
                )}
                {active === 'settings' && (
                  <SettingsPage
                    focusTimer={focusTimer}
                    guideLanguage={guide.language}
                    onGuideLanguageChange={guide.changeLanguage}
                    onOpenGuide={
                      me.data && guide.progress !== undefined
                        ? () => {
                            guide.update({ ...guide.progress, status: 'active' });
                            router.push('/today');
                          }
                        : undefined
                    }
                  />
                )}
                {!section && route !== 'review/session' && (
                  <div className="empty-state">
                    <h1>Page not found</h1>
                    <Link href="/today" className="button primary">
                      Back to Dashboard
                    </Link>
                  </div>
                )}
              </main>
            </Activity>
          );
        })}
      </div>
      <FocusCompletionNotice timer={focusTimer} />
      {capture && (
        <QuickCapture
          onClose={() => setCapture(false)}
          onSaved={() => {
            setCapture(false);
            setDashboardRevision((x) => x + 1);
          }}
        />
      )}
      {search && (
        <SearchModal
          onClose={() => setSearch(false)}
          onOpenTab={newTab ? tabState.open : undefined}
        />
      )}
    </div>
  );
}
function QuickCapture({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [creationId] = useState(uuid);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState('inbox');
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [project, setProject] = useState('');
  const projects = useResource<Page<Project>>(kind === 'research' ? '/research/projects' : null);
  const action = useAction(onSaved);
  async function save() {
    await action.run(async () => {
      if (kind === 'inbox') return api('/inbox', { method: 'POST', body: { id: creationId, content } });
      if (kind === 'knowledge')
        return api('/knowledge-items', {
          method: 'POST',
          body: { id: creationId, title: title || content.slice(0, 50), type: 'note', content },
        });
      if (kind === 'research')
        return api(`/research/projects/${project}/objects`, {
          method: 'POST',
          body: { id: creationId, title: title || content.slice(0, 50), object_type: 'observation', content },
        });
      return api('/tasks', {
        method: 'POST',
        body: {
          id: creationId,
          title: title || content.slice(0, 50),
          description: content,
          source_type: 'general',
          estimated_minutes: Number(minutes),
        },
      });
    });
  }
  return (
    <Modal title="Capture a thought" onClose={onClose}>
      <div className="segmented">
        {[
          ['inbox', 'Inbox'],
          ['knowledge', 'Knowledge note'],
          ['research', 'Research note'],
          ['task', 'Task'],
        ].map(([v, l]) => (
          <button key={v} className={kind === v ? 'selected' : ''} onClick={() => setKind(v)}>
            {l}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {kind !== 'inbox' && (
          <Field label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Give your thought a title"
            />
          </Field>
        )}
        {kind === 'research' && (
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
        )}
        <Field
          label={kind === 'task' ? 'Task description' : 'Content'}
          hint="Supports $inline$ and $$display$$ LaTeX."
        >
          <textarea
            required
            rows={6}
            autoFocus
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="A definition, a thought, or your next step…"
          />
        </Field>
        {kind === 'task' && (
          <Field label="Estimated time (min)">
            <input
              type="number"
              min="1"
              max="1440"
              required
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </Field>
        )}
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={action.busy}>
            {action.busy ? 'Saving…' : 'Save capture'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function SearchModal({
  onClose,
  onOpenTab,
}: {
  onClose: () => void;
  onOpenTab?: (href: string, title: string) => void;
}) {
  function select(href: string, title: string) {
    return (event: MouseEvent<HTMLAnchorElement>) => {
      if (onOpenTab) {
        event.preventDefault();
        onOpenTab(href, title);
      }
      onClose();
    };
  }
  const [q, setQ] = useState('');
  const result = useResource<Page<{ id: string; title: string }>>(
    q.length > 1 ? `/knowledge-items?q=${encodeURIComponent(q)}&limit=8` : null,
  );
  return (
    <Modal title={onOpenTab ? 'Open a new tab' : 'Search and navigate'} onClose={onClose}>
      <input
        className="search-input"
        autoFocus
        placeholder="Search knowledge titles or keywords…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="search-results">
        {q.length > 1
          ? result.data?.items.map((x) => (
              <Link href={`/knowledge/${x.id}`} key={x.id} onClick={select(`/knowledge/${x.id}`, x.title)}>
                <Icon name="knowledge" />
                {x.title}
                <Icon name="arrow" size={16} />
              </Link>
            ))
          : destinations.map((x) => (
              <Link key={x.path} href={`/${x.path}`} onClick={select(`/${x.path}`, x.label)}>
                <Icon name={x.icon} />
                {x.label}
                <Icon name="arrow" size={16} />
              </Link>
            ))}
        {q.length > 1 && result.data?.items.length === 0 && (
          <p className="muted">No matching knowledge. Try another keyword.</p>
        )}
      </div>
    </Modal>
  );
}
