import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { serve } from '@hono/node-server'
import WebSocket from 'ws'
import pg from 'pg'

test(
  'PM2 discovery, independent freshness, persistent assignments, permissions and log revocation',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
    const schema = `pm2_${randomUUID().replaceAll('-', '')}`
    await db.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js'),
      { migrate } = await import('./migrate.js'),
      { app } = await import('./app.js')
    const { digest, token, publicOrigin } = await import('./security.js')
    const { acceptPm2Snapshot } = await import('./pm2-inventory.js'),
      { acceptSnapshot, attachConnectors } = await import('./connectors.js')
    const { registerRpc, acceptRpc } = await import('./connector-rpc.js')
    const admin = randomUUID(),
      member = randomUUID(),
      host = randomUUID(),
      adminSession = token(),
      memberSession = token(),
      credential = token()
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      session = adminSession,
    ) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: `session=${session}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const snapshot = (name = 'web', available = true) => ({
      type: 'pm2-snapshot',
      version: 1,
      host: 'PM2 host',
      available,
      workers: available
        ? [
            {
              id: 0,
              name,
              namespace: 'default',
              status: 'online',
              mode: 'fork_mode',
              pid: 100,
              uptime: 1000,
              restarts: 0,
              cpu: 1,
              memory: 1000,
            },
          ]
        : [],
    })
    let onRpc = async (_message: any) => {}
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      send(value: string) {
        const message = JSON.parse(value)
        void onRpc(message).then(() =>
          acceptRpc(host, {
            id: message.id,
            result:
              message.operation.action === 'logs'
                ? { output: 'safe-output', unavailable: false }
                : { results: [{ id: 0, ok: true }] },
          }),
        )
      },
    })
    try {
      await migrate()
      await migrate()
      await pool.query(
        "INSERT INTO users(id,username,admin) VALUES($1,'admin',true),($2,'member',false)",
        [admin, member],
      )
      await pool.query(
        "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')",
        [digest(adminSession), admin, digest(memberSession), member],
      )
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('demo','Demo'),('other','Other')",
      )
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug) VALUES($1,'demo')",
        [member],
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token,capabilities) VALUES($1,'PM2 host',$2,ARRAY['pm2'])",
        [host, digest(credential)],
      )
      await acceptPm2Snapshot(host, snapshot())
      assert.deepEqual(await (await request('/admin/pm2')).json(), [])
      await pool.query('UPDATE connectors SET discovery=true WHERE id=$1', [
        host,
      ])
      await acceptPm2Snapshot(host, snapshot())
      const inventory = await (await request('/admin/pm2')).json()
      const id = inventory[0].id,
        base = `/projects/demo/pm2/${id}`
      assert.equal(
        (await request('/admin/pm2', 'GET', undefined, memberSession)).status,
        403,
      )
      assert.equal(
        (await request(`/admin/pm2/${id}`, 'PUT', { project: 'demo' })).status,
        200,
      )
      assert.deepEqual(
        await (
          await request('/projects/demo/pm2', 'GET', undefined, memberSession)
        ).json(),
        [],
      )
      const grants = (capabilities: string[]) =>
        request(`/projects/demo/access/members/${member}`, 'PUT', {
          role: 'member',
          grants: [],
          pm2_grants: capabilities.map((capability) => ({
            capability,
            app: id,
          })),
        })
      assert.equal((await grants(['manage'])).status, 200)
      assert.equal(
        (
          await (
            await request('/projects/demo/pm2', 'GET', undefined, memberSession)
          ).json()
        ).length,
        1,
      )
      assert.equal(
        (
          await request(
            `/projects/other/pm2/${id}/permissions`,
            'GET',
            undefined,
            memberSession,
          )
        ).status,
        404,
      )
      assert.equal(
        (await request(`${base}/logs`, 'GET', undefined, memberSession)).status,
        403,
      )
      assert.equal(
        (
          await request(
            `${base}/operation`,
            'POST',
            { action: 'delete' },
            memberSession,
          )
        ).status,
        403,
      )
      registerRpc(host, socket as any)
      assert.equal(
        (
          await request(
            `${base}/operation`,
            'POST',
            { action: 'restart' },
            memberSession,
          )
        ).status,
        200,
      )
      // Omitted PM2 grants survive edits through older clients.
      await request(`/projects/demo/access/members/${member}`, 'PUT', {
        role: 'member',
        grants: [],
      })
      assert.equal(
        (
          await (
            await request(
              `${base}/permissions`,
              'GET',
              undefined,
              memberSession,
            )
          ).json()
        ).manage,
        true,
      )
      await pool.query(
        "UPDATE connectors SET docker_seen=now()-interval '1 hour' WHERE id=$1",
        [host],
      )
      await acceptPm2Snapshot(host, snapshot())
      const freshness = (
        await pool.query(
          "SELECT docker_seen<now()-interval '20 seconds' AS docker_stale,pm2_seen>now()-interval '20 seconds' AS pm2_fresh FROM connectors WHERE id=$1",
          [host],
        )
      ).rows[0]
      assert.deepEqual(freshness, { docker_stale: true, pm2_fresh: true })
      await acceptPm2Snapshot(host, snapshot('web', false))
      await acceptSnapshot(host, {
        type: 'snapshot',
        version: 1,
        host: 'host',
        containers: [],
      })
      assert.equal(
        (
          await request(
            `${base}/operation`,
            'POST',
            { action: 'restart' },
            memberSession,
          )
        ).status,
        409,
      )
      assert.equal(
        (await (await request('/projects/demo/pm2')).json())[0].workers.length,
        1,
      )
      await acceptPm2Snapshot(host, { ...snapshot(), workers: [] })
      assert.equal(
        (await (await request('/projects/demo/pm2')).json())[0].present,
        false,
      )
      await acceptPm2Snapshot(host, snapshot())
      assert.equal(
        (await (await request('/projects/demo/pm2')).json())[0].id,
        id,
      )
      await grants(['logs'])
      // Revocation while the connector is producing output must suppress that output.
      onRpc = async () => {
        await pool.query('DELETE FROM pm2_grants WHERE user_id=$1', [member])
      }
      const logs = await request(
        `${base}/logs`,
        'GET',
        undefined,
        memberSession,
      )
      const text = await logs.text()
      assert.match(text, /event: unavailable/)
      assert.equal(text.includes('safe-output'), false)
      onRpc = async () => {}
      await grants(['logs'])
      const live = await request(
        `${base}/logs?stream=stderr&worker=0`,
        'GET',
        undefined,
        memberSession,
      )
      const reader = live.body!.getReader()
      const first = new TextDecoder().decode((await reader.read()).value)
      assert.match(first, /safe-output/)
      await reader.cancel()
      await pool.query(
        "UPDATE connectors SET pm2_seen=now()-interval '21 seconds' WHERE id=$1",
        [host],
      )
      assert.equal(
        (await request(`${base}/logs`, 'GET', undefined, memberSession)).status,
        409,
      )
      await acceptPm2Snapshot(host, snapshot())
      socket.emit('close')
      assert.equal(
        (await request(`${base}/operation`, 'POST', { action: 'stop' })).status,
        503,
      )
      await request(`/admin/pm2/${id}`, 'PUT', { project: 'other' })
      assert.equal(
        (await pool.query('SELECT * FROM pm2_grants WHERE app=$1', [id]))
          .rowCount,
        0,
      )
      assert.equal((await request(`${base}/permissions`)).status, 404)
      const badGrant = await request(
        `/projects/demo/access/members/${member}`,
        'PUT',
        {
          role: 'member',
          grants: [],
          pm2_grants: [{ capability: 'view', app: id }],
        },
      )
      assert.equal(badGrant.status, 400)
      assert.equal(
        await acceptPm2Snapshot(host, snapshot(), () => false),
        false,
      )
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
      const detach = attachConnectors(server)
      let wire: WebSocket | undefined
      try {
        await once(server, 'listening')
        const port = (server.address() as { port: number }).port
        wire = new WebSocket(`ws://127.0.0.1:${port}/connectors/ws`, {
          headers: { authorization: `Bearer ${credential}` },
        })
        await once(wire, 'open')
        const accepted = new Promise<string[]>((resolve, reject) => {
          const runtimes: string[] = []
          wire!.on('message', (raw) => {
            const message = JSON.parse(raw.toString())
            if (message.type === 'accepted') {
              runtimes.push(message.runtime ?? 'docker')
              if (runtimes.length === 2) resolve(runtimes)
            }
          })
          wire!.once('close', () => {
            if (runtimes.length !== 2)
              reject(new Error('Concurrent runtime snapshots rejected'))
          })
        })
        wire.send(
          JSON.stringify({
            type: 'capabilities',
            capabilities: ['pm2', 'runtime'],
          }),
        )
        wire.send(JSON.stringify(snapshot()))
        wire.send(
          JSON.stringify({
            version: 1,
            type: 'snapshot',
            host: 'mixed host',
            containers: [],
          }),
        )
        assert.deepEqual((await accepted).sort(), ['docker', 'pm2'])
        wire.send('null')
        const [code] = await once(wire, 'close')
        assert.equal(code, 1008)
      } finally {
        wire?.terminate()
        detach()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    } finally {
      socket.emit('close')
      await pool.end()
      await db.query(`DROP SCHEMA ${schema} CASCADE`)
      await db.end()
    }
  },
)
