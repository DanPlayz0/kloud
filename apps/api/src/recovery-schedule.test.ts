import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cronFields, nextBackupRun } from './recovery-schedule.js'

test('backup cron handles presets, timezone wall-clock and strict validation', () => {
  assert.equal(
    nextBackupRun(
      '0 2 * * *',
      'America/Chicago',
      new Date('2026-11-01T08:01:00Z'),
    ).toISOString(),
    '2026-11-02T08:00:00.000Z',
  )
  assert.equal(
    nextBackupRun(
      '0 2 * * 0',
      'UTC',
      new Date('2026-11-01T00:00:00Z'),
    ).toISOString(),
    '2026-11-01T02:00:00.000Z',
  )
  assert.equal(
    nextBackupRun(
      '*/15 9-10 * * 1-5',
      'UTC',
      new Date('2026-11-02T09:01:00Z'),
    ).toISOString(),
    '2026-11-02T09:15:00.000Z',
  )
  for (const value of [
    '* * * *',
    '60 * * * *',
    '*/0 * * * *',
    '* 2;id * * *',
    '* * 0 * *',
    '* * * 13 *',
  ])
    assert.throws(() => cronFields(value))
  assert.throws(() => nextBackupRun('0 2 * * *', 'Unknown/Timezone'))
})
test('day-of-month and weekday cron use conventional OR semantics when both restricted', () => {
  assert.equal(
    nextBackupRun(
      '0 2 15 * 1',
      'UTC',
      new Date('2026-11-01T00:00:00Z'),
    ).toISOString(),
    '2026-11-02T02:00:00.000Z',
  )
})
