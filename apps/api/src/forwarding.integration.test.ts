import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'listeners enforce assigned targets, host/protocol conflicts, current deploy authority and generation-bound reports',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
    const schema = `forwarding_${randomUUID().replaceAll('-', '')}`
    await db.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js'),
      { migrate } = await import('./migrate.js'),
      { app } = await import('./app.js'),
      { token, digest, publicOrigin } = await import('./security.js')
    const admin = randomUUID(),
      member = randomUUID(),
      host = randomUUID(),
      credential = token(),
      adminSession = token(),
      memberSession = token()
    const base = '/projects/demo/services/web/listeners'
    const request = (
      path: string,
      method: string,
      body?: unknown,
      session = memberSession,
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
    const machine = (listeners: unknown[] = []) =>
      app.request('/connectors/forwarding/sync', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ listeners }),
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
        "INSERT INTO projects(slug,name) VALUES('demo','Demo'); INSERT INTO services(project_slug,slug,name,type) VALUES('demo','web','Web','application'),('demo','other','Other','application')",
      )
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'demo','member')",
        [member],
      )
      await pool.query(
        "INSERT INTO service_grants(user_id,project_slug,capability,service) VALUES($1,'demo','read','web'),($1,'demo','deploy','web')",
        [member],
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token,capabilities) VALUES($1,'Host',$2,ARRAY['forwarding'])",
        [host, digest(credential)],
      )
      await pool.query(
        'INSERT INTO inventory(connector_id,container_id,data) VALUES($1,$2,$3)',
        [
          host,
          'a'.repeat(64),
          {
            name: 'web',
            project: 'demo',
            application: 'web',
            state: 'running',
          },
        ],
      )
      const config = {
        protocol: 'tcp',
        bind_address: '127.0.0.1',
        port: 15432,
        container: 'web',
        network: 'app',
        target_port: 8080,
        sources: [],
        enabled: true,
        application_protocol: 'generic',
      }
      const id = randomUUID()
      const saved = await request(`${base}/${id}`, 'PUT', {
        connector_id: host,
        config,
      })
      assert.equal(saved.status, 200, await saved.clone().text())
      assert.equal(
        (
          await request(`${base}/${randomUUID()}`, 'PUT', {
            connector_id: host,
            config,
          })
        ).status,
        409,
      )
      assert.equal(
        (
          await request(`${base}/${randomUUID()}`, 'PUT', {
            connector_id: host,
            config: { ...config, protocol: 'udp' },
          })
        ).status,
        200,
      )
      assert.equal(
        (
          await request(`${base}/${randomUUID()}`, 'PUT', {
            connector_id: host,
            config: { ...config, sources: ['bad'] },
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await request(`${base}/${id}`, 'PUT', {
            connector_id: host,
            config: { ...config, container: 'unassigned' },
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await request(`${base}/${id}`, 'PUT', {
            connector_id: host,
            config: { ...config, target_port: 5432 },
          })
        ).status,
        400,
      )
      const sync = await machine()
      assert.equal(sync.status, 200, await sync.clone().text())
      const rows = ((await sync.json()) as any).listeners
      assert.equal(rows.length, 2)
      const current = rows.find((row: any) => row.id === id)
      await machine([
        { id, generation: randomUUID(), applied: true, error: null },
      ])
      assert.equal(
        (
          await pool.query(
            'SELECT applied FROM service_listeners WHERE id=$1',
            [id],
          )
        ).rows[0].applied,
        false,
      )
      await machine([
        { id, generation: current.generation, applied: true, error: null },
      ])
      assert.equal(
        (
          await pool.query(
            'SELECT applied FROM service_listeners WHERE id=$1',
            [id],
          )
        ).rows[0].applied,
        true,
      )
      await pool.query(
        "UPDATE service_listeners SET reported=now()-interval '1 minute' WHERE id=$1",
        [id],
      )
      const stale = ((await (await request(base, 'GET')).json()) as any[]).find(
        (row) => row.id === id,
      )
      assert.equal(stale.applied, false)
      assert.equal(stale.stale, true)
      await pool.query(
        "DELETE FROM service_grants WHERE user_id=$1 AND capability='deploy'",
        [member],
      )
      assert.equal(
        ((await (await machine()).json()) as any).listeners.length,
        0,
      )
      assert.equal(
        (
          await pool.query(
            'SELECT applied FROM service_listeners WHERE id=$1',
            [id],
          )
        ).rows[0].applied,
        false,
      )
      assert.equal((await request(`${base}/${id}`, 'DELETE')).status, 403)
      assert.equal(
        (await request(`${base}/${id}`, 'DELETE', undefined, adminSession))
          .status,
        200,
      )
      await pool.query('UPDATE connectors SET revoked=true WHERE id=$1', [host])
      assert.equal((await machine()).status, 401)
    } finally {
      await pool.end()
      await db.query(`DROP SCHEMA ${schema} CASCADE`)
      await db.end()
    }
  },
)
