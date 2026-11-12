'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
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
import {
  defaultFocusOptions,
  desktopFocusBridge,
  focusCompletionTitle,
  playFocusSound,
  prepareFocusSound,
  readFocusOptions,
  type FocusOptions,
} from '../../lib/focus-alerts';
import { Icon } from '../ui';
import { StudyPet } from '../StudyPet';
import styles from './FocusTimer.module.css';

type Stored = { key: string; session: FocusSession };

export function useFocusTimer(userId?: string) {
  const key = userId && `prism.focus.v1.${userId}`;
  const [stored, setStored] = useState<Stored>();
  const [preferences, setPreferences] = useState<{ key: string; options: FocusOptions }>();
  const [native, setNative] = useState(false);
  const [notice, setNotice] = useState<{ key: string; title: string; completion: string }>();
  const latest = useRef<Stored | undefined>(undefined);
  const lastNotice = useRef('');
  const ready = Boolean(key && stored?.key === key);
  const session = ready ? stored!.session : newFocusSession;
  const status = session.clock.status;
  const optionsKey = userId && `prism.focus-options.v1.${userId}`;
  const options = preferences && preferences.key === optionsKey ? preferences.options : defaultFocusOptions;
  const endedAt = session.clock.status === 'finished' ? session.clock.endedAt : undefined;

  useEffect(() => {
    setNative(Boolean(desktopFocusBridge()));
    if (!optionsKey) return;
    const read = () => setPreferences({ key: optionsKey, options: readFocusOptions(optionsKey) });
    read();
    const sync = (event: StorageEvent) => {
      if (event.key === optionsKey) read();
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [optionsKey]);

  function setOption<K extends keyof FocusOptions>(name: K, value: FocusOptions[K]) {
    if (!optionsKey) return;
    if (name === 'sound' && value && !desktopFocusBridge()) prepareFocusSound();
    const next = { ...options, [name]: value };
    setPreferences({ key: optionsKey, options: next });
    try {
      localStorage.setItem(optionsKey, JSON.stringify(next));
    } catch {
      // Keep the preference for this visit.
    }
  }

  useEffect(() => {
    if (!optionsKey) return;
    const hide = () => {
      setPreferences({ key: optionsKey, options: { ...options, pet: false } });
      try {
        localStorage.setItem(optionsKey, JSON.stringify({ ...options, pet: false }));
      } catch {
        // Hide for the remainder of this visit.
      }
    };
    window.addEventListener('prism:hide-pet', hide);
    return () => window.removeEventListener('prism:hide-pet', hide);
  }, [options, optionsKey]);

  useEffect(() => {
    if (!ready || preferences?.key !== optionsKey) return;
    const bridge = desktopFocusBridge();
    if (!bridge) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () =>
      bridge({
        ...options,
        endsAt: session.clock.status === 'running' ? session.clock.endsAt : null,
        phase: session.phase,
        mood: status,
        reducedMotion: media.matches || document.documentElement.dataset.reducedMotion === 'true',
      });
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-reduced-motion'],
    });
    media.addEventListener('change', sync);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', sync);
    };
  }, [ready, preferences, optionsKey, options, session.clock, session.phase, status]);

  useEffect(() => {
    if (!key || !endedAt || preferences?.key !== optionsKey) return;
    const age = Date.now() - endedAt;
    if (age < 0 || age > 5 * 60_000) return;
    const marker = `${key}.last-reminder`;
    const completion = `${session.phase}:${endedAt}`;
    if (lastNotice.current === completion) return;
    lastNotice.current = completion;
    const title = focusCompletionTitle(session.phase);
    let dismissed = false;
    let delivered = false;
    try {
      dismissed = localStorage.getItem(`${marker}.dismissed`) === completion;
      delivered = localStorage.getItem(marker) === completion;
      localStorage.setItem(marker, completion);
    } catch {
      // Continue with one reminder per visit when storage is unavailable.
    }
    if (!dismissed) setNotice({ key, title, completion });
    if (delivered || dismissed || desktopFocusBridge()) return;
    if (options.sound) playFocusSound();
    if (
      (document.hidden || !document.hasFocus()) &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      try {
        const alert = new Notification(title, { silent: true, tag: completion });
        alert.onclick = () => {
          window.focus();
          window.dispatchEvent(new Event('prism:open-focus'));
          alert.close();
        };
      } catch {
        // The in-app reminder remains available.
      }
    }
  }, [endedAt, key, options.sound, optionsKey, preferences, session.phase]);

  function dismissNotice() {
    if (notice && notice.key === key) {
      try {
        localStorage.setItem(`${notice.key}.last-reminder.dismissed`, notice.completion);
      } catch {
        // Dismiss for this visit even when storage is unavailable.
      }
    }
    setNotice(undefined);
  }

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
    if (options.sound && !desktopFocusBridge()) prepareFocusSound();
    dismissNotice();
    commit(runFocus({ ...active, phase: 'focus', clock, task }, now));
    return true;
  }

  return {
    ready,
    native,
    options,
    setOption,
    notice: notice?.key === key ? notice?.title : undefined,
    dismissNotice,
    session,
    status,
    taskId: session.task?.id,
    startTask,
    finishTask: (id: string) =>
      update((current) => (current.task?.id === id ? { ...current, task: undefined } : current)),
    toggle: () => {
      if (status !== 'running' && options.sound && !desktopFocusBridge()) prepareFocusSound();
      dismissNotice();
      return update((current, now) => {
        if (current.clock.status === 'finished') {
          if (status !== 'finished') return current;
          const phase = current.phase === 'focus' ? 'break' : 'focus';
          return runFocus({ ...current, phase, clock: { status: 'ready' } }, now);
        }
        return current.clock.status === 'running' ? pauseFocus(current, now) : runFocus(current, now);
      });
    },
    reset: () => {
      dismissNotice();
      return update((current) => ({ ...current, clock: { status: 'ready' } }));
    },
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

export function FocusCompletionNotice({ timer }: { timer: FocusTimerController }) {
  if (!timer.notice) return null;
  return (
    <div className={`panel ${styles.completion}`}>
      <p role="status">{timer.notice}</p>
      <button
        type="button"
        className="button small"
        onClick={() => {
          window.dispatchEvent(new Event('prism:open-focus'));
          timer.dismissNotice();
        }}
      >
        Open timer
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss focus reminder"
        onClick={timer.dismissNotice}
      >
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
