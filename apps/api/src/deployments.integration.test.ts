import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, createHmac } from 'node:crypto'
import pg from 'pg'

test(
  'deployment migration, permissions, signed push filtering, deduplication, serialized claims and connector ownership',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = `deploy_${randomUUID().replaceAll('-', '')}`
    await database.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { token, digest, publicOrigin } = await import('./security.js')
    const admin = randomUUID(),
      member = randomUUID(),
      connector = randomUUID(),
      otherConnector = randomUUID()
    const adminSession = token(),
      memberSession = token(),
      connectorToken = token(),
      otherToken = token()
    const path = '/projects/demo/applications/web/deployment'
    const request = (method: string, body?: unknown, session = adminSession) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: `session=${session}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const machine = (path: string, secret = connectorToken, body = {}) =>
      app.request(`/connectors/deployments/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
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
      await pool.query("INSERT INTO projects(slug,name) VALUES('demo','Demo')")
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'demo','member')",
        [member],
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token) VALUES($1,'host',$2),($3,'other',$4)",
        [connector, digest(connectorToken), otherConnector, digest(otherToken)],
      )
      await pool.query(
        'INSERT INTO inventory(connector_id,container_id,data) VALUES($1,$2,$3)',
        [
          connector,
          'a'.repeat(64),
          { name: 'web', project: 'demo', application: 'web' },
        ],
      )
      const config = {
        connector_id: connector,
        container_name: 'web',
        repository: 'owner/repo',
        branch: 'main',
        kind: 'dockerfile',
        build_file: 'Dockerfile',
        context: '.',
        service: 'web',
        enabled: true,
      }
      assert.equal((await request('GET', undefined, memberSession)).status, 404)
      assert.equal((await request('PUT', config, memberSession)).status, 403)
      assert.equal(
        (await request('PUT', { ...config, container_name: 'missing' })).status,
        400,
      )
      const saved = await request('PUT', config)
      assert.equal(saved.status, 200)
      const { id, webhook_secret: secret } = (await saved.json()) as any
      assert.ok(secret)
      assert.equal(
        ((await (await request('GET')).json()) as any).webhook_secret,
        undefined,
      )
      const payload = {
        ref: 'refs/heads/main',
        after: 'b'.repeat(40),
        deleted: false,
        repository: { full_name: 'Owner/Repo' },
        padding: 'x'.repeat(70000),
      }
      const push = (
        value = payload,
        delivery = randomUUID(),
        signingSecret = secret,
      ) => {
        const raw = JSON.stringify(value)
        return app.request(`/hooks/github/${id}`, {
          method: 'POST',
          headers: {
            'x-github-event': 'push',
            'x-github-delivery': delivery,
            'x-hub-signature-256': `sha256=${createHmac('sha256', signingSecret).update(raw).digest('hex')}`,
          },
          body: raw,
        })
      }
      assert.equal((await push(payload, randomUUID(), 'bad')).status, 401)
      for (const ignored of [
        { ...payload, ref: 'refs/heads/other' },
        { ...payload, deleted: true },
        { ...payload, repository: { full_name: 'other/repo' } },
      ])
        assert.deepEqual(await (await push(ignored)).json(), { queued: false })
      const delivery = randomUUID()
      assert.equal((await push(payload, delivery)).status, 202)
      await push(payload, delivery)
      assert.equal(
        (await pool.query('SELECT * FROM deployment_builds')).rowCount,
        1,
      )
      const claims = await Promise.all([machine('claim'), machine('claim')])
      const jobs = await Promise.all(
        claims.map(async (r) => ((await r.json()) as any).job),
      )
      assert.equal(jobs.filter(Boolean).length, 1)
      const job = jobs.find(Boolean)
      assert.equal(job.commit, payload.after)
      assert.equal((await request('PUT', config)).status, 409)
      assert.deepEqual(
        await (
          await machine(`${job.id}/result`, otherToken, {
            status: 'succeeded',
            log: 'not mine',
          })
        ).json(),
        { ok: false },
      )
      assert.deepEqual(
        await (
          await machine(`${job.id}/result`, connectorToken, {
            status: 'succeeded',
            log: 'built',
          })
        ).json(),
        { ok: true },
      )
      assert.equal(
        ((await (await request('GET')).json()) as any).builds[0].status,
        'succeeded',
      )
      await push({ ...payload, after: 'c'.repeat(40) })
      assert.equal(
        (await request('PUT', { ...config, enabled: false })).status,
        200,
      )
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM deployment_builds WHERE status='queued'",
          )
        ).rowCount,
        0,
      )
      assert.deepEqual(await (await push()).json(), { queued: false })
      const rotated = (await (await request('POST')).json()) as any
      assert.ok(rotated.webhook_secret)
      assert.equal((await push()).status, 401)
      await pool.query('UPDATE connectors SET revoked=true WHERE id=$1', [
        connector,
      ])
      assert.equal((await machine('claim')).status, 401)
    } finally {
      await pool.end()
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      await database.end()
    }
  },
)
