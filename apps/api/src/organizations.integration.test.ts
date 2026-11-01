import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'organizations isolate accounts, sessions, servers, projects, callbacks and shared credentials',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = 'organizations_' + randomUUID().replaceAll('-', '')
    await database.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', '-c search_path=' + schema)
    process.env.DATABASE_URL = url.href
    const { pool, rawPool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { findOrganization, migrateAllOrganizations } =
      await import('./organizations.js')
    const { runWithOrganization } = await import('./organization-context.js')
    const { appManifest } = await import('./github-app-setup.js')
    const { digest, token, publicOrigin } = await import('./security.js')
    const createdSchemas: string[] = []
    const admin = randomUUID(),
      session = token(),
      connector = randomUUID()
    const request = (
      path: string,
      cookie = '',
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.request(path, {
        method: body ? 'POST' : 'GET',
        headers: {
          origin: publicOrigin,
          cookie,
          'content-type': 'application/json',
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    try {
      await migrate()
      await pool.query(
        "INSERT INTO users(id,username,admin) VALUES($1,'existing-admin',true)",
        [admin],
      )
      await pool.query(
        "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
        [digest(session), admin],
      )
      const defaultCookie = 'session=' + session
      assert.equal(
        (
          await request('/organizations', '', {
            slug: 'unauthorized',
            name: 'No',
            username: 'owner',
            password: 'correct horse battery staple',
          })
        ).status,
        401,
      )
      for (const slug of ['alpha', 'beta']) {
        const response = await request('/organizations', defaultCookie, {
          slug,
          name: slug.toUpperCase(),
          username: 'owner',
          password: 'correct horse battery staple',
        })
        assert.equal(response.status, 201, await response.text())
        createdSchemas.push((await findOrganization(slug)).schema)
      }
      const alpha = await findOrganization('alpha'),
        beta = await findOrganization('beta')
      assert.notEqual(alpha.schema, beta.schema)
      const cookies: Record<string, string> = {}
      for (const org of [alpha, beta]) {
        assert.equal(
          (await request(`/organizations/${org.slug}/auth/me`, defaultCookie))
            .status,
          401,
        )
        const login = await request(
          `/organizations/${org.slug}/auth/password`,
          '',
          { username: 'owner', password: 'correct horse battery staple' },
        )
        assert.equal(login.status, 200, await login.clone().text())
        cookies[org.slug] = login.headers
          .getSetCookie()
          .find((value) => value.startsWith(`kloud_${org.slug}_session=`))!
          .split(';')[0]!
        assert.ok(cookies[org.slug]!.startsWith(`kloud_${org.slug}_session=`))
        await runWithOrganization(org, async () => {
          await pool.query('INSERT INTO projects(slug,name) VALUES($1,$2)', [
            'same-project',
            org.name,
          ])
          await pool.query(
            'INSERT INTO connectors(id,name,token) VALUES($1,$2,$3)',
            [connector, org.name, digest(token())],
          )
          await pool.query(
            "INSERT INTO git_connections(id,project,name,provider,origin,encrypted_credentials,all_projects) VALUES($1,'same-project',$2,'github','https://github.com','encrypted-private-value',true)",
            [randomUUID(), org.name],
          )
        })
        const projects = await request(
          `/organizations/${org.slug}/projects`,
          cookies[org.slug],
        )
        assert.equal(projects.status, 200)
        assert.equal((await projects.json())[0].name, org.name)
        const connectors = await request(
          `/organizations/${org.slug}/connectors`,
          cookies[org.slug],
        )
        assert.equal(connectors.status, 200)
        assert.equal((await connectors.json())[0].name, org.name)
        const saved = await request(
          `/organizations/${org.slug}/admin/git-connections`,
          cookies[org.slug],
        )
        assert.equal(saved.status, 200)
        const credentials = await saved.json()
        assert.equal(credentials.length, 1)
        assert.equal(credentials[0].name, org.name)
        assert.equal(credentials[0].all_projects, true)
        assert.equal(credentials[0].encrypted_credentials, undefined)
        const manifest = runWithOrganization(org, () => appManifest('Org app'))
        assert.equal(
          manifest.redirect_url,
          `${publicOrigin}/api/organizations/${org.slug}/git/github/manifest`,
        )
        assert.equal(
          manifest.setup_url,
          `${publicOrigin}/api/organizations/${org.slug}/git/github/setup`,
        )
        assert.equal(
          (await request(`/organizations/${org.slug}/auth/setup`)).status,
          200,
        )
        assert.equal(
          (
            await (
              await request(`/organizations/${org.slug}/auth/setup`)
            ).json()
          ).required,
          false,
        )
      }
      assert.equal(
        (await request('/organizations/beta/auth/me', cookies.alpha)).status,
        401,
      )
      assert.equal(
        (
          await request(
            '/organizations/alpha/projects',
            cookies.alpha,
            undefined,
            { 'x-kloud-organization': 'beta' },
          )
        ).status,
        400,
      )
      assert.equal(
        (
          await request('/projects', cookies.alpha, undefined, {
            'x-kloud-organization': 'alpha',
          })
        ).status,
        200,
      )
      assert.equal(
        (await request('/organizations/missing/projects', defaultCookie))
          .status,
        404,
      )
      assert.equal(
        (await request('/organizations/alpha/git/github/manifest?state=wrong'))
          .status,
        400,
      )
      assert.equal((await request('/organizations/lookup/beta')).status, 200)
      assert.equal((await request('/projects', defaultCookie)).status, 200)
      assert.equal(
        (await (await request('/projects', defaultCookie)).json()).length,
        0,
      )
      assert.equal(
        (await pool.query('SELECT count(*) FROM connectors')).rows[0].count,
        '0',
      )
      // All schemas receive future migrations without changing the default data.
      await migrateAllOrganizations()
      const migrated = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'src/migrate.ts'],
        {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          env: process.env,
        },
      )
      assert.match(migrated.stdout, /Migrations complete/)
      assert.equal(
        (
          await runWithOrganization(alpha, () =>
            pool.query('SELECT count(*) FROM projects'),
          )
        ).rows[0].count,
        '1',
      )
      assert.equal(
        (await rawPool.query('SELECT current_schema() AS schema')).rows[0]
          .schema,
        schema,
      )
    } finally {
      // Only drop the exact schemas provisioned by this test, never enumerate
      // organization schemas from the development database.
      for (const created of createdSchemas) {
        assert.match(created, /^kloud_org_[a-f0-9]{32}$/)
        await database.query(`DROP SCHEMA "${created}" CASCADE`)
      }
      await pool.end()
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      await database.end()
    }
  },
)
