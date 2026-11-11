import { afterEach, describe, expect, it } from 'vitest';
import { configureTimezone, inputInstant } from '../src/services/locale';
afterEach(() => configureTimezone('Europe/Budapest'));
describe('configured IANA timezone', () => {
  it('interprets a wall clock time in the selected profile timezone', () => {
    configureTimezone('Europe/Budapest');
    expect(Date.parse(inputInstant('2026-11-08T18:00'))).toBe(Date.parse('2026-11-08T17:00:00Z'));
    configureTimezone('America/New_York');
    expect(Date.parse(inputInstant('2026-11-08T18:00'))).toBe(Date.parse('2026-11-08T23:00:00Z'));
  });
  it('handles nonexistent and repeated DST wall times deterministically', () => {
    configureTimezone('Europe/Budapest');
    expect(Date.parse(inputInstant('2026-03-29T02:30'))).toBe(Date.parse('2026-03-29T01:30:00Z'));
    expect(Date.parse(inputInstant('2026-10-25T02:30'))).toBe(Date.parse('2026-10-25T00:30:00Z'));
  });
  it('preserves an explicit offset when traveling', () => {
    configureTimezone('Asia/Tokyo');
    expect(inputInstant('2026-11-08T18:00:00+01:00')).toBe('2026-11-08T17:00:00.000Z');
  });
});
