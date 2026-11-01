import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deploymentPolicySchema } from '@kloud/protocol/platform'
import {
  assertOverlap,
  candidateSpec,
  runBlueGreen,
  UncertainRolloutError,
  type RolloutContext,
  type RolloutDriver,
} from './rollout.js'

function fixture() {
  const events: string[] = []
  const policy = deploymentPolicySchema.parse({
    compatibilityReviewed: true,
    readiness: { dockerHealth: true, timeoutSeconds: 1, intervalSeconds: 1 },
  })
  const spec = {
    Healthcheck: { Test: ['CMD', 'true'] },
    HostConfig: {},
    NetworkingConfig: { EndpointsConfig: { net: { Aliases: ['web', 'old'] } } },
  }
  const original = { Id: 'old', Name: '/web' }
  const driver: RolloutDriver = {
    inspect: async () => ({
      State: { Running: true, Health: { Status: 'healthy' } },
    }),
    create: async () => {
      events.push('create')
      return 'new'
    },
    start: async () => {
      events.push('start')
    },
    stop: async () => {
      events.push('stop')
    },
    remove: async (id) => {
      events.push(`remove:${id}`)
    },
  }
  const context: RolloutContext = {
    policy,
    httpProbe: async () => true,
    progress: async (stage) => {
      events.push(stage)
      return { applied: true }
    },
  }
  return { events, policy, spec, original, driver, context }
}
test('candidate is ready and proxy confirmed before the old container is stopped or removed', async () => {
  const f = fixture()
  await runBlueGreen(
    f.driver,
    f.spec,
    'new',
    f.original,
    f.context,
    new AbortController().signal,
    () => {},
  )
  assert.deepEqual(f.events, [
    'prepared',
    'create',
    'start',
    'started',
    'started',
    'ready',
    'cutover',
    'serving',
    'stop',
    'remove:old',
    'retired',
  ])
  assert.deepEqual(
    candidateSpec(f.spec, 'new').NetworkingConfig.EndpointsConfig.net.Aliases,
    ['new'],
  )
})
test('failed startup preserves serving container and retires only candidate', async () => {
  const f = fixture()
  f.driver.inspect = async () => ({ State: { Running: false } })
  await assert.rejects(
    runBlueGreen(
      f.driver,
      f.spec,
      'new',
      f.original,
      f.context,
      new AbortController().signal,
      () => {},
    ),
    /stopped/,
  )
  assert.ok(!f.events.includes('stop'))
  assert.ok(!f.events.includes('remove:old'))
  assert.ok(f.events.includes('remove:new'))
  assert.ok(f.events.includes('failed'))
})
test('ambiguous proxy cutover preserves both releases and signals reconciliation', async () => {
  const f = fixture()
  f.context.progress = async (stage) => {
    f.events.push(stage)
    if (stage === 'cutover') throw new Error('disconnected')
    return { applied: true }
  }
  await assert.rejects(
    runBlueGreen(
      f.driver,
      f.spec,
      'new',
      f.original,
      f.context,
      new AbortController().signal,
      () => {},
    ),
    UncertainRolloutError,
  )
  assert.ok(!f.events.includes('stop'))
  assert.ok(!f.events.some((e) => e.startsWith('remove:')))
  assert.ok(f.events.includes('uncertain'))
})
test('readiness requires all configured checks and stop-first requires explicit downtime', async () => {
  const f = fixture()
  f.context.policy.readiness.http = { port: 3000, path: '/', timeoutSeconds: 1 }
  f.context.httpProbe = async () => false
  await assert.rejects(
    runBlueGreen(
      f.driver,
      f.spec,
      'new',
      f.original,
      f.context,
      new AbortController().signal,
      () => {},
    ),
    /timed out/,
  )
  assert.ok(!f.events.includes('cutover'))
  assert.equal(
    deploymentPolicySchema.safeParse({ strategy: 'stop-first' }).success,
    false,
  )
  assert.equal(
    deploymentPolicySchema.safeParse({ readiness: { dockerHealth: false } })
      .success,
    false,
  )
})
test('incompatible overlap fails closed and cannot silently select downtime', () => {
  for (const spec of [
    { HostConfig: { PortBindings: { '80/tcp': [{}] } } },
    { HostConfig: { Mounts: [{ ReadOnly: false }] } },
    { HostConfig: { NetworkMode: 'host' } },
    { Volumes: { '/data': {} } },
  ])
    assert.throws(() => assertOverlap(spec, true))
  assert.throws(() => assertOverlap({ HostConfig: {} }, false), /Review/)
})
