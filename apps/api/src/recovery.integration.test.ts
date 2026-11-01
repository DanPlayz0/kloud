import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'database recovery permissions, immutable new targets, policies, deduplication and unknown leases',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const adminDb = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = `recovery_${randomUUID().replaceAll('-', '')}`
    await adminDb.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    process.env.PLATFORM_ENCRYPTION_KEY = 'ef'.repeat(32)
    const { pool } = await import('./db.js'),
      { migrate } = await import('./migrate.js'),
      { app } = await import('./app.js'),
      { token, digest, publicOrigin } = await import('./security.js')
    const admin = randomUUID(),
      member = randomUUID(),
      host = randomUUID(),
      credential = token(),
      sessions = [token(), token()]
    const base = '/projects/demo/databases'
    const request = (path: string, method = 'GET', body?: unknown, user = 0) =>
      app.request(base + path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: `session=${sessions[user]}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const machine = (path: string, body?: unknown) =>
      app.request('/connectors/recovery/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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
        [digest(sessions[0]!), admin, digest(sessions[1]!), member],
      )
      await pool.query("INSERT INTO projects(slug,name) VALUES('demo','Demo');")
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'demo','member')",
        [member],
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token,capabilities) VALUES($1,'Host',$2,ARRAY['postgres'])",
        [host, digest(credential)],
      )
      const body = {
        slug: 'main',
        name: 'Main',
        connector_id: host,
        version: '17.6',
        request_key: randomUUID(),
      }
      assert.equal((await request('', 'POST', body, 1)).status, 403)
      const created = await request('', 'POST', body)
      assert.equal(created.status, 202, await created.clone().text())
      const data = (await created.json()) as any
      assert.equal(
        (await request(`/${data.resource}/credentials`, 'GET', undefined, 1))
          .status,
        403,
      )
      const credentials = (await (
        await request(`/${data.resource}/credentials`)
      ).json()) as any
      assert.equal(credentials.username, 'kloud')
      assert.ok(!('adminPassword' in credentials))
      assert.equal(credentials.public, false)
      assert.deepEqual(await (await request('', 'POST', body)).json(), data)
      assert.equal(
        (await request('', 'POST', { ...body, slug: 'different' })).status,
        409,
      )
      const claimed = (await (await machine('claim', {})).json()) as any
      assert.equal(claimed.job.id, data.id)
      assert.ok(claimed.job.credentials.adminPassword)
      assert.equal(
        ((await (await machine('claim', {})).json()) as any).job,
        null,
      )
      await machine(`${data.id}/result`, {
        state: 'succeeded',
        log: 'created',
        result: {},
        artifacts: [],
        pruned: [],
      })
      const destination = await request('/destinations', 'POST', {
        name: 'Disk',
        connector_id: host,
        config: { kind: 'disk', root: '/var/lib/kloud/backups' },
      })
      assert.equal(destination.status, 201, await destination.clone().text())
      const dest = (await destination.json()) as any
      const policyBody = {
        name: 'Daily',
        destinations: [
          {
            destination: dest.id,
            maxBytes: 1000000000,
            minimumPoints: 2,
            reserveBytes: 10000000,
          },
        ],
        cron: '0 2 * * *',
        timezone: 'UTC',
        enabled: false,
      }
      const preview = await request(
        `/${data.resource}/policies/preview`,
        'POST',
        policyBody,
      )
      assert.equal(preview.status, 200)
      assert.equal(
        (
          await request(`/${data.resource}/policies/preview`, 'POST', {
            ...policyBody,
            cron: '60 * * * *',
          })
        ).status,
        400,
      )
      const policy = await request(
        `/${data.resource}/policies`,
        'POST',
        policyBody,
      )
      assert.equal(policy.status, 201, await policy.clone().text())
      const p = (await policy.json()) as any
      assert.equal(
        (
          await request(
            `/${data.resource}/backups`,
            'POST',
            { policy: p.id, request_key: randomUUID() },
            1,
          )
        ).status,
        403,
      )
      const backup = await request(`/${data.resource}/backups`, 'POST', {
        policy: p.id,
        request_key: randomUUID(),
      })
      const b = (await backup.json()) as any
      const job = ((await (await machine('claim', {})).json()) as any).job
      assert.equal(job.id, b.id)
      assert.equal(job.backup.destinations[0].config.kind, 'disk')
      await pool.query(
        "UPDATE database_jobs SET started=now()-interval '70 minutes' WHERE id=$1",
        [b.id],
      )
      assert.equal(
        ((await (await machine('claim', {})).json()) as any).job,
        null,
      )
      assert.equal(
        (
          await pool.query('SELECT state FROM database_jobs WHERE id=$1', [
            b.id,
          ])
        ).rows[0].state,
        'unknown',
      )
      const reconciliation = await request(
        `/${data.resource}/reconcile`,
        'POST',
        { unknown_job: b.id, request_key: randomUUID(), confirm: true },
      )
      assert.equal(
        reconciliation.status,
        202,
        await reconciliation.clone().text(),
      )
      const reconcileId = ((await reconciliation.json()) as any).id
      const inspectJob = ((await (await machine('claim', {})).json()) as any)
        .job
      assert.equal(inspectJob.id, reconcileId)
      assert.equal(inspectJob.reconciliation.unknown_job, b.id)
      await machine(`${reconcileId}/result`, {
        state: 'succeeded',
        log: 'inspected',
        result: { quiescent: true, container_exists: true, running: true },
        artifacts: [],
        pruned: [],
      })
      assert.equal(
        (
          await pool.query('SELECT state FROM database_jobs WHERE id=$1', [
            b.id,
          ])
        ).rows[0].state,
        'failed',
      )
      assert.equal(
        (
          await pool.query('SELECT state FROM database_resources WHERE id=$1', [
            data.resource,
          ])
        ).rows[0].state,
        'ready',
      )
      assert.equal((await request('/imports', 'POST', {})).status, 400)
      const grants = await request('/access/grants', 'PUT', {
        user_id: member,
        grants: [{ resource: data.resource, capability: 'backup' }],
      })
      assert.equal(grants.status, 200, await grants.clone().text())
      const detail = await request(`/${data.resource}`, 'GET', undefined, 1)
      assert.equal(detail.status, 200)
      assert.equal(
        (await request(`/${data.resource}/credentials`, 'GET', undefined, 1))
          .status,
        403,
      )
      const stored = (
        await pool.query(
          'SELECT encrypted_credentials FROM database_resources WHERE id=$1',
          [data.resource],
        )
      ).rows[0].encrypted_credentials
      assert.ok(!stored.includes(credentials.password))
      await pool.query('UPDATE connectors SET revoked=true WHERE id=$1', [host])
      assert.equal((await machine('claim', {})).status, 401)
    } finally {
      await pool.end()
      await adminDb.query(`DROP SCHEMA ${schema} CASCADE`)
      await adminDb.end()
    }
  },
)
