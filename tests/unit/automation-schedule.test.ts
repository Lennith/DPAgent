import * as assert from 'node:assert/strict';
import {
  computeNextRunAt,
  normalizeAutomationSchedule,
  normalizeAutomationTimezone,
} from '../../src/automation/schedule.js';

async function testNormalizeSchedule(): Promise<void> {
  assert.deepEqual(normalizeAutomationSchedule({ frequency: 'hourly', minute: 5 }), {
    frequency: 'hourly',
    minute: 5,
  });
  assert.deepEqual(normalizeAutomationSchedule({ frequency: 'daily', minute: 30, hour: 9 }), {
    frequency: 'daily',
    minute: 30,
    hour: 9,
  });
  assert.deepEqual(
    normalizeAutomationSchedule({ frequency: 'weekly', minute: 10, hour: 8, weekday: 1 }),
    {
      frequency: 'weekly',
      minute: 10,
      hour: 8,
      weekday: 1,
    }
  );
  assert.deepEqual(normalizeAutomationSchedule({ frequency: 'interval', intervalSeconds: 90 }), {
    frequency: 'interval',
    intervalSeconds: 90,
  });
  assert.throws(() => normalizeAutomationSchedule({ frequency: 'daily', minute: 0 }), /hour/);
  assert.throws(
    () => normalizeAutomationSchedule({ frequency: 'interval', intervalSeconds: 4 }),
    /intervalSeconds/
  );
  assert.throws(
    () => normalizeAutomationSchedule({ frequency: 'interval', intervalSeconds: 60 * 60 * 24 * 31 }),
    /intervalSeconds/
  );
  assert.throws(() => normalizeAutomationSchedule({ frequency: 'monthly' as never, minute: 0 }), /frequency/);
}

async function testNormalizeTimezone(): Promise<void> {
  assert.equal(normalizeAutomationTimezone('UTC'), 'UTC');
  assert.throws(() => normalizeAutomationTimezone(''), /timezone is required/);
  assert.throws(() => normalizeAutomationTimezone('Not/A-Timezone'), /invalid timezone/);
}

async function testComputeNextRunAtHourly(): Promise<void> {
  const schedule = normalizeAutomationSchedule({ frequency: 'hourly', minute: 15 });
  const nextA = computeNextRunAt(schedule, 'UTC', new Date('2026-01-01T00:10:10.000Z'));
  assert.equal(nextA, '2026-01-01T00:15:00.000Z');

  const nextB = computeNextRunAt(schedule, 'UTC', new Date('2026-01-01T00:15:00.000Z'));
  assert.equal(nextB, '2026-01-01T01:15:00.000Z');
}

async function testComputeNextRunAtDaily(): Promise<void> {
  const schedule = normalizeAutomationSchedule({ frequency: 'daily', hour: 6, minute: 30 });
  const nextA = computeNextRunAt(schedule, 'UTC', new Date('2026-01-01T06:29:10.000Z'));
  assert.equal(nextA, '2026-01-01T06:30:00.000Z');

  const nextB = computeNextRunAt(schedule, 'UTC', new Date('2026-01-01T06:30:00.000Z'));
  assert.equal(nextB, '2026-01-02T06:30:00.000Z');
}

async function testComputeNextRunAtWeekly(): Promise<void> {
  const schedule = normalizeAutomationSchedule({
    frequency: 'weekly',
    weekday: 4, // Thursday
    hour: 8,
    minute: 0,
  });
  const nextA = computeNextRunAt(schedule, 'UTC', new Date('2026-01-01T07:59:10.000Z'));
  assert.equal(nextA, '2026-01-01T08:00:00.000Z');

  const nextB = computeNextRunAt(schedule, 'UTC', new Date('2026-01-01T08:00:00.000Z'));
  assert.equal(nextB, '2026-01-08T08:00:00.000Z');
}

async function testComputeNextRunAtInterval(): Promise<void> {
  const schedule = normalizeAutomationSchedule({ frequency: 'interval', intervalSeconds: 90 });
  const nextA = computeNextRunAt(schedule, 'UTC', new Date('2026-01-01T00:00:10.000Z'));
  assert.equal(nextA, '2026-01-01T00:01:40.000Z');

  const nextB = computeNextRunAt(schedule, 'Asia/Shanghai', new Date('2026-01-01T00:00:10.250Z'));
  assert.equal(nextB, '2026-01-01T00:01:40.250Z');
}

async function runAll(): Promise<void> {
  await testNormalizeSchedule();
  await testNormalizeTimezone();
  await testComputeNextRunAtHourly();
  await testComputeNextRunAtDaily();
  await testComputeNextRunAtWeekly();
  await testComputeNextRunAtInterval();
  console.log('automation-schedule tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});

