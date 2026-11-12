import { describe, expect, it } from 'vitest';
import {
  focusRemainingMs,
  newFocusSession,
  pauseFocus,
  restoreFocus,
  runFocus,
  settleFocus,
} from '../../apps/web/lib/focus-timer';

const minute = 60_000;
const origin = 1_800_000_000_000;

describe('focus timer', () => {
  it('restores a running timer by its deadline and finishes just that phase after a long absence', () => {
    const started = runFocus({ ...newFocusSession, task: { id: 'task-1', title: 'Read section 2' } }, origin);
    const stored = JSON.stringify(started);
    const restored = restoreFocus(stored, origin + 8 * minute);
    expect(focusRemainingMs(restored, origin + 8 * minute)).toBe(17 * minute);
    expect(restoreFocus(stored, origin + 40 * minute)).toMatchObject({
      phase: 'focus',
      clock: { status: 'finished' },
      task: { id: 'task-1' },
    });
  });

  it('keeps paused time across a reload and calculates a new deadline on resume', () => {
    const paused = pauseFocus(runFocus(newFocusSession, origin), origin + 3 * minute);
    const reopened = origin + 120 * minute;
    const restored = restoreFocus(JSON.stringify(paused), reopened);
    expect(focusRemainingMs(restored, reopened)).toBe(22 * minute);
    const resumed = runFocus(restored, reopened);
    expect(resumed.clock).toEqual({ status: 'running', endsAt: reopened + 22 * minute });
    expect(settleFocus(resumed, reopened + 22 * minute).clock.status).toBe('finished');
  });
});
