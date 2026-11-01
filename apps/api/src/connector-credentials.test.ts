import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { app } from './app.js'
import { pool } from './db.js'
import { digest, publicOrigin, token } from './security.js'
import { connectorRpc, registerRpc } from './connector-rpc.js'

test('credential rotation requires current management authority, hashes a new secret and disconnects the host', async (t) => {
  const id = randomUUID()
  const user = {
    id: randomUUID(),
    username: 'manager',
    admin: false,
    capabilities: ['connectors.manage'],
  }
  let stored = digest(token())
  let active = true
  let authorized = true
  let terminated = 0
  const statements: string[] = []
  const query = async (sql: string, params: unknown[] = []) => {
    statements.push(sql)
    if (sql.includes('FROM sessions')) return { rows: [user] }
    if (sql.includes('FROM users'))
      return {
        rows: [{ ...user, capabilities: authorized ? user.capabilities : [] }],
      }
    if (sql.startsWith('UPDATE connectors')) {
      assert.match(sql, /WHERE id=\$1 AND NOT revoked/)
      if (!active || params[0] !== id) return { rowCount: 0, rows: [] }
      stored = params[1] as string
      return { rowCount: 1, rows: [{ id }] }
    }
    if (/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/.test(sql))
      return { rows: [] }
    throw new Error('Unexpected SQL: ' + sql)
  }
  t.mock.method(pool, 'query', query)
  t.mock.method(pool, 'connect', async () => ({ query, release() {} }) as any)
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    terminate() {
      terminated++
      this.readyState = 3
      this.emit('close')
    },
  })
  registerRpc(id, socket as any)
  t.after(() => socket.emit('close'))
  const rotate = (target = id) =>
    app.request(`/admin/connectors/${target}/rotate`, {
      method: 'POST',
      headers: { origin: publicOrigin, cookie: 'session=test' },
    })

  authorized = false
  const original = stored
  assert.equal((await rotate()).status, 403)
  assert.equal(stored, original)
  assert.equal(terminated, 0)
  assert.ok(statements.includes('ROLLBACK'))

  authorized = true
  const response = await rotate()
  assert.equal(response.status, 200)
  const result = (await response.json()) as { id: string; token: string }
  assert.equal(result.id, id)
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(stored, digest(result.token))
  assert.notEqual(stored, result.token)
  assert.notEqual(stored, original)
  assert.equal(terminated, 1)
  assert.throws(() => connectorRpc(id, {}), /Host is disconnected/)
  const second = (await (await rotate()).json()) as { token: string }
  assert.notEqual(second.token, result.token)
  assert.equal(stored, digest(second.token))
  assert.equal((await rotate(randomUUID())).status, 404)
  active = false
  assert.equal((await rotate()).status, 404)
  assert.equal(stored, digest(second.token))
})
