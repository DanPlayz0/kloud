import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'durable bluegreen stages confirm proxy cutover, pause ambiguous state, and claim FIFO receipt order',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
    const schema = `rollouts_${randomUUID().replaceAll('-', '')}`
    await db.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    process.env.PLATFORM_ENCRYPTION_KEY = 'ab'.repeat(32)
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { digest, token, publicOrigin } = await import('./security.js')
    const admin = randomUUID(),
      host = randomUUID(),
      credential = token(),
      session = token()
    const base = '/projects/demo/services/web'
    const request = (path: string, method = 'GET', body?: unknown) =>
      app.request(base + path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: `session=${session}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const machine = (path: string, body: unknown = {}) =>
      app.request(`/connectors/platform/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    try {
      await migrate()
      await migrate()
      await pool.query(
        "INSERT INTO users(id,username,admin) VALUES($1,'admin',true)",
        [admin],
      )
      await pool.query(
        "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
        [digest(session), admin],
      )
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('demo','Demo');INSERT INTO services(project_slug,slug,name,type) VALUES('demo','web','Web','application')",
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token,capabilities) VALUES($1,'Host',$2,ARRAY['deploy','proxy','rollout-v1'])",
        [host, digest(credential)],
      )
      const config = {
        connector_id: host,
        source: { type: 'image', image: 'nginx:alpine' },
        deployment: { strategy: 'blue-green', compatibilityReviewed: true },
        runtime: {},
      }
      const saved = await request('/configuration', 'PUT', { config })
      assert.equal(saved.status, 201, await saved.clone().text())
      const revision = ((await saved.json()) as any).id
      const enqueue = async () => {
        const response = await request('/deploy', 'POST', {
          revision,
          request_key: randomUUID(),
        })
        assert.equal(response.status, 202, await response.clone().text())
        return ((await response.json()) as any).id
      }
      const first = await enqueue(),
        second = await enqueue()
      // Receipt sequence is authoritative even when user-visible timestamps tie or differ.
      await pool.query(
        "UPDATE service_runs SET created=now()-interval '1 day' WHERE id=$1",
        [second],
      )
      const claimed = await machine('claim')
      assert.equal(claimed.status, 200, await claimed.clone().text())
      assert.equal(((await claimed.json()) as any).job.id, first)
      const candidate = `kloud-demo-web-release-${first}`
      const progress = (stage: string) =>
        machine(`${first}/rollout`, { stage, candidate, previous: null })
      assert.equal((await progress('serving')).status, 409)
      for (const stage of ['prepared', 'started', 'ready'])
        assert.equal((await progress(stage)).status, 200)
      assert.equal((await progress('cutover')).status, 200)
      assert.equal((await progress('serving')).status, 200)
      assert.equal((await progress('retired')).status, 200)
      assert.equal((await progress('started')).status, 409)
      assert.equal(
        (
          await machine(`${first}/result`, {
            status: 'succeeded',
            log: 'ready',
            artifacts: { image: 'sha256:abc' },
          })
        ).status,
        200,
      )
      assert.equal(
        (await pool.query('SELECT serving,paused FROM service_release_state'))
          .rows[0].serving,
        candidate,
      )
      const next = await machine('claim')
      assert.equal(((await next.json()) as any).job.id, second)
      const nextCandidate = `kloud-demo-web-release-${second}`
      for (const stage of ['prepared', 'started', 'ready', 'uncertain'])
        assert.equal(
          (
            await machine(`${second}/rollout`, {
              stage,
              candidate: nextCandidate,
              previous: candidate,
            })
          ).status,
          200,
        )
      assert.equal(
        (await pool.query('SELECT paused FROM service_release_state')).rows[0]
          .paused,
        true,
      )
      await pool.query(
        "UPDATE service_rollouts SET updated=now()-interval '2 minutes' WHERE run=$1",
        [second],
      )
      const reconciliation = ((await (await machine('claim')).json()) as any)
        .job
      assert.equal(reconciliation.id, second)
      assert.equal(reconciliation.reconcile.candidate, nextCandidate)
      assert.equal(
        (
          await machine(`${second}/result`, {
            status: 'failed',
            uncertain: true,
            log: 'reconciling',
            artifacts: null,
          })
        ).status,
        200,
      )
      assert.equal(
        (
          await pool.query('SELECT status FROM service_runs WHERE id=$1', [
            second,
          ])
        ).rows[0].status,
        'running',
      )
    } finally {
      await pool.end()
      await db.query(`DROP SCHEMA ${schema} CASCADE`)
      await db.end()
    }
  },
)
