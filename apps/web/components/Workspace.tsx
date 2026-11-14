'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Activity, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import { scopedPath, type StudyScope } from '../lib/knowledge-scope';
import { readResearchQuestionSource } from '../lib/research-question-links';
import { shortcutPlatform, workspaceShortcutFor } from '../lib/workspace-shortcuts';
import type { Page, Project, Today, User } from '../lib/types';
import { ErrorState, Field, Icon, Loading, Modal, Notice } from './ui';
import { FocusCompletionNotice, FocusTimerStatus, useFocusTimer } from './pages/FocusTimer';
import { useGettingStarted } from './GettingStarted';
import { destinations, tabDestination, tabPath, useWorkspaceTabs, WorkspaceTabList } from './WorkspaceTabs';
import { LiteratureAutoIndexer } from './LiteratureAutoIndexer';

const TodayPage = dynamic(() => import('./pages/Today').then((module) => module.TodayPage), { loading: Loading });
const KnowledgePage = dynamic(() => import('./pages/Knowledge').then((module) => module.KnowledgePage), { loading: Loading });
const ReviewPage = dynamic(() => import('./pages/Knowledge').then((module) => module.ReviewPage), { loading: Loading });
const ResearchPage = dynamic(() => import('./pages/Research').then((module) => module.ResearchPage), { loading: Loading });
const LiteratureLibrary = dynamic(() => import('./ResearchReferences').then((module) => module.LiteratureLibrary), { loading: Loading });
const DiscoverPage = dynamic(() => import('./pages/Discover').then((module) => module.DiscoverPage), { loading: Loading });
const SettingsPage = dynamic(() => import('./pages/Settings').then((module) => module.SettingsPage), { loading: Loading });
const PracticePage = dynamic(() => import('./pages/Practice').then((module) => module.PracticePage), { loading: Loading });
const WorkspaceGraphPage = dynamic(() => import('./ConnectionGraph').then((module) => module.WorkspaceGraphPage), { loading: Loading });
const GettingStarted = dynamic(() => import('./GettingStarted').then((module) => module.GettingStarted));
const MarkdownEditor = dynamic(() => import('./MarkdownEditor').then((module) => module.MarkdownEditor), { loading: Loading });

const navigation = destinations.filter(({ path }) => path !== 'settings');
const sidebarPreference = 'prism.sidebar.pinned';
const layoutPreference = 'prism.tabs.layout';
const sidebarOpenDelay = 250;
const sidebarCloseDelay = 200;

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
  const sidebarTimer = useRef<number>(undefined);
  const [capture, setCapture] = useState(false);
  const [search, setSearch] = useState(false);
  const [dashboardRevision, setDashboardRevision] = useState(0);
  const [online, setOnline] = useState(true);
  const [searchKeys, setSearchKeys] = useState('⌘ K');
  const me = useResource<User>('/me');
  const tabState = useWorkspaceTabs(query ? `${pathname}?${query}` : pathname, me.data?.id);
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  const selectedTab = tabState.tabs.find((tab) => tab.id === tabState.selected);
  const restoringTabs = !tabState.restored;
  const selectedId = restoringTabs ? undefined : selectedTab?.id;
  useLayoutEffect(() => {
    if (selectedId === undefined) return;
    setOpened((previous) => {
      const ids = new Set(tabState.tabs.map(({ id }) => id));
      const next = new Set([...previous].filter((id) => ids.has(id)));
      next.add(selectedId);
      return next.size === previous.size && [...next].every((id) => previous.has(id)) ? previous : next;
    });
  }, [selectedId, tabState.tabs]);
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
  const guide = useGettingStarted(me.data?.id, !restoringTabs && tabPath(selectedTab?.href ?? pathname) === 'today');
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
  const cancelSidebarTimer = useCallback(() => {
    window.clearTimeout(sidebarTimer.current);
    sidebarTimer.current = undefined;
  }, []);
  const hideSidebarPeek = useCallback(() => {
    cancelSidebarTimer();
    setSidebarPeek(false);
  }, [cancelSidebarTimer]);
  function delaySidebarPeek(open: boolean) {
    cancelSidebarTimer();
    if (sidebarPinned || sidebarPeek === open) return;
    sidebarTimer.current = window.setTimeout(() => {
      sidebarTimer.current = undefined;
      setSidebarPeek(open);
    }, open ? sidebarOpenDelay : sidebarCloseDelay);
  }

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 801px)');
    desktop.addEventListener('change', hideSidebarPeek);
    window.addEventListener('blur', hideSidebarPeek);
    return () => {
      cancelSidebarTimer();
      desktop.removeEventListener('change', hideSidebarPeek);
      window.removeEventListener('blur', hideSidebarPeek);
    };
  }, [cancelSidebarTimer, hideSidebarPeek]);

  function openTabPicker() {
    setMobileNav(false);
    hideSidebarPeek();
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
    if (event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || link.target || link.download || link.origin !== location.origin) return;
    if (!(link.dataset.workspaceTab || event.metaKey || event.ctrlKey || event.button === 1)) return;
    if (!tabDestination(link.pathname) || link.pathname === '/knowledge/export') return;
    event.preventDefault();
    tabState.open(link.pathname + link.search + link.hash, link.dataset.workspaceTab);
    hideSidebarPeek();
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
    hideSidebarPeek();
    try {
      window.localStorage.setItem(sidebarPreference, String(pinned));
    } catch {
      // Keep the choice for this view even if it cannot be persisted.
    }
  }, [sidebarPinned, hideSidebarPeek]);
  useEffect(() => {
    const openSettings = () => {
      if (document.querySelector('dialog[open]')) return;
      setMobileNav(false);
      hideSidebarPeek();
      router.push('/settings');
    };
    const handleKey = (event: KeyboardEvent) => {
      const action = workspaceShortcutFor(event);
      if (!action) return;
      if (action === 'escape') {
        hideSidebarPeek();
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
  }, [router, toggleSidebar, hideSidebarPeek]);
  return (
    <div
      className={`app-shell workspace-with-tabs ${sidebarPinned ? '' : 'sidebar-collapsed'}`}
      data-tab-layout={vertical ? 'vertical' : 'horizontal'}
      onClickCapture={openLinkInTab}
      onAuxClickCapture={(event) => { if (event.button === 1) openLinkInTab(event); }}
    >
      {mobileNav && (
        <button className="nav-backdrop" aria-label="Close navigation" data-tooltip="off" onClick={() => setMobileNav(false)} />
      )}
      <div
        className={`sidebar-region ${sidebarPeek ? 'is-peeking' : ''}`}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch' && event.currentTarget.clientWidth) delaySidebarPeek(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'touch') return;
          if (sidebarPeek && event.currentTarget.querySelector(':focus-visible')) return;
          delaySidebarPeek(false);
        }}
        onFocus={(event) => {
          if (!sidebarPinned && event.currentTarget.clientWidth && event.target.matches(':focus-visible')) {
            cancelSidebarTimer();
            setSidebarPeek(true);
          }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) delaySidebarPeek(false);
        }}
      >
        <aside
          id="workspace-sidebar"
          className={`sidebar ${mobileNav ? 'is-open' : ''}`}
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('a')) {
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
          <nav aria-label="Main navigation">
            {navigation.map((item) => (
              <Link
                key={item.path}
                href={`/${item.path}`}
                aria-label={item.label}
                aria-current={active === item.path ? 'page' : undefined}
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
              aria-label="Settings"
              aria-current={active === 'settings' ? 'page' : undefined}
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
        {restoringTabs && (
          <main className="main-content">
            {me.error ? <ErrorState error={me.error} retry={me.reload} /> : <Loading />}
          </main>
        )}
        {!restoringTabs && tabState.tabs.map((tab) => {
          const selected = tab.id === selectedId;
          if (!selected && !opened.has(tab.id)) return null;
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
          const routeParts = route.split('/');
          const researchQuestionId = routeParts[2] === 'questions' && routeParts.length === 4
            ? entityId(routeParts[3]) : undefined;
          const libraryReferenceId = entityId(params.get('reference'));
          const discoverView = params.get('view') === 'for-you' ? 'for-you' : undefined;
          const discoverRefresh = discoverView ? entityId(params.get('refresh')) : undefined;
          return (
            <Activity key={tab.id} mode={selected ? 'visible' : 'hidden'}>
              <main
                className={`main-content${route === 'graph' ? ' workspace-graph-content' : ''}${active === 'research/library' && params.get('view') !== 'reader' ? ' workspace-library-content' : ''}`}
                hidden={!selected}
                key={route}
                ref={(element) => {
                  if (!element || !selected || active === 'research/library' ||
                    (!researchQuestionId && !/^(knowledge|research)\/[^/]+$/.test(route))) return;
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
                    id={routeParts[1]}
                    selectedObjectId={researchObjectId}
                    questionId={researchQuestionId}
                    source={readResearchQuestionSource(params)}
                    startQuestion={params.get('newQuestion') === '1'}
                    guideUserId={me.data?.id}
                    guideLanguage={guide.language}
                  />
                )}
                {active === 'research/library' && (
                  <LiteratureLibrary
                    referenceId={libraryReferenceId}
                    pdfId={entityId(params.get('pdf'))}
                    pdfPage={chapterBound(params.get('page'))}
                    annotationId={entityId(params.get('annotation'))}
                    readerTab={params.get('view') === 'reader'}
                    onCloseReaderTab={tabState.tabs.length > 1 ? () => tabState.close(tab.id) : undefined}
                    teamLibrariesEnabled={me.data?.team_libraries_enabled}
                    userId={me.data?.id}
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
      {me.data && <LiteratureAutoIndexer key={me.data.id} userId={me.data.id} />}
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
        <MarkdownEditor label={kind === 'task' ? 'Task description' : 'Content'}
          hint="Supports $inline$ and $$display$$ LaTeX."
            required
            rows={6}
            value={content}
            onChange={setContent}
            placeholder="A definition, a thought, or your next step…"
           />
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
