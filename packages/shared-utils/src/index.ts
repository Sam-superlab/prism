import { Temporal } from '@js-temporal/polyfill';

export function localDayRange(date: string, timezone: string): { start: string; end: string } {
  const day = Temporal.PlainDate.from(date);
  const start = day.toZonedDateTime({ timeZone: timezone, plainTime: '00:00' });
  const end = day.add({ days: 1 }).toZonedDateTime({ timeZone: timezone, plainTime: '00:00' });
  return { start: start.toInstant().toString(), end: end.toInstant().toString() };
}

export function localDate(instant: string | Date, timezone: string): string {
  return Temporal.Instant.from(instant instanceof Date ? instant.toISOString() : instant)
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
}

export function validTimezone(timezone: string): boolean {
  try {
    Temporal.Now.zonedDateTimeISO(timezone);
    return true;
  } catch {
    return false;
  }
}

export function weightInKg(weight: number | null, unit: 'kg' | 'lb'): number | null {
  return weight === null ? null : weight * (unit === 'lb' ? 0.45359237 : 1);
}

export function distanceInMeters(distance: number, unit: 'm' | 'km' | 'mi'): number {
  return distance * { m: 1, km: 1000, mi: 1609.344 }[unit];
}

export function nextLocalTime(date: string, time: string, timezone: string): string {
  return Temporal.PlainDateTime.from(`${date}T${time}`)
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant()
    .toString();
}

export function inQuietHours(instant: string, timezone: string, start: string, end: string): boolean {
  if (start === end) return true;
  const t = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainTime().toString().slice(0, 5);
  return start < end ? t >= start && t < end : t >= start || t < end;
}
