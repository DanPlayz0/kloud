import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { app } from './app.js'
import { pool } from './db.js'
import { publicOrigin } from './security.js'
import { registerRpc, acceptRpc } from './connector-rpc.js'
import type { User } from './auth.js'

function fixture(t: TestContext) {
  const connector = randomUUID(),
    pm2 = randomUUID(),
    owner = randomUUID()
  const container = 'a'.repeat(64)
  const state = {
    user: {
      id: owner,
      username: 'operator',
      admin: false,
      capabilities: ['connectors.operate'],
    } as User,
    revoked: false,
    discovery: true,
    stale: false,
    present: true,
    assigned: false,
    capabilities: ['runtime', 'pm2', 'host-terminal'],
    onRpc: () => {},
  }
  const operations: any[] = []
  const metadata = () => ({
    id: connector,
    name: 'Host',
    host: 'production',
    seen: new Date().toISOString(),
    stale: state.stale,
    discovery: state.discovery,
    revoked: state.revoked,
    capabilities: state.capabilities,
  })
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM sessions')) return { rows: [state.user] }
    if (sql.includes('FROM (SELECT')) {
      assert.match(sql, /WHERE connector_id=[$]1/)
      if (
        sql.includes('SELECT id FROM') ||
        sql.includes('SELECT container_id FROM') ||
        params.length === 3
      )
        assert.match(sql, /AND (?:container_id|id)=[$]2/)
      const isPm2 = sql.includes('FROM pm2_apps')
      const id = isPm2 ? pm2 : container
      const target = params.length === 3 ? params[1] : undefined
      const discovered = params.at(-1)
      const visible = state.assigned || discovered === true
      const row = isPm2
        ? {
            id: pm2,
            connector_id: connector,
            namespace: 'default',
            name: 'worker',
            present: state.present,
            stale: state.stale,
            project_slug: state.assigned ? 'alpha' : null,
            workers: [],
          }
        : {
            container_id: container,
            connector_id: connector,
            stale: state.stale,
            project: state.assigned ? 'alpha' : null,
            application: state.assigned ? 'web' : null,
            assignment: state.assigned ? 'manual' : null,
            data: { name: 'web' },
          }
      return {
        rows:
          params[0] === connector && visible && (!target || target === id)
            ? [row]
            : [],
      }
    }
    if (sql.includes('FROM connectors'))
      return {
        rows:
          !state.revoked && (!params.length || params[0] === connector)
            ? [metadata()]
            : [],
      }
    throw new Error('Unexpected query: ' + sql)
  })
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(data: string) {
      const message = JSON.parse(data)
      operations.push(message.operation)
      state.onRpc()
      const result =
        message.operation.action === 'logs'
          ? { output: 'private output', unavailable: false }
          : message.operation.action === 'terminal-open'
            ? { session: owner }
            : message.operation.kind === 'pm2'
              ? { results: [{ id: 0, ok: true }] }
              : { ok: true }
      queueMicrotask(() => acceptRpc(connector, { id: message.id, result }))
    },
  })
  registerRpc(connector, socket as any)
  t.after(() => socket.emit('close'))
  const request = (path: string, body?: unknown) =>
    app.request(path, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin: publicOrigin,
        cookie: 'session=test',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  return { state, connector, container, pm2, operations, request }
}

test('connector workspace permission matrix keeps browsing, operation and host administration independent', async (t) => {
  const f = fixture(t)
  const base = '/connectors/' + f.connector
  for (const [admin, caps, metadata, browse, operate] of [
    [true, [], 200, 200, 200],
    [false, ['connectors.operate'], 200, 200, 200],
    [false, ['connectors.manage'], 200, 403, 403],
    [false, ['inventory.manage'], 200, 200, 403],
    [false, [], 403, 403, 403],
    [false, ['projects.manage'], 403, 403, 403],
  ] as const) {
    f.state.user.admin = admin
    f.state.user.capabilities = [...caps]
    assert.equal((await f.request('/connectors')).status, metadata)
    assert.equal((await f.request(base)).status, metadata)
    for (const [collection, id] of [
      ['containers', f.container],
      ['pm2', f.pm2],
    ]) {
      assert.equal((await f.request(base + '/' + collection)).status, browse)
      assert.equal(
        (
          await f.request(base + '/' + collection + '/' + id + '/operation', {
            action: 'restart',
          })
        ).status,
        operate,
      )
    }
    if (!admin && !caps.includes('connectors.manage' as never))
      assert.equal(
        (
          await f.request('/admin/connectors/' + f.connector + '/terminal', {
            action: 'terminal-open',
          })
        ).status,
        403,
      )
  }
})

test('resource lists and operations enforce connector identity, assignments, discovery and availability', async (t) => {
  const f = fixture(t)
  for (const [collection, id] of [
    ['containers', f.container],
    ['pm2', f.pm2],
  ]) {
    const base = '/connectors/' + f.connector + '/' + collection
    assert.equal(
      ((await (await f.request(base)).json()) as unknown[]).length,
      1,
    )
    f.state.discovery = false
    assert.deepEqual(await (await f.request(base)).json(), [])
    assert.equal(
      (await f.request(base + '/' + id + '/operation', { action: 'restart' }))
        .status,
      404,
    )
    f.state.assigned = true
    assert.equal(
      ((await (await f.request(base)).json()) as unknown[]).length,
      1,
    )
    assert.equal(
      (await f.request(base + '/' + id + '/operation', { action: 'restart' }))
        .status,
      200,
    )
    const otherId = collection === 'pm2' ? randomUUID() : 'b'.repeat(64)
    assert.equal(
      (await f.request(base + '/' + otherId + '/permissions')).status,
      404,
    )
    assert.equal(
      (
        await f.request(
          '/connectors/' +
            randomUUID() +
            '/' +
            collection +
            '/' +
            id +
            '/operation',
          { action: 'restart' },
        )
      ).status,
      404,
    )
    f.state.stale = true
    assert.equal(
      (await f.request(base + '/' + id + '/operation', { action: 'restart' }))
        .status,
      409,
    )
    f.state.stale = false
    const caps = f.state.capabilities
    f.state.capabilities = []
    assert.equal(
      (await f.request(base + '/' + id + '/operation', { action: 'restart' }))
        .status,
      409,
    )
    f.state.capabilities = caps
    f.state.revoked = true
    assert.equal((await f.request(base)).status, 404)
    f.state.revoked = false
    f.state.discovery = true
    f.state.assigned = false
  }
  f.state.present = false
  assert.equal(
    (
      await f.request(
        '/connectors/' + f.connector + '/pm2/' + f.pm2 + '/operation',
        { action: 'restart' },
      )
    ).status,
    409,
  )
})

test('inventory managers have read-only operation permissions; operators do not gain settings or host SSH', async (t) => {
  const f = fixture(t)
  const base = '/connectors/' + f.connector
  f.state.user.capabilities = ['inventory.manage']
  for (const [collection, id] of [
    ['containers', f.container],
    ['pm2', f.pm2],
  ]) {
    const response = await f.request(
      base + '/' + collection + '/' + id + '/permissions',
    )
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as { logs: boolean }).logs, false)
  }
  f.state.user.capabilities = ['connectors.operate']
  assert.equal(
    (
      await f.request('/admin/connectors/' + f.connector + '/terminal', {
        action: 'terminal-open',
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await app.request('/admin/connectors/' + f.connector, {
        method: 'PUT',
        headers: {
          origin: publicOrigin,
          cookie: 'session=test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ discovery: true, revoked: false }),
      })
    ).status,
    403,
  )
})

test('permission loss during RPC suppresses private output and closes newly opened terminals', async (t) => {
  const f = fixture(t)
  f.state.onRpc = () => {
    f.state.user.capabilities = []
  }
  const base = '/connectors/' + f.connector
  assert.equal(
    (
      await f.request(base + '/containers/' + f.container + '/operation', {
        action: 'terminal-open',
      })
    ).status,
    403,
  )
  assert.equal(f.operations.at(-1).action, 'terminal-close')
  assert.equal(f.operations.at(-1).owner, f.state.user.id)
  for (const [collection, id] of [
    ['containers', f.container],
    ['pm2', f.pm2],
  ]) {
    f.state.user.capabilities = ['connectors.operate']
    const response = await f.request(
      base + '/' + collection + '/' + id + '/logs',
    )
    const output = await response.text()
    assert.match(output, /event: unavailable/)
    assert.doesNotMatch(output, /private output/)
  }
})
