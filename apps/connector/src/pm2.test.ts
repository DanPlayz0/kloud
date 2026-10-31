import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pm2Operations,
  publicWorker,
  socketTransport,
  type Pm2Transport,
} from './pm2.js'
import { readConfig } from './config.js'
import { pm2SnapshotSchema } from '@dedi-dash/protocol/pm2'
import { snapshotSchema } from '@dedi-dash/protocol'

const worker = (id: number, name = 'web', namespace = 'default') => ({
  pm_id: id,
  pid: 100 + id,
  name,
  pm2_env: {
    name,
    namespace,
    status: 'online',
    exec_mode: 'cluster_mode',
    pm_uptime: 1000,
    restart_time: 2,
    created_at: 50,
    env: { SECRET: 'never-transmit' },
  },
  monit: { cpu: 1, memory: 512 },
})
function mock(initial = [worker(0), worker(1), worker(2, 'web', 'other')]) {
  let workers = initial
  const calls: { method: string; args: any }[] = []
  const transport: Pm2Transport = {
    async call(method, args) {
      calls.push({ method, args })
      return method === 'getMonitorData' ? structuredClone(workers) : {}
    },
    close() {},
  }
  return {
    calls,
    transport,
    set: (value: typeof workers) => {
      workers = value
    },
  }
}

test('PM2 defaults are opt-in and Docker can be disabled independently', () => {
  assert.equal(readConfig({}).pm2Enabled, false)
  assert.equal(readConfig({}).dockerEnabled, true)
  const config = readConfig({
    PM2_ENABLED: 'true',
    DOCKER_ENABLED: 'false',
    PM2_HOME: '/srv/pm2',
  })
  assert.equal(config.pm2Enabled, true)
  assert.equal(config.dockerEnabled, false)
})
test('PM2 public inventory excludes raw configuration and keeps legacy snapshots valid', () => {
  const clean = publicWorker(worker(0))
  assert.equal(JSON.stringify(clean).includes('SECRET'), false)
  assert.equal(clean.id, 0)
  assert.equal(
    pm2SnapshotSchema.safeParse({
      type: 'pm2-snapshot',
      version: 1,
      host: 'h',
      available: true,
      workers: [clean, clean],
    }).success,
    false,
  )
  assert.equal(
    snapshotSchema.safeParse({
      type: 'snapshot',
      version: 1,
      host: 'h',
      containers: [],
    }).success,
    true,
  )
})
test('actions use numeric IDs for exact name and namespace, never PM2 name patterns', async () => {
  for (const action of [
    'start',
    'stop',
    'restart',
    'reload',
    'delete',
  ] as const) {
    const fake = mock()
    const operations = pm2Operations(fake.transport)
    const result = await operations.execute({
      kind: 'pm2',
      name: 'web',
      namespace: 'default',
      action,
    })
    assert.deepEqual(result, {
      results: [
        { id: 0, ok: true },
        { id: 1, ok: true },
      ],
    })
    const mutations = fake.calls.filter(
      (c) => c.method !== 'getMonitorData' && c.method !== 'stopWatch',
    )
    // Starting an already-online worker is an idempotent no-op.
    assert.equal(mutations.length, action === 'start' ? 0 : 2)
    for (const call of mutations)
      assert.equal(
        typeof (typeof call.args === 'object' ? call.args.id : call.args),
        'number',
      )
  }
})
test('literal special names use IDs and malformed daemon IDs cannot become patterns', async () => {
  const fake = mock([worker(0, 'all')])
  await pm2Operations(fake.transport).execute({
    kind: 'pm2',
    name: 'all',
    namespace: 'default',
    action: 'stop',
  })
  assert.deepEqual(
    fake.calls.filter((c) => c.method === 'stopProcessId').map((c) => c.args),
    [0],
  )
  const invalid = mock([{ ...worker(0), pm_id: 'all' } as any])
  await assert.rejects(
    pm2Operations(invalid.transport).execute({
      kind: 'pm2',
      name: 'web',
      namespace: 'default',
      action: 'stop',
    }),
  )
  assert.equal(
    invalid.calls.filter((c) => c.method !== 'getMonitorData').length,
    0,
  )
})

test('reused IDs and partial failures cannot affect another application', async () => {
  const fake = mock()
  let lists = 0
  const original = fake.transport.call
  fake.transport.call = async (method, args) => {
    if (method === 'getMonitorData' && ++lists === 2)
      fake.set([worker(0, 'other-app'), worker(1)])
    return original(method, args)
  }
  const result = await pm2Operations(fake.transport).execute({
    kind: 'pm2',
    name: 'web',
    namespace: 'default',
    action: 'stop',
  })
  assert.deepEqual(result, {
    results: [
      { id: 0, ok: false },
      { id: 1, ok: true },
    ],
  })
  assert.deepEqual(
    fake.calls.filter((c) => c.method === 'stopProcessId').map((c) => c.args),
    [1],
  )
})
test('operations serialize per app, and disconnect prevents subsequent worker mutations', async () => {
  const fake = mock()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = fake.transport.call
  fake.transport.call = async (method, args) => {
    if (method === 'stopProcessId') await waiting
    return original(method, args)
  }
  const operations = pm2Operations(fake.transport)
  const first = operations.execute({
    kind: 'pm2',
    name: 'web',
    namespace: 'default',
    action: 'stop',
  })
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    operations.execute({
      kind: 'pm2',
      name: 'web',
      namespace: 'default',
      action: 'restart',
    }),
    /already in progress/,
  )
  operations.close()
  release()
  const result = await first
  assert.deepEqual(result, {
    results: [
      { id: 0, ok: true },
      { id: 1, ok: false },
    ],
  })
})
test('bounded logs deduplicate shared files and handle rotation, truncation, streams and missing files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dedi-pm2-'))
  try {
    const path = join(folder, 'out.log'),
      errPath = join(folder, 'err.log')
    await writeFile(
      path,
      Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n'),
    )
    await writeFile(errPath, 'stderr-only')
    const a = worker(0),
      b = worker(1)
    for (const w of [a, b])
      Object.assign(w.pm2_env, {
        pm_out_log_path: path,
        pm_err_log_path: errPath,
      })
    const operations = pm2Operations(mock([a, b]).transport)
    const request = {
      kind: 'pm2',
      name: 'web',
      namespace: 'default',
      action: 'logs',
    }
    const result = await operations.execute(request)
    assert.ok('output' in result)
    assert.ok(result.output.includes('line-999'))
    assert.equal(result.output.split('line-999').length, 2)
    assert.ok(result.output.split('\n').length <= 200)
    assert.equal(Buffer.byteLength(result.output) <= 48000, true)
    await writeFile(path, '界'.repeat(30000))
    const unicode = await operations.execute(request)
    assert.ok('output' in unicode && Buffer.byteLength(unicode.output) <= 48000)
    await writeFile(path, 'rotated')
    assert.match(
      ((await operations.execute(request)) as { output: string }).output,
      /rotated/,
    )
    assert.match(
      (
        (await operations.execute({
          ...request,
          stream: 'stderr',
          worker: 1,
        })) as { output: string }
      ).output,
      /stderr-only/,
    )
    await rm(path)
    assert.equal(
      ((await operations.execute(request)) as { unavailable: boolean })
        .unavailable,
      true,
    )
    await assert.rejects(
      operations.execute({ ...request, worker: 9 }),
      /Worker no longer exists/,
    )
    await assert.rejects(
      operations.execute({ ...request, path: '/etc/passwd' }),
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
test('missing PM2 home never creates files or launches a daemon', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dedi-pm2-missing-'))
  try {
    const transport = socketTransport(join(folder, 'absent'))
    await assert.rejects(transport.call('getMonitorData', {}))
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(folder), [])
    transport.close()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
