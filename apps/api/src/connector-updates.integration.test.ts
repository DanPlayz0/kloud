import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import pg from 'pg'

test(
  'connector updates require management permission, configured trusted updater, and persist reconnect policy',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = 'connector_updates_' + randomUUID().replaceAll('-', '')
    await database.query('CREATE SCHEMA ' + schema)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', '-c search_path=' + schema)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { token, digest, publicOrigin } = await import('./security.js')
    const { registerRpc, acceptRpc } = await import('./connector-rpc.js')
    const manager = randomUUID(),
      reader = randomUUID(),
      host = randomUUID()
    const managerSecret = token(),
      readerSecret = token()
    const status = {
      type: 'connector-status',
      version: 'v1',
      revision: 'a'.repeat(40),
      started_at: new Date().toISOString(),
      updater: {
        configured: true,
        enabled: false,
        state: 'idle',
        checked_at: null,
        completed_at: null,
        error: null,
      },
    }
    const operations: unknown[] = []
    class FakeSocket extends EventEmitter {
      readyState = 1
      send(raw: string) {
        const message = JSON.parse(raw)
        operations.push(message.operation)
        queueMicrotask(() =>
          acceptRpc(host, { id: message.id, result: { accepted: true } }),
        )
      }
    }
    const socket = new FakeSocket()
    const request = (
      path: string,
      secret: string,
      method = 'GET',
      body?: unknown,
    ) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: 'session=' + secret,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    try {
      await migrate()
      await pool.query(
        "INSERT INTO users(id,username,capabilities) VALUES($1,'manager',ARRAY['connectors.manage']),($2,'reader',ARRAY['inventory.manage'])",
        [manager, reader],
      )
      await pool.query(
        "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')",
        [digest(managerSecret), manager, digest(readerSecret), reader],
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token,capabilities,agent_status) VALUES($1,'host',$2,ARRAY['connector-update-v1'],$3)",
        [host, digest(token()), status],
      )
      registerRpc(host, socket as unknown as import('ws').WebSocket)
      const path = `/connectors/${host}/updates`
      assert.equal(
        (await request(path + '/check', readerSecret, 'POST', {})).status,
        403,
      )
      assert.equal(
        (
          await request(path + '/check', managerSecret, 'POST', {
            command: '/bin/sh',
          })
        ).status,
        400,
      )
      assert.equal(
        (await request(path + '/check', managerSecret, 'POST', {})).status,
        200,
      )
      // Only a fixed, validated operation can enter the host transport.
      assert.deepEqual(operations.pop(), {
        kind: 'connector-update',
        action: 'check',
      })
      assert.equal(
        (await request(path, managerSecret, 'PUT', { enabled: true })).status,
        200,
      )
      assert.equal(
        (
          await pool.query('SELECT auto_update FROM connectors WHERE id=$1', [
            host,
          ])
        ).rows[0].auto_update,
        true,
      )
      assert.deepEqual(operations.pop(), {
        kind: 'connector-update',
        action: 'configure',
        enabled: true,
      })
      const metadata = (await (
        await request('/connectors/' + host, managerSecret)
      ).json()) as { agent_status: typeof status }
      assert.equal(metadata.agent_status.revision, status.revision)
      socket.emit('close')
      assert.equal(
        (await request(path, managerSecret, 'PUT', { enabled: false })).status,
        200,
      )
      assert.equal(
        (
          await pool.query('SELECT auto_update FROM connectors WHERE id=$1', [
            host,
          ])
        ).rows[0].auto_update,
        false,
      )
      await pool.query(
        "UPDATE connectors SET agent_status=jsonb_set(agent_status,'{updater,configured}','false') WHERE id=$1",
        [host],
      )
      assert.equal(
        (await request(path + '/check', managerSecret, 'POST', {})).status,
        409,
      )
      await pool.query('UPDATE connectors SET revoked=true WHERE id=$1', [host])
      assert.equal(
        (await request(path, managerSecret, 'PUT', { enabled: true })).status,
        404,
      )
    } finally {
      socket.emit('close')
      await pool.end()
      await database.query('DROP SCHEMA ' + schema + ' CASCADE')
      await database.end()
    }
  },
)
