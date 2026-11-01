import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
test(
  'Compose cutover atomically switches selected routes, preserves dependencies, and records service baselines',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      schema = `compose_${randomUUID().replaceAll('-', '')}`
    await db.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    process.env.PLATFORM_ENCRYPTION_KEY = 'ab'.repeat(32)
    const { pool } = await import('./db.js'),
      { migrate } = await import('./migrate.js'),
      { app } = await import('./app.js'),
      { routesHash } = await import('./rollout-api.js'),
      { token, digest, publicOrigin } = await import('./security.js')
    const admin = randomUUID(),
      host = randomUUID(),
      credential = token(),
      session = token(),
      base = '/projects/demo/services/stack'
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
        "INSERT INTO projects(slug,name) VALUES('demo','Demo');INSERT INTO services(project_slug,slug,name,type) VALUES('demo','stack','Stack','compose')",
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token,capabilities) VALUES($1,'Host',$2,ARRAY['deploy','proxy','rollout-v1'])",
        [host, digest(credential)],
      )
      const config = {
        connector_id: host,
        source: {
          type: 'compose',
          content: 'services:\n  web:\n    image: nginx:alpine',
        },
        runtime: {},
        deployment: {
          compatibilityReviewed: true,
          compose: { services: { web: {}, api: {} } },
        },
      }
      const saved = await request('/configuration', 'PUT', { config })
      assert.equal(saved.status, 201, await saved.clone().text())
      const revision = ((await saved.json()) as any).id
      const deployment = await request('/deploy', 'POST', {
        revision,
        request_key: randomUUID(),
      })
      assert.equal(deployment.status, 202, await deployment.clone().text())
      const id = ((await deployment.json()) as any).id
      assert.equal(((await (await machine('claim')).json()) as any).job.id, id)
      for (const name of ['web', 'api', 'db'])
        await pool.query(
          'INSERT INTO service_domains(id,project,service,connector_id,config) VALUES($1,$2,$3,$4,$5)',
          [
            randomUUID(),
            'demo',
            'stack',
            host,
            {
              hostname: `${name}.example.com`,
              path: '/',
              container: `old-${name}`,
              network: 'stable',
              port: 80,
              https: false,
              redirect: true,
            },
          ],
        )
      const details = {
        targets: {
          web: {
            candidate: 'new-web',
            previous: 'old-web',
            original: 'stack-web-1',
            action: 'redeploy',
          },
          api: {
            candidate: 'new-api',
            previous: 'old-api',
            original: 'stack-api-1',
            action: 'redeploy',
          },
        },
        commits: { web: 'a'.repeat(40), api: 'a'.repeat(40) },
        hashes: {
          web: 'b'.repeat(64),
          api: 'c'.repeat(64),
          db: 'd'.repeat(64),
        },
        images: {
          web: `sha256:${'e'.repeat(64)}`,
          api: `sha256:${'f'.repeat(64)}`,
        },
        dependencies: [],
      }
      const progress = (stage: string, compose = details) =>
        machine(`${id}/rollout`, {
          stage,
          candidate: `kloud-demo-stack-release-${id}`,
          previous: 'prior-unit',
          compose,
        })
      for (const stage of ['prepared', 'started', 'ready']) {
        const response = await progress(stage)
        assert.equal(response.status, 200, await response.clone().text())
      }
      assert.equal((await progress('cutover')).status, 200)
      const routes = (
        await pool.query(
          "SELECT config FROM service_domains ORDER BY config->>'hostname'",
        )
      ).rows.map((row) => row.config.container)
      assert.deepEqual(routes, ['new-api', 'old-db', 'new-web'])
      assert.equal(
        (await progress('serving')).status,
        409,
        'cannot retire before proxy revision is confirmed',
      )
      const hash = await routesHash(pool, host)
      await pool.query(
        'INSERT INTO proxy_status(connector_id,desired,applied,error) VALUES($1,$2,$2,NULL)',
        [host, hash],
      )
      assert.equal((await progress('cutover')).status, 200)
      assert.equal((await progress('serving')).status, 200)
      assert.equal((await progress('retired')).status, 200)
      const state = (
        await pool.query('SELECT compose_state FROM service_release_state')
      ).rows[0].compose_state
      assert.deepEqual(state.targets, { api: 'new-api', web: 'new-web' })
      assert.equal(state.commits.web, 'a'.repeat(40))
      assert.equal(state.hashes.db, 'd'.repeat(64))
    } finally {
      await pool.end()
      await db.query(`DROP SCHEMA ${schema} CASCADE`)
      await db.end()
    }
  },
)
