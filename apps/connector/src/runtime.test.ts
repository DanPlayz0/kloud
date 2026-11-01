import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeRequestSchema } from '@kloud/protocol/platform'
import { runtimeOperations } from './runtime.js'
import { readConfig } from './config.js'

test('container configuration accepts only bounded resource limits and restart policy', () => {
  const settings = {
    cpus: 1.5,
    memory_mib: 256,
    restart_policy: 'on-failure',
    retry_count: 3,
  }
  assert.ok(
    runtimeRequestSchema.safeParse({ action: 'update', settings }).success,
  )
  for (const invalid of [
    { ...settings, cpus: -1 },
    { ...settings, memory_mib: 1 },
    { ...settings, retry_count: 101 },
    { ...settings, restart_policy: 'always' },
    { ...settings, binds: ['/var/run/docker.sock'] },
  ])
    assert.equal(
      runtimeRequestSchema.safeParse({ action: 'update', settings: invalid })
        .success,
      false,
    )
  assert.equal(
    runtimeRequestSchema.safeParse({ action: 'update' }).success,
    false,
  )
  assert.equal(
    runtimeRequestSchema.safeParse({ action: 'inspect', settings }).success,
    false,
  )
})

test('runtime configuration updates exact non-internal container and inspection excludes environment secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kloud-runtime-'))
  const socket = join(dir, 'engine.sock'),
    container = 'a'.repeat(64)
  const calls: { method: string; path: string; body?: unknown }[] = []
  let internal = false
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({
      method: req.method!,
      path: req.url!,
      body: body ? JSON.parse(body) : undefined,
    })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET')
      res.end(
        JSON.stringify({
          Name: '/web',
          Config: {
            Image: 'example/web:v1',
            Labels: { 'kloud.internal': String(internal) },
            Env: ['TOKEN=private'],
          },
          State: { Status: 'running' },
          NetworkSettings: { Ports: {}, Networks: { app: {} } },
          Mounts: [],
          HostConfig: {
            NanoCpus: 2e9,
            Memory: 128 * 1048576,
            RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 2 },
          },
        }),
      )
    else res.end(JSON.stringify({ Warnings: ['host warning'] }))
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  const runtime = runtimeOperations({ ...readConfig({}), dockerSocket: socket })
  try {
    const inspected = await runtime.execute({
      action: 'inspect',
      container,
      owner: 'member',
    })
    assert.deepEqual(inspected.settings, {
      cpus: 2,
      memory_mib: 128,
      restart_policy: 'on-failure',
      retry_count: 2,
    })
    assert.ok(!JSON.stringify(inspected).includes('private'))
    const result = await runtime.execute({
      action: 'update',
      container,
      owner: 'member',
      settings: {
        cpus: 1.5,
        memory_mib: 256,
        restart_policy: 'unless-stopped',
        retry_count: 0,
      },
    })
    assert.deepEqual(result, { ok: true, warnings: ['host warning'] })
    assert.deepEqual(calls.at(-1), {
      method: 'POST',
      path: `/containers/${container}/update`,
      body: {
        NanoCpus: 1.5e9,
        CpuPeriod: 0,
        CpuQuota: 0,
        Memory: 256 * 1048576,
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      },
    })
    internal = true
    const before = calls.length
    await assert.rejects(
      runtime.execute({
        action: 'update',
        container,
        owner: 'member',
        settings: {
          cpus: 0,
          memory_mib: 0,
          restart_policy: 'no',
          retry_count: 0,
        },
      }),
      /Internal containers/,
    )
    assert.equal(calls.length, before + 1)
    assert.equal(calls.at(-1).method, 'GET')
  } finally {
    runtime.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(dir, { recursive: true, force: true })
  }
})
