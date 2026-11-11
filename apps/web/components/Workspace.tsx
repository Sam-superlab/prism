'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import type { Page, Project, Today, User } from '../lib/types';
import { Field, Icon, Modal, Notice } from './ui';
import { TodayPage } from './pages/Today';
import { KnowledgePage, ReviewPage } from './pages/Knowledge';
import { ResearchPage } from './pages/Research';
import { FitnessPage } from './pages/Fitness';
import { DiscoverPage } from './pages/Discover';
import { PracticePage } from './pages/Practice';
import { SettingsPage } from './pages/Settings';

const navigation = [
  { path: 'today', label: 'Today', icon: 'today' },
  { path: 'knowledge', label: 'Knowledge', icon: 'knowledge' },
  { path: 'research', label: 'Research', icon: 'research' },
  { path: 'practice', label: 'Practice', icon: 'check' },
  { path: 'fitness', label: 'Fitness', icon: 'fitness' },
  { path: 'discover', label: 'Discover', icon: 'discover' },
];
export default function Workspace({ route }: { route: string }) {
  const [mobileNav, setMobileNav] = useState(false);
  const [capture, setCapture] = useState(false);
  const [search, setSearch] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [online, setOnline] = useState(true);
  const me = useResource<User>('/me');
  const projects = useResource<Page<Project>>('/research/projects?limit=5');
  const active = route === 'review/session' ? 'knowledge' : route.split('/')[0];
  const section = [
    ...navigation,
    { path: 'planner', label: 'Planner', icon: 'planner' },
    { path: 'settings', label: 'Settings', icon: 'settings' },
  ].find((x) => x.path === active);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      window.removeEventListener('keydown', key);
    };
  }, []);
  return (
    <div className="app-shell">
      {mobileNav && (
        <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />
      )}
      <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`}>
        <Link href="/today" className="brand" aria-label="PRISM Today">
          <span className="prism-symbol">
            <img src="/prism-mark.svg" width={36} height={36} alt="" />
          </span>
          <span>
            PRISM<small>PERSONAL OPERATING SYSTEM</small>
          </span>
        </Link>
        <div className="sidebar-caption">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <Link
              key={item.path}
              href={`/${item.path}`}
              className={`nav-link ${active === item.path ? 'active' : ''}`}
              onClick={() => setMobileNav(false)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {active === item.path && <i />}
            </Link>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <Link className={`nav-link ${active === 'planner' ? 'active' : ''}`} href="/planner">
          <Icon name="planner" />
          <span>Planner</span>
        </Link>
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
            <span className="sidebar-empty">Create a project to move your research forward.</span>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="tiny-star">✧</span>
            <p>
              Keep the important
              <br />
              things in focus.
            </p>
          </div>
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
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Icon name="menu" />
            </button>
            <span className="muted">Workspace</span>
            <span className="breadcrumb-slash">/</span>
            <span>{section?.label || 'Review'}</span>
          </div>
          <div className="topbar-actions">
            <span className={`connection-status ${online ? '' : 'offline'}`}>
              <span />
              {online ? 'Connected' : 'Offline'}
            </span>
            <button
              className="search-trigger"
              onClick={() => setSearch(true)}
              aria-label="Search and navigate"
            >
              <Icon name="search" size={17} />
              <span>Search workspace</span>
              <kbd>⌘ K</kbd>
            </button>
            <button
              className="button primary small"
              aria-label="Quick capture"
              onClick={() => setCapture(true)}
            >
              <Icon name="plus" size={17} />
              <span>Quick capture</span>
            </button>
          </div>
        </header>
        {!online && (
          <div className="offline-banner">
            You are offline. Loaded content is still available. Retry unsent changes when you reconnect.
            Mobile supports offline entry.
          </div>
        )}
        <main className="main-content" key={`${route}:${epoch}`}>
          {active === 'today' && <TodayPage />}
          {active === 'planner' && <TodayPage planner />}
          {active === 'knowledge' && route !== 'review/session' && <KnowledgePage id={route.split('/')[1]} />}
          {route === 'review/session' && <ReviewPage />}
          {active === 'research' && <ResearchPage id={route.split('/')[1]} />}
          {active === 'practice' && me.data && <PracticePage userId={me.data.id} />}
          {active === 'fitness' && <FitnessPage id={route.split('/')[1]} />}
          {active === 'discover' && <DiscoverPage />}
          {active === 'settings' && <SettingsPage />}
          {!section && route !== 'review/session' && (
            <div className="empty-state">
              <h1>Page not found</h1>
              <Link href="/today" className="button primary">
                Back to Today
              </Link>
            </div>
          )}
        </main>
        <footer className="workspace-footer">
          <span>
            PRISM <i /> Bring learning, research, and life together.
          </span>
          <span>Personal Research, Intelligence & Self-Management</span>
        </footer>
      </div>
      {capture && (
        <QuickCapture
          onClose={() => setCapture(false)}
          onSaved={() => {
            setCapture(false);
            setEpoch((x) => x + 1);
          }}
        />
      )}
      {search && <SearchModal onClose={() => setSearch(false)} />}
    </div>
  );
}
function QuickCapture({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [creationId] = useState(uuid);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState('inbox');
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState(30);
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
          estimated_minutes: minutes,
        },
      });
    });
  }
  return (
    <Modal title="Capture a thought" onClose={onClose}>
      <p className="modal-description">Capture it now. Find its place later.</p>
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
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </Field>
        )}
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <a href="/fitness" className="text-link">
            Log a workout →
          </a>
          <button className="button primary" disabled={action.busy}>
            {action.busy ? 'Saving…' : 'Save capture'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function SearchModal({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const result = useResource<Page<{ id: string; title: string }>>(
    q.length > 1 ? `/knowledge-items?q=${encodeURIComponent(q)}&limit=8` : null,
  );
  return (
    <Modal title="Search and navigate" onClose={onClose}>
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
              <Link href={`/knowledge/${x.id}`} key={x.id} onClick={onClose}>
                <Icon name="knowledge" />
                {x.title}
                <Icon name="arrow" size={16} />
              </Link>
            ))
          : [
              ...navigation,
              { path: 'planner', label: 'Planner', icon: 'planner' },
              { path: 'settings', label: 'Settings', icon: 'settings' },
            ].map((x) => (
              <Link key={x.path} href={`/${x.path}`} onClick={onClose}>
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
