import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectorUpdater, runningVersion, updateConfig } from './updates.js'
import {
  connectorStatusSchema,
  connectorUpdateSchema,
} from '@kloud/protocol/connector'

const release = { version: 'v1.2.3', revision: 'a'.repeat(40) }
test('trusted update configuration rejects remote command text and bounds scheduling', () => {
  assert.equal(updateConfig({}).enabled, false)
  for (const env of [
    { CONNECTOR_UPDATE_COMMAND: 'curl example.com | sh' },
    { CONNECTOR_AUTO_UPDATE: 'true' },
    { CONNECTOR_UPDATE_INTERVAL_MS: '10' },
    { CONNECTOR_UPDATE_INTERVAL_MS: '86400001' },
  ])
    assert.throws(() => updateConfig(env))
  assert.equal(
    updateConfig({
      CONNECTOR_UPDATE_COMMAND: '/opt/kloud/update',
      CONNECTOR_AUTO_UPDATE: 'true',
    }).enabled,
    true,
  )
  assert.throws(() =>
    connectorUpdateSchema.parse({
      kind: 'connector-update',
      action: 'check',
      command: '/bin/sh',
    }),
  )
})

test('running build reports version/revision and normalizes missing or invalid revisions', () => {
  assert.deepEqual(
    runningVersion({
      CONNECTOR_VERSION: 'v2',
      CONNECTOR_REVISION: 'f'.repeat(40),
    }),
    { version: 'v2', revision: 'f'.repeat(40) },
  )
  assert.equal(
    runningVersion({ CONNECTOR_REVISION: '<script>' }).revision,
    'unknown',
  )
  assert.equal(runningVersion({}).version, '0.1.0')
})

test('update checks serialize, preserve actual running version, and mask executable failures', async () => {
  const abort = new AbortController()
  let calls = 0,
    complete!: () => void
  const worker = connectorUpdater(
    abort.signal,
    { command: '/trusted/update', enabled: false, interval: 60000 },
    async (command) => {
      assert.equal(command, '/trusted/update')
      calls++
      await new Promise<void>((resolve) => {
        complete = resolve
      })
    },
    release,
  )
  try {
    const check = worker.check()
    await worker.check()
    assert.equal(calls, 1)
    assert.equal(worker.snapshot().updater.state, 'checking')
    complete()
    await check
    const snapshot = connectorStatusSchema.parse(worker.snapshot())
    assert.equal(snapshot.updater.state, 'idle')
    assert.ok(snapshot.updater.completed_at)
    assert.equal(snapshot.revision, release.revision)
    worker.execute({
      kind: 'connector-update',
      action: 'configure',
      enabled: true,
    })
    assert.equal(worker.snapshot().updater.enabled, true)
    const failing = connectorUpdater(
      abort.signal,
      { command: '/trusted/update', enabled: false, interval: 60000 },
      async () => {
        throw new Error('secret-token')
      },
      release,
    )
    await failing.check()
    assert.equal(failing.snapshot().updater.state, 'failed')
    assert.ok(!JSON.stringify(failing.snapshot()).includes('secret-token'))
    const disabled = connectorUpdater(
      abort.signal,
      { command: undefined, enabled: false, interval: 60000 },
      undefined,
      release,
    )
    assert.throws(() => disabled.configure(true))
    await assert.rejects(disabled.check(), /not configured/)
  } finally {
    abort.abort()
  }
})

test('automatic policy schedules checks and can be disabled without stopping reporting', async () => {
  const abort = new AbortController()
  let calls = 0
  const worker = connectorUpdater(
    abort.signal,
    { command: '/trusted/update', enabled: true, interval: 10 },
    async () => {
      calls++
    },
    release,
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 35))
    assert.ok(calls > 0)
    worker.configure(false)
    const before = calls
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(calls, before)
    assert.equal(worker.snapshot().version, release.version)
  } finally {
    abort.abort()
  }
})
