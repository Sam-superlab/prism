export const focusPresets = [15, 25, 50] as const;
export const breakPresets = [5, 10, 15] as const;
export type FocusTask = { id: string; title: string };
export type FocusPhase = 'focus' | 'break';

type Clock =
  | { status: 'ready' | 'finished' }
  | { status: 'running'; endsAt: number }
  | { status: 'paused'; remainingMs: number };

export type FocusSession = {
  phase: FocusPhase;
  focusMinutes: (typeof focusPresets)[number];
  breakMinutes: (typeof breakPresets)[number];
  clock: Clock;
  task?: FocusTask;
};

export const newFocusSession: FocusSession = {
  phase: 'focus',
  focusMinutes: 25,
  breakMinutes: 5,
  clock: { status: 'ready' },
};

export function focusDurationMs(session: FocusSession) {
  return (session.phase === 'focus' ? session.focusMinutes : session.breakMinutes) * 60_000;
}

export function focusRemainingMs(session: FocusSession, now: number): number {
  const { clock } = session;
  switch (clock.status) {
    case 'ready':
      return focusDurationMs(session);
    case 'finished':
      return 0;
    case 'running':
      return Math.max(0, clock.endsAt - now);
    case 'paused':
      return clock.remainingMs;
  }
}

export function settleFocus(session: FocusSession, now: number): FocusSession {
  if (session.clock.status === 'running' && session.clock.endsAt <= now) {
    return { ...session, clock: { status: 'finished' } };
  }
  return session;
}

export function runFocus(session: FocusSession, now: number): FocusSession {
  if (session.clock.status !== 'ready' && session.clock.status !== 'paused') return session;
  return { ...session, clock: { status: 'running', endsAt: now + focusRemainingMs(session, now) } };
}

export function pauseFocus(session: FocusSession, now: number): FocusSession {
  const current = settleFocus(session, now);
  if (current.clock.status !== 'running') return current;
  return { ...current, clock: { status: 'paused', remainingMs: focusRemainingMs(current, now) } };
}

export function restoreFocus(raw: string | null, now: number): FocusSession {
  if (!raw) return newFocusSession;
  try {
    const data = JSON.parse(raw);
    if (
      !data ||
      !['focus', 'break'].includes(data.phase) ||
      !focusPresets.includes(data.focusMinutes) ||
      !breakPresets.includes(data.breakMinutes)
    )
      return newFocusSession;
    let clock: Clock = { status: 'ready' };
    const duration = focusDurationMs(data);
    const saved = data.clock;
    if (saved?.status === 'finished') clock = { status: 'finished' };
    if (saved?.status === 'running' && Number.isFinite(saved.endsAt))
      clock = { status: 'running', endsAt: Math.min(saved.endsAt, now + duration) };
    if (saved?.status === 'paused' && Number.isFinite(saved.remainingMs) && saved.remainingMs > 0)
      clock = { status: 'paused', remainingMs: Math.min(saved.remainingMs, duration) };
    const task =
      typeof data.task?.id === 'string' && data.task.id && typeof data.task?.title === 'string'
        ? { id: data.task.id, title: data.task.title }
        : undefined;
    return settleFocus(
      { phase: data.phase, focusMinutes: data.focusMinutes, breakMinutes: data.breakMinutes, clock, task },
      now,
    );
  } catch {
    return newFocusSession;
  }
}
