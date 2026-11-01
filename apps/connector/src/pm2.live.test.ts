import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pm2Operations, socketTransport } from './pm2.js'

const require = createRequire(import.meta.url)
const cli = require.resolve('pm2/bin/pm2')
async function setup(home: string) {
  assert.ok(
    home.startsWith('/tmp/kloud-pm2-live'),
    'Use only a disposable PM2 home',
  )
  await mkdir(home, { recursive: true })
  const script = join(home, 'fixture.cjs')
  await writeFile(
    script,
    "console.log('pm2-live-stdout'); console.error('pm2-live-stderr'); setInterval(() => { console.log('context-before-error'); setTimeout(() => console.error('context-error'), 50) }, 500)",
  )
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [cli, ...args], {
      env: { ...process.env, PM2_HOME: home },
      stdio: 'pipe',
    })
  run('start', script, '--name', 'fork-app', '--namespace', 'test')
  run(
    'start',
    script,
    '--name',
    'cluster-app',
    '--namespace',
    'test',
    '-i',
    '2',
  )
  return run
}

// A separate fixture container supplies a real host daemon to a read-only client mount.
if (process.env.PM2_LIVE_FIXTURE === 'true') {
  await setup(process.env.PM2_HOME!)
  console.log('PM2 fixture ready')
  const keepAlive = setInterval(() => {}, 1000)
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
  })
  clearInterval(keepAlive)
}

test(
  'live PM2 fork/cluster lifecycle, logs, daemon reconnect and existing-instance-only access',
  { skip: process.env.LIVE_PM2_TESTS !== 'true' },
  async () => {
    const external = process.env.PM2_LIVE_HOME
    const home = external ?? (await mkdtemp('/tmp/kloud-pm2-live-'))
    assert.ok(home.startsWith('/tmp/kloud-pm2-live'))
    let run: Awaited<ReturnType<typeof setup>> | undefined
    const operations = pm2Operations(socketTransport(home))
    const request = (name: string, action: string) =>
      operations.execute({ kind: 'pm2', name, namespace: 'test', action })
    try {
      if (!external) run = await setup(home)
      const inventory = await operations.collect()
      assert.equal(inventory.length, 3)
      assert.equal(inventory.filter((w) => w.mode === 'cluster_mode').length, 2)
      const logs = await operations.execute({
        kind: 'pm2',
        name: 'fork-app',
        namespace: 'test',
        action: 'logs',
      })
      assert.ok('output' in logs && logs.output.includes('pm2-live-stdout'))
      const err = await operations.execute({
        kind: 'pm2',
        name: 'fork-app',
        namespace: 'test',
        action: 'logs',
        stream: 'stderr',
      })
      assert.ok('output' in err && err.output.includes('pm2-live-stderr'))
      await delay(1200)
      const combined = await operations.execute({
        kind: 'pm2',
        name: 'fork-app',
        namespace: 'test',
        action: 'logs',
        stream: 'combined',
      })
      assert.ok('output' in combined && !combined.unavailable)
      assert.match(
        combined.output,
        /\[stdout #\d+\] context-before-error\n\[stderr #\d+\] context-error/,
      )
      assert.deepEqual(
        await operations.execute({
          kind: 'pm2',
          name: 'fork-app',
          namespace: 'test',
          action: 'logs',
          stream: 'combined',
        }),
        combined,
      )
      for (const name of ['fork-app', 'cluster-app']) {
        for (const action of ['stop', 'start', 'restart', 'reload']) {
          const result = await request(name, action)
          assert.ok(
            'results' in result && result.results.every((r) => r.ok),
            `${name} ${action}: ${JSON.stringify(result)}`,
          )
          if (action === 'stop')
            assert.ok(
              (await operations.collect())
                .filter((w) => w.name === name)
                .every((w) => w.status === 'stopped'),
            )
        }
      }
      operations.close()
      assert.equal((await operations.collect()).length, 3)
      for (const name of ['fork-app', 'cluster-app']) {
        const result = await request(name, 'delete')
        assert.ok('results' in result && result.results.every((r) => r.ok))
      }
      assert.deepEqual(await operations.collect(), [])
      if (run) {
        run('kill')
        await assert.rejects(operations.collect())
        // Explicit host setup restarts PM2; the adapter must recover without spawning it.
        run('ping')
        assert.deepEqual(await operations.collect(), [])
      }
    } finally {
      operations.close()
      if (run) {
        run('kill')
        await rm(home, { recursive: true, force: true })
      }
    }
  },
)
