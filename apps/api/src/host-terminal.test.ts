import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { app } from './app.js'
import { pool } from './db.js'
import { publicOrigin } from './security.js'
import { registerRpc, acceptRpc } from './connector-rpc.js'

test('host terminal requires connector administration and rechecks access after RPC', async (t) => {
  const host = randomUUID(),
    owner = randomUUID(),
    session = randomUUID()
  let allowed = false,
    enabled = true,
    revokedDuringRpc = false
  const operations: any[] = []
  t.mock.method(pool, 'query', async (sql: string) => {
    if (sql.includes('FROM sessions'))
      return {
        rows: [
          {
            id: owner,
            admin: false,
            capabilities: allowed ? ['connectors.manage'] : [],
          },
        ],
      }
    if (sql.includes('FROM connectors'))
      return { rows: enabled ? [{ capabilities: ['host-terminal'] }] : [] }
    throw new Error('Unexpected query')
  })
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(data: string) {
      const message = JSON.parse(data)
      operations.push(message.operation)
      if (revokedDuringRpc) allowed = false
      queueMicrotask(() =>
        acceptRpc(host, { id: message.id, result: { session } }),
      )
    },
  })
  registerRpc(host, socket as any)
  const request = (action = 'terminal-open') =>
    app.request(`/admin/connectors/${host}/terminal`, {
      method: 'POST',
      headers: {
        origin: publicOrigin,
        cookie: 'session=test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action }),
    })
  try {
    assert.equal((await request()).status, 403)
    assert.equal(operations.length, 0)
    allowed = true
    enabled = false
    assert.equal((await request()).status, 409)
    enabled = true
    assert.equal((await request('restart')).status, 400)
    assert.equal((await request()).status, 200)
    assert.deepEqual(operations[0], {
      kind: 'host-terminal',
      action: 'terminal-open',
      owner,
    })
    revokedDuringRpc = true
    assert.equal((await request()).status, 403)
    assert.equal(operations.at(-1).action, 'terminal-close')
    assert.equal(operations.at(-1).session, session)
  } finally {
    socket.emit('close')
  }
})
