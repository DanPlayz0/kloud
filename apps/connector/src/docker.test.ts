import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collect, metrics } from './docker.js'
test('CPU deltas and Linux cache-adjusted memory are calculated', () => {
  assert.deepEqual(
    metrics({
      cpu_stats: {
        cpu_usage: { total_usage: 200 },
        system_cpu_usage: 1000,
        online_cpus: 2,
      },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
      memory_stats: { usage: 1000, limit: 2000, stats: { inactive_file: 100 } },
    }),
    { cpu: 40, memory: 900, memoryLimit: 2000 },
  )
  assert.deepEqual(metrics({}), { cpu: null, memory: null, memoryLimit: null })
})
test('collector excludes dashboard infrastructure, sanitizes labels, handles stopped containers and unavailable metrics', async () => {
  const list = [
    {
      Id: 'a'.repeat(64),
      Names: ['/worker'],
      State: 'running',
      Labels: {
        'dedi-dash.project': 'miki',
        'dedi-dash.application': 'imgen',
        secret: 'never-send',
      },
    },
    {
      Id: 'b'.repeat(64),
      Names: ['/postgres'],
      State: 'running',
      Labels: { 'dedi-dash.internal': 'true' },
    },
    {
      Id: 'c'.repeat(64),
      Names: ['/stopped'],
      State: 'exited',
      Labels: { 'dedi-dash.project': '../invalid' },
    },
  ]
  const requests: string[] = []
  const result = await collect('fixture', 'host', async (_, path) => {
    requests.push(path)
    if (path.startsWith('/containers/json')) return list
    throw new Error('disappeared')
  })
  assert.equal(result.containers.length, 2)
  assert.equal(result.containers[0]?.memory, null)
  assert.equal(
    result.containers.find((c) => c.name === 'stopped')?.project,
    null,
  )
  assert.equal(JSON.stringify(result).includes('never-send'), false)
  assert.equal(requests.length, 2)
})
