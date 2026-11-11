'use client';
import { useEffect, useState } from 'react';
import { api, datetime, useAction, useResource } from '../../lib/api';
import type { Conflict, ExportJob, Job, Page, Preferences, User } from '../../lib/types';
import { Badge, Empty, ErrorState, Field, Icon, Loading, Modal, Notice } from '../ui';
import { AppearancePanel } from '../Appearance';

export function SettingsPage() {
  const me = useResource<User>('/me');
  const preferences = useResource<Preferences>('/me/preferences');
  const conflicts = useResource<Page<Conflict>>('/sync/conflicts?limit=100');
  const jobs = useResource<Page<Job>>('/automation/jobs?limit=30');
  const [selected, setSelected] = useState<Conflict | null>(null);
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [message, setMessage] = useState('');
  const action = useAction();
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
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR PERSONAL SYSTEM</span>
          <h1>Settings</h1>
          <p>Manage reviews, planning, and notifications. Your data stays yours.</p>
        </div>
        <a className="button" href="/auth/logout">
          Sign out
          <Icon name="arrow" size={16} />
        </a>
      </div>
      {message && <Notice tone="success">{message}</Notice>}
      <div className="settings-layout">
        <div>
          <AppearancePanel />
          <section className="panel content-panel">
            <div className="panel-heading">
              <h2>Profile and timezone</h2>
              <Icon name="settings" size={19} />
            </div>
            <ErrorState error={me.error} retry={me.reload} />
            {me.data ? (
              <ProfileForm
                user={me.data}
                onSaved={() => {
                  me.reload();
                  setMessage('Profile saved.');
                }}
              />
            ) : (
              me.loading && <Loading />
            )}
          </section>
          <section className="panel content-panel">
            <div className="panel-heading">
              <h2>Learning, planning, and notifications</h2>
            </div>
            <ErrorState error={preferences.error} retry={preferences.reload} />
            {preferences.data ? (
              <PreferencesForm
                preferences={preferences.data}
                onSaved={() => {
                  preferences.reload();
                  setMessage('Preferences saved. Future scheduling will use these settings.');
                }}
              />
            ) : (
              preferences.loading && <Loading />
            )}
          </section>
          <section className="panel content-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">DATA OWNERSHIP</span>
                <h2>Export your data</h2>
              </div>
              <Icon name="external" size={18} />
            </div>
            <p className="muted">
              Export structured JSON, knowledge and research notes in Markdown, and a manifest with checksums. Review and research history are included.
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
        </div>
        <aside>
          <section className="panel">
            <div className="panel-heading">
              <h2>Sync conflicts</h2>
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
          </section>
          <section className="panel jobs-panel">
            <div className="panel-heading">
              <h2>Background activity</h2>
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
                  Attempts: {j.attempts}{j.error_message ? ` · ${j.error_message}` : ''}
                </p>
              </details>
            ))}
          </section>
          <div className="quiet-card small">
            <span className="eyebrow">AUTOMATION WITH CONTROL</span>
            <p>
              Background tasks,
              <br />
              visible progress.
            </p>
            <small>You control mathematical verification. Background tasks do not change claim statuses or deadlines.</small>
          </div>
        </aside>
      </div>
      {selected && (
        <ConflictModal
          conflict={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            conflicts.reload();
            setMessage('Conflict resolution saved.');
          }}
        />
      )}
    </>
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
        <Field label="IANA timezone" hint="Timezone affects date grouping and notifications while preserving review timestamps.">
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
        <Field label="FSRS desired retention" hint="Higher retention usually means more reviews. Default: 0.90.">
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
      <p className="small-text muted">Matching quiet-hour times mute push notifications all day. Preferences are checked before delivery.</p>
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
      <Notice tone="warning">Your original submission is preserved. Resolving this conflict leaves committed review and research history intact.</Notice>
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
