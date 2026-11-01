import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'variable drafts enforce reveal, full replacement review, optimistic concurrency, and no implicit deployment',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
    const schema = `variables_${randomUUID().replaceAll('-', '')}`
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
      member = randomUUID(),
      host = randomUUID()
    const sessions = [token(), token()]
    const base = '/projects/demo/services/web'
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      member = false,
    ) =>
      app.request(base + path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: `session=${sessions[member ? 1 : 0]}`,
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
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('demo','Demo'); INSERT INTO services(project_slug,slug,name,type) VALUES('demo','web','Web','application')",
      )
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'demo','member');",
        [member],
      )
      await pool.query(
        "INSERT INTO service_grants(user_id,project_slug,capability,service) VALUES($1,'demo','deploy','web')",
        [member],
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token,capabilities) VALUES($1,'Host',$2,ARRAY['deploy'])",
        [host, digest(token())],
      )
      const config = {
        connector_id: host,
        source: { type: 'image', image: 'nginx:alpine' },
        runtime: { environment: { TOKEN: 'sensitive', REMOVE: 'old' } },
      }
      const first = await request('/configuration', 'PUT', { config })
      assert.equal(first.status, 201, await first.clone().text())
      const revision = ((await first.json()) as any).id
      assert.equal(
        (await request(`/variables/${revision}`, 'GET', undefined, true))
          .status,
        403,
      )
      assert.equal(
        (await request('/configuration', 'PUT', { config }, true)).status,
        409,
      )
      const masked = (await (
        await request(`/configuration/${revision}`, 'GET', undefined, true)
      ).json()) as any
      assert.equal(masked.runtime.environment.TOKEN, '********')
      assert.equal(
        (
          await request(
            '/configuration',
            'PUT',
            {
              config: {
                ...masked,
                runtime: {
                  ...masked.runtime,
                  environment: {
                    ...masked.runtime.environment,
                    constructor: '********',
                  },
                },
              },
              previous: revision,
            },
            true,
          )
        ).status,
        400,
      )
      const preserved = await request(
        '/configuration',
        'PUT',
        { config: masked, previous: revision },
        true,
      )
      assert.equal(preserved.status, 201, await preserved.clone().text())
      const previous = ((await preserved.json()) as any).id
      await pool.query(
        "INSERT INTO service_grants(user_id,project_slug,capability,service) VALUES($1,'demo','reveal','web')",
        [member],
      )
      assert.match(
        (
          (await (
            await request(`/variables/${previous}`, 'GET', undefined, true)
          ).json()) as any
        ).text,
        /sensitive/,
      )
      const text =
        'TOKEN="********"\nMULTILINE="literal $HOME\\nline"\nEMPTY=\n'
      assert.equal(
        (
          await request(
            '/variables',
            'PUT',
            { previous, text, confirmed_removals: [] },
            true,
          )
        ).status,
        409,
      )
      assert.equal(
        (
          await request(
            '/variables',
            'PUT',
            { previous, text: 'A=1\nA=2', confirmed_removals: [] },
            true,
          )
        ).status,
        400,
      )
      const saved = await request(
        '/variables',
        'PUT',
        { previous, text, confirmed_removals: ['REMOVE'] },
        true,
      )
      assert.equal(saved.status, 201, await saved.clone().text())
      const id = ((await saved.json()) as any).id
      const { parseEnvironment } = await import('@kloud/protocol/environment')
      const result = parseEnvironment(
        (
          (await (
            await request(`/variables/${id}`, 'GET', undefined, true)
          ).json()) as any
        ).text,
      )
      assert.deepEqual(
        { ...result },
        { TOKEN: '********', MULTILINE: 'literal $HOME\nline', EMPTY: '' },
      )
      assert.equal(
        (
          await request(
            '/variables',
            'PUT',
            { previous, text, confirmed_removals: ['REMOVE'] },
            true,
          )
        ).status,
        409,
      )
      await pool.query(
        "DELETE FROM service_grants WHERE user_id=$1 AND capability='reveal'",
        [member],
      )
      assert.equal(
        (await request(`/variables/${id}`, 'GET', undefined, true)).status,
        403,
      )
      assert.equal((await pool.query('SELECT 1 FROM service_runs')).rowCount, 0)
    } finally {
      await pool.end()
      await db.query(`DROP SCHEMA ${schema} CASCADE`)
      await db.end()
    }
  },
)
