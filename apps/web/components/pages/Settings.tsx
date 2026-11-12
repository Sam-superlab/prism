'use client';
import { useEffect, useState } from 'react';
import { api, datetime, useAction, useResource } from '../../lib/api';
import { guideCopy, type GuideLanguage } from '../../lib/getting-started-copy';
import type { Conflict, ExportJob, Job, Page, Preferences, User } from '../../lib/types';
import {
  shortcutKeys,
  shortcutPlatform,
  workspaceShortcuts,
  type ShortcutPlatform,
} from '../../lib/workspace-shortcuts';
import { Badge, ErrorState, Field, Icon, Loading, Modal, Notice } from '../ui';
import { AppearancePanel } from '../Appearance';
import { GuideLanguageSelect } from '../GettingStarted';
import styles from './Settings.module.css';

export function SettingsPage({
  guideLanguage,
  onGuideLanguageChange,
  onOpenGuide,
}: {
  guideLanguage: GuideLanguage;
  onGuideLanguageChange: (language: GuideLanguage) => void;
  onOpenGuide?: () => void;
}) {
  const guide = guideCopy[guideLanguage];
  const me = useResource<User>('/me');
  const preferences = useResource<Preferences>('/me/preferences');
  const conflicts = useResource<Page<Conflict>>('/sync/conflicts?limit=100');
  const jobs = useResource<Page<Job>>('/automation/jobs?limit=30');
  const [selected, setSelected] = useState<Conflict | null>(null);
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [saved, setSaved] = useState<'profile' | 'preferences' | 'conflicts'>();
  const [anchor, setAnchor] = useState('');
  const action = useAction();
  const sections = [
    { id: 'appearance-heading', label: 'Appearance', icon: 'settings' },
    { id: 'learning-settings', label: 'Learning and notifications', icon: 'planner' },
    { id: 'profile-settings', label: 'Profile and timezone', icon: 'clock' },
    { id: 'keyboard-shortcuts', label: 'Keyboard shortcuts', icon: 'menu' },
    { id: 'getting-started-settings', label: guide.settingsTitle, icon: 'knowledge', lang: guideLanguage },
    { id: 'data-export', label: 'Data export', icon: 'external' },
    { id: 'sync-conflicts', label: 'Sync conflicts', icon: 'check' },
    { id: 'background-activity', label: 'Background activity', icon: 'refresh' },
  ];
  useEffect(() => {
    const readAnchor = () => setAnchor(window.location.hash.slice(1));
    readAnchor();
    window.addEventListener('hashchange', readAnchor);
    return () => window.removeEventListener('hashchange', readAnchor);
  }, []);
  useEffect(() => {
    if (!exportJob || !['pending', 'running'].includes(exportJob.status)) return;
    const timer = setInterval(() => {
      void api<ExportJob>(`/exports/${exportJob.id}`)
        .then(setExportJob)
        .catch((e) => action.setError(e.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [exportJob?.id, exportJob?.status]);
  return (
    <>
      <div className={`page-heading ${styles.header}`}>
        <div>
          <h1>Settings</h1>
          <p>Customize your workspace, review schedule, and notifications.</p>
        </div>
        <a className="button" href="/auth/logout">
          Sign out
          <Icon name="arrow" size={16} />
        </a>
      </div>
      <div className={styles.layout}>
        <nav className={styles.index} aria-label="Settings sections">
          <ul>
            {sections.map(({ id, label, icon, lang }) => (
              <li key={id}>
                <a href={`#${id}`} lang={lang} aria-current={anchor === id ? 'location' : undefined}>
                  <Icon name={icon} size={16} />
                  <span>{label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.stack}>
          <AppearancePanel />
          <section className="panel content-panel" aria-labelledby="learning-settings">
            <div className="panel-heading">
              <h2 id="learning-settings">Learning, planning, and notifications</h2>
            </div>
            <ErrorState error={preferences.error} retry={preferences.reload} />
            {preferences.data ? (
              <PreferencesForm
                preferences={preferences.data}
                onSaved={() => {
                  preferences.reload();
                  setSaved('preferences');
                }}
              />
            ) : (
              preferences.loading && <Loading />
            )}
            {saved === 'preferences' && (
              <Notice tone="success">Preferences saved. Future scheduling will use these settings.</Notice>
            )}
          </section>
          <section className="panel content-panel" aria-labelledby="profile-settings">
            <div className="panel-heading">
              <h2 id="profile-settings">Profile and timezone</h2>
            </div>
            <ErrorState error={me.error} retry={me.reload} />
            {me.data ? (
              <ProfileForm
                user={me.data}
                onSaved={() => {
                  me.reload();
                  setSaved('profile');
                }}
              />
            ) : (
              me.loading && <Loading />
            )}
            {saved === 'profile' && <Notice tone="success">Profile saved.</Notice>}
          </section>
          <KeyboardShortcuts />
          <section
            className="panel content-panel"
            aria-labelledby="getting-started-settings"
            lang={guideLanguage}
          >
            <div className="panel-heading">
              <h2 id="getting-started-settings">{guide.settingsTitle}</h2>
            </div>
            <p className={`muted ${styles.description}`}>{guide.settingsDetail}</p>
            <div className="inline-actions">
              <GuideLanguageSelect
                language={guideLanguage}
                onChange={onGuideLanguageChange}
                disabled={!onOpenGuide}
              />
              <button className="button" onClick={onOpenGuide} disabled={!onOpenGuide}>
                {guide.settingsLink} <Icon name="arrow" size={16} />
              </button>
            </div>
          </section>
          <section className="panel content-panel" aria-labelledby="data-export">
            <div className="panel-heading">
              <h2 id="data-export">Export your data</h2>
            </div>
            <p className={`muted ${styles.description}`}>
              Export structured JSON, knowledge and research notes in Markdown, and a manifest with checksums.
              Review and research history are included.
            </p>
            <button
              className="button primary"
              disabled={action.busy || exportJob?.status === 'pending' || exportJob?.status === 'running'}
              onClick={() =>
                void action.run(async () => {
                  const job = await api<ExportJob>('/exports', {
                    method: 'POST',
                    body: { formats: ['json', 'markdown'] },
                  });
                  setExportJob(job);
                })
              }
            >
              {exportJob && ['pending', 'running'].includes(exportJob.status)
                ? 'Preparing export…'
                : 'Create full export'}
              <Icon name="arrow" size={16} />
            </button>
            {exportJob?.status === 'ready' && (
              <div className="export-ready">
                <Badge tone="green">Export ready</Badge>
                <a href={`/api/v1/exports/${exportJob.id}/download`} className="button" download>
                  Download ZIP
                </a>
                <span className="small-text muted">Available until {datetime(exportJob.expires_at)}</span>
              </div>
            )}
            {exportJob?.status === 'failed' && (
              <Notice tone="error">{exportJob.error_message || 'Export failed. Please try again.'}</Notice>
            )}
            {exportJob?.status === 'expired' && <Notice>This export has expired. Create a new one.</Notice>}
            {action.error && <Notice tone="error">{action.error}</Notice>}
          </section>
          <section className="panel" aria-labelledby="sync-conflicts">
            <div className="panel-heading">
              <h2 id="sync-conflicts">Sync conflicts</h2>
              <Badge tone="peach">{conflicts.data?.items.filter((x) => !x.resolved_at).length || 0}</Badge>
            </div>
            <ErrorState error={conflicts.error} retry={conflicts.reload} />
            {conflicts.data?.items.filter((x) => !x.resolved_at).length === 0 && (
              <div className="compact-empty">
                <Icon name="check" />
                <p>No unresolved conflicts</p>
                <small>Edits from your devices are preserved here when they need review.</small>
              </div>
            )}
            {conflicts.data?.items
              .filter((x) => !x.resolved_at)
              .map((c) => (
                <button key={c.id} className="conflict-row" onClick={() => setSelected(c)}>
                  <span>
                    <strong>{String(c.client_payload.title || c.entity_type)}</strong>
                    <small>
                      {c.conflict_type} · {datetime(c.created_at, true)}
                    </small>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
            {saved === 'conflicts' && <Notice tone="success">Conflict resolution saved.</Notice>}
          </section>
          <section className="panel jobs-panel" aria-labelledby="background-activity">
            <div className="panel-heading">
              <h2 id="background-activity">Background activity</h2>
              <button className="icon-button" aria-label="Refresh activity" onClick={jobs.reload}>
                <Icon name="refresh" size={16} />
              </button>
            </div>
            <ErrorState error={jobs.error} retry={jobs.reload} />
            {jobs.data?.items.length === 0 && (
              <p className="panel-description muted">Logs appear here after background tasks run.</p>
            )}
            {jobs.data?.items.map((j) => (
              <details className="job-row" key={j.id}>
                <summary>
                  <div>
                    <strong>{j.job_type.replaceAll('_', ' ')}</strong>
                    <small>{datetime(j.scheduled_at)}</small>
                  </div>
                  <Badge
                    tone={
                      j.status === 'succeeded'
                        ? 'green'
                        : j.status === 'dead' || j.status === 'failed'
                          ? 'peach'
                          : ''
                    }
                  >
                    {j.status}
                  </Badge>
                </summary>
                <p className="small-text muted">
                  Attempts: {j.attempts}
                  {j.error_message ? ` · ${j.error_message}` : ''}
                </p>
              </details>
            ))}
          </section>
        </div>
      </div>
      {selected && (
        <ConflictModal
          conflict={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            conflicts.reload();
            setSaved('conflicts');
          }}
        />
      )}
    </>
  );
}

function KeyboardShortcuts() {
  const [platform, setPlatform] = useState<ShortcutPlatform>();
  useEffect(() => setPlatform(shortcutPlatform(navigator.userAgent)), []);

  return (
    <section className="panel content-panel" aria-labelledby="keyboard-shortcuts">
      <div className="panel-heading">
        <h2 id="keyboard-shortcuts">Keyboard shortcuts</h2>
      </div>
      <dl className={styles.shortcuts}>
        {workspaceShortcuts.map((shortcut) => (
          <div key={shortcut.action}>
            <dt>{shortcut.label}</dt>
            <dd>
              {platform || shortcut.modifier === 'none' ? (
                <ShortcutKeys keys={shortcutKeys(shortcut, platform ?? 'other')} />
              ) : (
                <>
                  <ShortcutKeys keys={shortcutKeys(shortcut, 'apple')} />
                  <span className="muted">or</span>
                  <ShortcutKeys keys={shortcutKeys(shortcut, 'other')} />
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const keyLabels: Record<string, string> = { '⌘': 'Command', '⇧': 'Shift', ',': 'Comma' };

function ShortcutKeys({ keys }: { keys: string[] }) {
  return (
    <span className={styles.keys}>
      {keys.map((key) => (
        <kbd key={key} aria-label={keyLabels[key] ?? key}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

function ProfileForm({ user, onSaved }: { user: User; onSaved: () => void }) {
  const [name, setName] = useState(user.display_name);
  const [timezone, setTimezone] = useState(user.timezone);
  const a = useAction(onSaved);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(() =>
          api('/me', { method: 'PATCH', version: user.version, body: { display_name: name, timezone } }),
        );
      }}
    >
      <div className="form-grid">
        <Field label="Display name">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="IANA timezone"
          hint="Timezone affects date grouping and notifications while preserving review timestamps."
        >
          <input required list="timezones" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          <datalist id="timezones">
            {[
              'Europe/Budapest',
              'Asia/Shanghai',
              'Asia/Hong_Kong',
              'Asia/Tokyo',
              'Europe/London',
              'America/New_York',
              'America/Los_Angeles',
              'UTC',
            ].map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
      </div>
      <Field label="Sign-in email">
        <input value={user.email} disabled />
      </Field>
      {a.error && <Notice tone="error">{a.error}</Notice>}
      <div className="form-bottom">
        <button className="button" disabled={a.busy}>
          Save profile
        </button>
      </div>
    </form>
  );
}
function PreferencesForm({ preferences: p, onSaved }: { preferences: Preferences; onSaved: () => void }) {
  const [retention, setRetention] = useState(p.desired_retention);
  const [limit, setLimit] = useState(p.daily_review_limit);
  const [capacity, setCapacity] = useState(p.default_study_capacity_minutes);
  const [digest, setDigest] = useState(p.digest_preferences.enabled);
  const [digestTime, setDigestTime] = useState(p.digest_preferences.time || '08:00');
  const [push, setPush] = useState(p.notification_preferences.push_enabled);
  const [quietStart, setQuietStart] = useState(p.notification_preferences.quiet_start || '22:00');
  const [quietEnd, setQuietEnd] = useState(p.notification_preferences.quiet_end || '08:00');
  const [shutdown, setShutdown] = useState(p.notification_preferences.shutdown_reminder_time || '');
  const a = useAction(onSaved);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(() =>
          api('/me/preferences', {
            method: 'PATCH',
            version: p.version,
            body: {
              desired_retention: retention,
              daily_review_limit: limit,
              default_study_capacity_minutes: capacity,
              notification_preferences: {
                push_enabled: push,
                quiet_start: quietStart,
                quiet_end: quietEnd,
                shutdown_reminder_time: shutdown || null,
              },
              digest_preferences: { enabled: digest, time: digestTime },
            },
          }),
        );
      }}
    >
      <div className="form-grid">
        <Field
          label="FSRS desired retention"
          hint="Higher retention usually means more reviews. Default: 0.90."
        >
          <input
            required
            type="number"
            min="0.70"
            max="0.99"
            step="0.01"
            value={retention}
            onChange={(e) => setRetention(Number(e.target.value))}
          />
        </Field>
        <Field label="Daily review limit">
          <input
            required
            type="number"
            min="0"
            max="1000"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </Field>
      </div>
      <Field label="Default daily capacity (minutes)">
        <input
          required
          type="number"
          min="0"
          max="1440"
          value={capacity}
          onChange={(e) => setCapacity(Number(e.target.value))}
        />
      </Field>
      <div className="content-divider" />
      <label className="check-label">
        <input type="checkbox" checked={digest} onChange={(e) => setDigest(e.target.checked)} />
        Daily arXiv digest
      </label>
      <Field label="Digest time (local time)">
        <input type="time" required value={digestTime} onChange={(e) => setDigestTime(e.target.value)} />
      </Field>
      <label className="check-label">
        <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
        Send push notifications to registered mobile devices
      </label>
      <div className="form-grid">
        <Field label="Quiet hours start">
          <input type="time" required value={quietStart} onChange={(e) => setQuietStart(e.target.value)} />
        </Field>
        <Field label="Quiet hours end">
          <input type="time" required value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
        </Field>
      </div>
      <Field label="End-of-day reminder (optional)">
        <input type="time" value={shutdown} onChange={(e) => setShutdown(e.target.value)} />
      </Field>
      <p className="small-text muted">
        Matching quiet-hour times mute push notifications all day. Preferences are checked before delivery.
      </p>
      {a.error && <Notice tone="error">{a.error}</Notice>}
      <div className="form-bottom">
        <button className="button primary" disabled={a.busy}>
          Save preferences
        </button>
      </div>
    </form>
  );
}
function ConflictModal({
  conflict: c,
  onClose,
  onSaved,
}: {
  conflict: Conflict;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [resolution, setResolution] = useState('keep_server');
  const [merged, setMerged] = useState(String(c.client_payload.content || ''));
  const [version, setVersion] = useState(String(c.server_payload.version || '1'));
  const a = useAction(onSaved);
  const review = c.entity_type.includes('review');
  return (
    <Modal title="Review and resolve conflict" onClose={onClose} wide>
      <Notice tone="warning">
        Your original submission is preserved. Resolving this conflict leaves committed review and research
        history intact.
      </Notice>
      <div className="conflict-columns">
        <div>
          <h3>Device submission</h3>
          <pre>{JSON.stringify(c.client_payload, null, 2)}</pre>
        </div>
        <div>
          <h3>Server version</h3>
          <pre>{JSON.stringify(c.server_payload, null, 2)}</pre>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api(`/sync/conflicts/${c.id}/resolve`, {
              method: 'POST',
              version: c.version,
              body: {
                resolution,
                current_entity_version: version,
                ...(resolution === 'merged'
                  ? { merged_payload: { base_snapshot: c.server_payload, content: merged } }
                  : {}),
              },
            }),
          );
        }}
      >
        <div className="form-grid">
          <Field label="Resolution">
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
              <option value="keep_server">Keep server version</option>
              {review ? (
                <option value="review_again">Review again without applying this rating</option>
              ) : (
                <>
                  <option value="apply_client">Apply device changes</option>
                  {(c.entity_type.includes('knowledge') || c.entity_type.includes('research')) && (
                    <option value="merged">Merge mathematical content</option>
                  )}
                </>
              )}
            </select>
          </Field>
          <Field label="Current server version">
            <input
              required
              pattern="[1-9][0-9]*"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </Field>
        </div>
        {resolution === 'merged' && (
          <Field label="Merged content">
            <textarea
              className="code-editor"
              rows={8}
              required
              value={merged}
              onChange={(e) => setMerged(e.target.value)}
            />
          </Field>
        )}
        {resolution === 'review_again' && (
          <Notice>After saving, reopen the review queue for a new recall attempt and rating.</Notice>
        )}
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button" type="button" onClick={onClose}>
            Later
          </button>
          <button className="button primary" disabled={a.busy}>
            Save resolution
          </button>
        </div>
      </form>
    </Modal>
  );
}
