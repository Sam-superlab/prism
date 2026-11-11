import { nextLocalTime } from '@prism/shared-utils';

let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Budapest';
export function configuredTimezone(): string {
  return timezone;
}
export function configureTimezone(value: string): void {
  new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format();
  timezone = value;
}
export function inputInstant(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return nextLocalTime(value, '00:00', timezone);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    const [date, time] = value.split('T');
    return nextLocalTime(date!, time!, timezone);
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error('Enter an ISO date or time.');
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error('Invalid date or time.');
  return instant.toISOString();
}
