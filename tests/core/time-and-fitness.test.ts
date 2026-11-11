import { describe, expect, it } from 'vitest';
import {
  distanceInMeters,
  inQuietHours,
  localDate,
  localDayRange,
  nextLocalTime,
  validTimezone,
  weightInKg,
} from '../../packages/shared-utils/src/index';

describe('local dates and units', () => {
  it('uses the actual 23-hour and 25-hour Budapest DST days', () => {
    const spring = localDayRange('2026-03-29', 'Europe/Budapest');
    const autumn = localDayRange('2026-10-25', 'Europe/Budapest');
    expect((Date.parse(spring.end) - Date.parse(spring.start)) / 3600000).toBe(23);
    expect((Date.parse(autumn.end) - Date.parse(autumn.start)) / 3600000).toBe(25);
    expect(localDate('2026-11-07T23:30:00Z', 'Europe/Budapest')).toBe('2026-11-08');
  });
  it('resolves nonexistent reminder time forward and quiet hours across midnight', () => {
    expect(nextLocalTime('2026-03-29', '02:30', 'Europe/Budapest')).toBe('2026-03-29T01:30:00Z');
    expect(inQuietHours('2026-11-08T22:00:00Z', 'Europe/Budapest', '22:00', '08:00')).toBe(true);
    expect(inQuietHours('2026-11-08T12:00:00Z', 'Europe/Budapest', '22:00', '08:00')).toBe(false);
    expect(validTimezone('made/up')).toBe(false);
  });
  it('compares compatible normalized units without inventing bodyweight load', () => {
    expect(weightInKg(100, 'lb')).toBeCloseTo(45.359237, 7);
    expect(weightInKg(null, 'kg')).toBeNull();
    expect(distanceInMeters(1, 'mi')).toBe(1609.344);
  });
});
