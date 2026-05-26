import type { AutomationSchedule } from './types.js';

export const MIN_INTERVAL_SECONDS = 5;
export const MAX_INTERVAL_SECONDS = 60 * 60 * 24 * 30;

interface ZonedParts {
  minute: number;
  hour: number;
  weekday: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function parseInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function assertRange(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizeFrequency(value: unknown): AutomationSchedule['frequency'] {
  const normalized = String(value ?? '').trim();
  if (
    normalized === 'hourly' ||
    normalized === 'daily' ||
    normalized === 'weekly' ||
    normalized === 'once' ||
    normalized === 'interval'
  ) {
    return normalized;
  }
  throw new Error('frequency must be one of: interval, hourly, daily, weekly');
}

function getZonedParts(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hourCycle: 'h23',
    minute: '2-digit',
    hour: '2-digit',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const minuteRaw = parts.find((item) => item.type === 'minute')?.value ?? '';
  const hourRaw = parts.find((item) => item.type === 'hour')?.value ?? '';
  const weekdayRaw = parts.find((item) => item.type === 'weekday')?.value ?? '';
  const minute = parseInteger(minuteRaw);
  const hour = parseInteger(hourRaw);
  const weekday = WEEKDAY_MAP[weekdayRaw] ?? Number.NaN;
  if (!Number.isFinite(minute) || !Number.isFinite(hour) || !Number.isFinite(weekday)) {
    throw new Error(`failed to resolve timezone parts for ${timezone}`);
  }
  return { minute, hour, weekday };
}

function matchesSchedule(parts: ZonedParts, schedule: AutomationSchedule): boolean {
  if (schedule.frequency === 'once') return false; // never auto-match, caller sets nextRunAt
  if (schedule.frequency === 'interval') return false; // interval uses direct nextRunAt arithmetic
  if (schedule.frequency === 'hourly') {
    return parts.minute === schedule.minute;
  }
  if (schedule.frequency === 'daily') {
    return parts.hour === schedule.hour && parts.minute === schedule.minute;
  }
  return (
    parts.weekday === schedule.weekday &&
    parts.hour === schedule.hour &&
    parts.minute === schedule.minute
  );
}

export function normalizeAutomationSchedule(input: Partial<AutomationSchedule>): AutomationSchedule {
  const frequency = normalizeFrequency(input.frequency);
  if (frequency === 'once') {
    return { frequency };
  }
  if (frequency === 'interval') {
    return {
      frequency,
      intervalSeconds: assertRange(
        parseInteger(input.intervalSeconds),
        'intervalSeconds',
        MIN_INTERVAL_SECONDS,
        MAX_INTERVAL_SECONDS
      ),
    };
  }
  const minute = assertRange(parseInteger(input.minute), 'minute', 0, 59);
  if (frequency === 'hourly') {
    return {
      frequency,
      minute,
    };
  }
  const hour = assertRange(parseInteger(input.hour), 'hour', 0, 23);
  if (frequency === 'daily') {
    return {
      frequency,
      minute,
      hour,
    };
  }
  const weekday = assertRange(parseInteger(input.weekday), 'weekday', 0, 6);
  return {
    frequency,
    minute,
    hour,
    weekday,
  };
}

export function normalizeAutomationTimezone(timezone: unknown): string {
  const normalized = String(timezone ?? '').trim();
  if (!normalized) {
    throw new Error('timezone is required');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    throw new Error(`invalid timezone: ${normalized}`);
  }
}

export function computeNextRunAt(
  schedule: AutomationSchedule,
  timezone: string,
  from: Date,
  options?: {
    inclusive?: boolean;
    maxSearchMinutes?: number;
  }
): string {
  const inclusive = options?.inclusive === true;
  const maxSearchMinutes = Number.isFinite(options?.maxSearchMinutes)
    ? Math.max(1, Math.trunc(options?.maxSearchMinutes as number))
    : 60 * 24 * 8;
  if (schedule.frequency === 'once') {
    return from.toISOString();
  }
  if (schedule.frequency === 'interval') {
    const intervalSeconds = assertRange(
      parseInteger(schedule.intervalSeconds),
      'intervalSeconds',
      MIN_INTERVAL_SECONDS,
      MAX_INTERVAL_SECONDS
    );
    return new Date(from.getTime() + intervalSeconds * 1000).toISOString();
  }
  const base = from.getTime();
  let cursor = Math.floor(base / 60_000) * 60_000;
  if (!inclusive || cursor <= base) {
    cursor += 60_000;
  }

  for (let step = 0; step < maxSearchMinutes; step += 1) {
    const candidate = new Date(cursor);
    const zoned = getZonedParts(candidate, timezone);
    if (matchesSchedule(zoned, schedule)) {
      return candidate.toISOString();
    }
    cursor += 60_000;
  }
  throw new Error('unable to resolve next run time within search window');
}
