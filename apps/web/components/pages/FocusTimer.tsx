'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
  breakPresets,
  focusDurationMs,
  focusPresets,
  focusRemainingMs,
  newFocusSession,
  pauseFocus,
  restoreFocus,
  runFocus,
  settleFocus,
  type FocusPhase,
  type FocusSession,
  type FocusTask,
} from '../../lib/focus-timer';
import { Icon } from '../ui';
import styles from './FocusTimer.module.css';

type Stored = { key: string; session: FocusSession };

export function useFocusTimer(userId?: string) {
  const key = userId && `prism.focus.v1.${userId}`;
  const [stored, setStored] = useState<Stored>();
  const latest = useRef<Stored | undefined>(undefined);
  const ready = Boolean(key && stored?.key === key);
  const session = ready ? stored!.session : newFocusSession;
  const status = session.clock.status;

  useEffect(() => {
    if (!key) return;
    const read = (raw: string | null) => {
      const next = { key, session: restoreFocus(raw, Date.now()) };
      latest.current = next;
      setStored(next);
    };
    try {
      read(localStorage.getItem(key));
    } catch {
      read(null);
    }
    const sync = (event: StorageEvent) => {
      if (event.key === key) read(event.newValue);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [key]);

  function commit(next: FocusSession) {
    if (!key || latest.current?.key !== key) return;
    const entry = { key, session: next };
    latest.current = entry;
    setStored(entry);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Keep using the timer for this visit if local storage is unavailable.
    }
  }

  useEffect(() => {
    if (!key || !ready || session.clock.status !== 'running') return;
    const deadline = session.clock.endsAt;
    let timeout: number;
    const refresh = () => {
      window.clearTimeout(timeout);
      const current = latest.current;
      if (
        current?.key !== key ||
        current.session.clock.status !== 'running' ||
        current.session.clock.endsAt !== deadline
      )
        return;
      const settled = settleFocus(current.session, Date.now());
      if (settled !== current.session) commit(settled);
      else timeout = window.setTimeout(refresh, Math.max(1, deadline - Date.now()));
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [key, ready, session.clock]);

  function update(change: (current: FocusSession, now: number) => FocusSession) {
    const current = latest.current;
    if (!key || current?.key !== key) return false;
    const now = Date.now();
    const next = change(settleFocus(current.session, now), now);
    if (next !== current.session) commit(next);
    return true;
  }

  function startTask(task: FocusTask) {
    const current = latest.current;
    if (!key || current?.key !== key) return false;
    const now = Date.now();
    const active = settleFocus(current.session, now);
    if (active.phase === 'focus' && active.task?.id === task.id && active.clock.status === 'running')
      return true;
    const sameFocus = active.phase === 'focus' && active.task?.id === task.id;
    const inProgress = active.clock.status === 'running' || active.clock.status === 'paused';
    if (
      inProgress &&
      !sameFocus &&
      !window.confirm('Replace the current timer with a focus session for this task?')
    )
      return false;
    const clock = sameFocus && active.clock.status === 'paused' ? active.clock : { status: 'ready' as const };
    commit(runFocus({ ...active, phase: 'focus', clock, task }, now));
    return true;
  }

  return {
    ready,
    session,
    status,
    taskId: session.task?.id,
    startTask,
    finishTask: (id: string) =>
      update((current) => (current.task?.id === id ? { ...current, task: undefined } : current)),
    toggle: () =>
      update((current, now) => {
        if (current.clock.status === 'finished') {
          if (status !== 'finished') return current;
          const phase = current.phase === 'focus' ? 'break' : 'focus';
          return runFocus({ ...current, phase, clock: { status: 'ready' } }, now);
        }
        return current.clock.status === 'running' ? pauseFocus(current, now) : runFocus(current, now);
      }),
    reset: () => update((current) => ({ ...current, clock: { status: 'ready' } })),
    setPhase: (phase: FocusPhase) =>
      update((current) =>
        current.clock.status === 'running' || current.clock.status === 'paused'
          ? current
          : { ...current, phase, clock: { status: 'ready' } },
      ),
    setFocusMinutes: (focusMinutes: FocusSession['focusMinutes']) =>
      update((current) =>
        current.clock.status === 'running' || current.clock.status === 'paused'
          ? current
          : { ...current, focusMinutes },
      ),
    setBreakMinutes: (breakMinutes: FocusSession['breakMinutes']) =>
      update((current) =>
        current.clock.status === 'running' || current.clock.status === 'paused'
          ? current
          : { ...current, breakMinutes },
      ),
  };
}

export type FocusTimerController = ReturnType<typeof useFocusTimer>;

function useCountdown(session: FocusSession) {
  const [now, setNow] = useState(0);
  const running = session.clock.status === 'running';
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [running, session.clock]);
  const duration = focusDurationMs(session);
  const remaining = Math.min(duration, focusRemainingMs(session, now || Date.now()));
  const seconds = Math.ceil(remaining / 1000);
  return {
    time: `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`,
    progress: 1 - remaining / duration,
  };
}

function phaseLabel(session: FocusSession) {
  return session.phase === 'focus' ? 'Focus' : 'Break';
}

function FocusReadout({ session }: { session: FocusSession }) {
  const { time, progress } = useCountdown(session);
  return (
    <div className={styles.readout}>
      <svg className={styles.ring} viewBox="0 0 108 108" aria-hidden="true">
        <circle className={styles.track} cx="54" cy="54" r="48" pathLength="100" />
        <circle
          className={styles.arc}
          cx="54"
          cy="54"
          r="48"
          pathLength="100"
          strokeDasharray={`${Math.max(0.01, progress * 100)} 100`}
        />
      </svg>
      <span className={styles.time} role="timer" aria-label={`${phaseLabel(session)} time remaining`}>
        {time}
      </span>
    </div>
  );
}

function StudyPet({ phase, status }: { phase: FocusPhase; status: FocusSession['clock']['status'] }) {
  const id = useId();
  const resting = phase === 'break' && status === 'running';
  const working = phase === 'focus' && status === 'running';
  return (
    <svg
      className={styles.pet}
      data-mood={resting ? 'resting' : working ? 'working' : status}
      viewBox="0 0 156 112"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-fur`} x1="0" x2="1" y1="0" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#d3faff" />
          <stop offset=".62" stopColor="#92d0ff" />
          <stop offset="1" stopColor="#a9a1f6" />
        </linearGradient>
        <linearGradient id={`${id}-gem`} x1="0" x2="1" y1="0" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#e3f9ff" />
          <stop offset="1" stopColor="#a499fd" />
        </linearGradient>
      </defs>
      <circle cx="77" cy="53" r="42" fill="none" stroke="currentColor" opacity=".14" />
      <path
        d="M15 72c9-19 40-34 70-38s57 1 56 12-25 24-56 30c-18 4-38 4-51 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.15"
        opacity=".24"
      />
      <path
        d="M118 18h10m-5-5v10M30 52h8m-4-4v8"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        opacity=".65"
      />
      <ellipse cx="79" cy="97" rx="39" ry="6" fill="currentColor" opacity=".14" />
      <g className={styles.petBody}>
        <path
          d="M45 58c-7-11-8-24-3-35 10 0 22 5 29 13a51 51 0 0 1 20 0c7-8 17-13 28-12 5 11 3 23-4 35 3 5 4 10 4 15 0 16-14 23-39 23S41 90 41 74c0-6 1-11 4-16Z"
          fill={`url(#${id}-fur)`}
          stroke="#5472b4"
          strokeWidth="1.5"
        />
        <path
          d="M49 45c-4-6-6-12-5-17 7 1 15 5 20 11m45 7c4-6 5-12 5-17-7 0-14 4-19 10"
          fill="#7189ce"
          opacity=".4"
        />
        <path d="M80 44l6 7-6 7-6-7 6-7Z" fill="#f3fcff" stroke="#6079ba" strokeWidth="1" />
        <ellipse cx="57" cy="73" rx="5" ry="2.4" fill="#a98bdf" opacity=".55" />
        <ellipse cx="102" cy="73" rx="5" ry="2.4" fill="#a98bdf" opacity=".55" />
        {resting ? (
          <path
            d="M60 65q4 4 8 0m24 0q4 4 8 0m-24 7q4 4 8 0"
            stroke="#273a67"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
          />
        ) : (
          <g className={styles.eyes}>
            <ellipse cx="65" cy="65" rx="2.7" ry={working ? 2.7 : 3.5} fill="#273a67" />
            <ellipse cx="95" cy="65" rx="2.7" ry={working ? 2.7 : 3.5} fill="#273a67" />
            <path d="M76 72q4 5 8 0" stroke="#273a67" fill="none" strokeWidth="2" strokeLinecap="round" />
          </g>
        )}
        {working && (
          <path
            d="M65 82q7-3 15 2 8-5 15-2v11q-8-2-15 1-8-3-15-1Z"
            fill="#f4f5ff"
            stroke="#6079ba"
            strokeWidth="1.3"
          />
        )}
        {resting && <path d="M65 86q15 7 30 0" stroke="#6c81b8" strokeWidth="1.3" opacity=".6" fill="none" />}
      </g>
      <path d="m132 58 6 8-6 7-6-7Z" fill={`url(#${id}-gem)`} stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function FocusTimer({ timer }: { timer: FocusTimerController }) {
  const { session, status, ready } = timer;
  useEffect(() => {
    if (window.location.hash !== '#focus-timer') return;
    document.getElementById('focus-timer')?.scrollIntoView({ behavior: 'instant', block: 'start' });
    document.getElementById('focus-timer-heading')?.focus({ preventScroll: true });
  }, []);
  const locked = status === 'running' || status === 'paused';
  const mainAction =
    status === 'running'
      ? 'Pause'
      : status === 'paused'
        ? 'Resume'
        : status === 'finished'
          ? session.phase === 'focus'
            ? 'Start break'
            : 'Start focus'
          : session.phase === 'focus'
            ? 'Start focus'
            : 'Start break';
  const stateText =
    status === 'running'
      ? `${phaseLabel(session)} in progress`
      : status === 'finished'
        ? `${phaseLabel(session)} complete`
        : status === 'paused'
          ? 'Paused'
          : `Ready for ${session.phase === 'focus' ? 'focus' : 'a break'}`;
  return (
    <section
      id="focus-timer"
      className={`panel ${styles.panel}`}
      data-phase={session.phase}
      aria-labelledby="focus-timer-heading"
    >
      <div className="panel-heading">
        <h2 id="focus-timer-heading" tabIndex={-1}>
          Focus timer
        </h2>
        <Icon name="clock" size={18} />
      </div>
      <div className={styles.phases} role="group" aria-label="Timer phase">
        <button
          type="button"
          aria-pressed={session.phase === 'focus'}
          onClick={() => timer.setPhase('focus')}
          disabled={!ready || locked}
        >
          Focus
        </button>
        <button
          type="button"
          aria-pressed={session.phase === 'break'}
          onClick={() => timer.setPhase('break')}
          disabled={!ready || locked}
        >
          Break
        </button>
      </div>
      <div className={styles.scene}>
        <FocusReadout session={session} />
        <StudyPet phase={session.phase} status={status} />
      </div>
      <div className={styles.details}>
        <p className={styles.state} role="status">
          {stateText}
        </p>
        {session.task && <p className={styles.task}>{session.task.title}</p>}
      </div>
      <div className={styles.actions}>
        <button type="button" className="button primary" onClick={timer.toggle} disabled={!ready}>
          {mainAction}
        </button>
        <button
          type="button"
          className="button"
          onClick={timer.reset}
          disabled={!ready || status === 'ready'}
        >
          Reset
        </button>
      </div>
      <div className={styles.presets}>
        <label>
          Focus
          <select
            aria-label="Focus duration"
            value={session.focusMinutes}
            disabled={!ready || locked}
            onChange={(event) =>
              timer.setFocusMinutes(Number(event.target.value) as FocusSession['focusMinutes'])
            }
          >
            {focusPresets.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </select>
        </label>
        <label>
          Break
          <select
            aria-label="Break duration"
            value={session.breakMinutes}
            disabled={!ready || locked}
            onChange={(event) =>
              timer.setBreakMinutes(Number(event.target.value) as FocusSession['breakMinutes'])
            }
          >
            {breakPresets.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

function StatusCountdown({ session }: { session: FocusSession }) {
  const { time } = useCountdown(session);
  return (
    <>
      {phaseLabel(session)}
      {session.clock.status === 'finished' ? ' complete' : ` · ${time}`}
      {session.clock.status === 'paused' ? ' paused' : ''}
    </>
  );
}

export function FocusTimerStatus({ timer }: { timer: FocusTimerController }) {
  if (!timer.ready || timer.status === 'ready') return null;
  return (
    <Link
      href="/today#focus-timer"
      className={`button small soft ${styles.statusLink}`}
      title="Open focus timer"
    >
      <Icon name="clock" size={15} />
      <span>
        <StatusCountdown session={timer.session} />
      </span>
    </Link>
  );
}
