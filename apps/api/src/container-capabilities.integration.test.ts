import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import pg from 'pg'

test(
  'container grants authorize only their operations and reject revoked identity, scope or capability after host dispatch',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = 'container_capabilities_' + randomUUID().replaceAll('-', '')
    await database.query('CREATE SCHEMA ' + schema)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', '-c search_path=' + schema)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { token, digest, publicOrigin } = await import('./security.js')
    const { registerRpc, acceptRpc } = await import('./connector-rpc.js')
    const actor = randomUUID(),
      connector = randomUUID(),
      other = randomUUID(),
      secret = token(),
      container = 'a'.repeat(64),
      session = randomUUID()
    const operations: any[] = []
    let onRpc: () => Promise<void> = async () => {}
    class Socket extends EventEmitter {
      readyState = 1
      send(raw: string) {
        const message = JSON.parse(raw)
        operations.push(message.operation)
        void onRpc().then(() =>
          acceptRpc(connector, {
            id: message.id,
            result:
              message.operation.action === 'terminal-open'
                ? { session }
                : message.operation.action === 'logs'
                  ? { output: 'private output' }
                  : { ok: true },
          }),
        )
      }
    }
    const socket = new Socket()
    const base = `/projects/alpha/containers/${connector}/${container}`
    const request = (path: string, body?: unknown) =>
      app.request(path, {
        method: body ? 'POST' : 'GET',
        headers: {
          origin: publicOrigin,
          cookie: 'session=' + secret,
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    const grant = async (capability: string, target = container) => {
      await pool.query('DELETE FROM container_grants WHERE user_id=$1', [actor])
      await pool.query(
        "INSERT INTO container_grants(id,user_id,project_slug,capability,kind,connector_id,target) VALUES($1,$2,'alpha',$3,'id',$4,$5)",
        [randomUUID(), actor, capability, connector, target],
      )
    }
    try {
      await migrate()
      await pool.query("INSERT INTO users(id,username) VALUES($1,'member')", [
        actor,
      ])
      await pool.query(
        "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
        [digest(secret), actor],
      )
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('alpha','Alpha'),('beta','Beta')",
      )
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug) VALUES($1,'alpha'),($1,'beta')",
        [actor],
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token,seen,docker_seen,capabilities) VALUES($1,'host',$2,now(),now(),ARRAY['runtime']),($3,'other',$4,now(),now(),ARRAY['runtime'])",
        [connector, digest(token()), other, digest(token())],
      )
      await pool.query(
        'INSERT INTO inventory(connector_id,container_id,data) VALUES($1,$2,$3)',
        [
          connector,
          container,
          {
            id: container,
            name: 'web',
            project: 'alpha',
            application: 'web',
            state: 'running',
            cpu: null,
            memory: null,
            memoryLimit: null,
          },
        ],
      )
      registerRpc(connector, socket as any)
      for (const [capability, body] of [
        ['logs', { action: 'logs' }],
        ['lifecycle', { action: 'restart' }],
        ['terminal', { action: 'terminal-open' }],
        ['configuration', { action: 'inspect' }],
      ] as const) {
        await grant('view')
        assert.equal((await request(base + '/operation', body)).status, 403)
        await grant(capability)
        assert.equal(
          (await request(base + '/operation', body)).status,
          200,
          capability,
        )
        const permissions = await (await request(base + '/permissions')).json()
        assert.equal(permissions[capability], true)
        assert.equal(
          (await request(base.replace(connector, other) + '/operation', body))
            .status,
          404,
        )
        assert.equal(
          (
            await request(
              base.replace('/alpha/', '/beta/') + '/operation',
              body,
            )
          ).status,
          404,
        )
        await grant(capability, 'b'.repeat(64))
        assert.equal((await request(base + '/operation', body)).status, 403)
      }
      await grant('configuration')
      const settings = {
        cpus: 1.5,
        memory_mib: 256,
        restart_policy: 'on-failure',
        retry_count: 3,
      }
      assert.equal(
        (await request(base + '/operation', { action: 'update', settings }))
          .status,
        200,
      )
      assert.deepEqual(operations.at(-1).settings, settings)
      assert.equal(
        (
          await request(base + '/operation', {
            action: 'update',
            settings: { ...settings, binds: ['/var/run/docker.sock'] },
          })
        ).status,
        400,
      )
      assert.equal(
        (await request(base + '/operation', { action: 'update' })).status,
        400,
      )
      await grant('lifecycle')
      assert.equal(
        (await request(base + '/operation', { action: 'update', settings }))
          .status,
        403,
      )
      await grant('logs')
      onRpc = async () => {
        await pool.query('DELETE FROM container_grants WHERE user_id=$1', [
          actor,
        ])
      }
      const revokedLogs = await request(base + '/operation', { action: 'logs' })
      assert.equal(revokedLogs.status, 403)
      assert.ok(!(await revokedLogs.text()).includes('private output'))
      await grant('terminal')
      const before = operations.length
      assert.equal(
        (await request(base + '/operation', { action: 'terminal-open' }))
          .status,
        403,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual(
        operations.slice(before).map((op) => op.action),
        ['terminal-open', 'terminal-close'],
      )
      assert.equal(operations.at(-1).session, session)
      onRpc = async () => {
        await pool.query('UPDATE users SET disabled=true WHERE id=$1', [actor])
      }
      await grant('logs')
      assert.equal(
        (await request(base + '/operation', { action: 'logs' })).status,
        401,
      )
      assert.equal(
        (await request(base + '/operation', { action: 'restart' })).status,
        401,
      )
    } finally {
      socket.emit('close')
      await pool.end()
      await database.query('DROP SCHEMA ' + schema + ' CASCADE')
      await database.end()
    }
  },
)
