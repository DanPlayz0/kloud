import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'one identity spans organizations while local roles, projects, callbacks and credentials stay isolated',
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
    const { pool, rawPool, transaction } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { findOrganization, migrateAllOrganizations } =
      await import('./organizations.js')
    const { runWithOrganization } = await import('./organization-context.js')
    const { withAccounts, getAccountSchema, linkOrganizationAccount } =
      await import('./global-accounts.js')
    const { appManifest } = await import('./github-app-setup.js')
    const { digest, token, publicOrigin, hashPassword } =
      await import('./security.js')
    const createdSchemas: string[] = []
    const owner = randomUUID(),
      member = randomUUID(),
      session = token(),
      memberSession = token(),
      connector = randomUUID()
    const cookie = 'session=' + session,
      memberCookie = 'session=' + memberSession
    const request = (
      path: string,
      cookie = '',
      body?: unknown,
      method = body === undefined ? 'GET' : 'POST',
      headers: Record<string, string> = {},
    ) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie,
          'content-type': 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    async function create(body: unknown, expectedSlug: string) {
      const response = await request('/organizations', cookie, body)
      assert.equal(response.status, 201, await response.clone().text())
      assert.equal((await response.json()).slug, expectedSlug)
      const org = await findOrganization(expectedSlug)
      createdSchemas.push(org.schema)
      return org
    }
    try {
      await migrate()
      const password = await hashPassword('correct horse battery staple')
      await pool.query(
        "INSERT INTO users(id,username,password_hash,email,admin) VALUES($1,'owner',$2,'owner@example.com',true)",
        [owner, password],
      )
      await pool.query(
        "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
        [digest(session), owner],
      )
      await migrateAllOrganizations()
      assert.ok(getAccountSchema())
      assert.equal(
        (await request('/organizations', '', { name: 'Unauthorized' })).status,
        401,
      )
      const alpha = await create({ name: 'Álpha!' }, 'alpha')
      await create({ name: 'Álpha!' }, 'alpha-2')
      const beta = await create({ name: 'Beta', slug: 'beta' }, 'beta')
      await create({ name: '東京' }, 'organization')
      assert.notEqual(alpha.schema, beta.schema)
      assert.equal(
        (
          await request('/organizations', cookie, {
            name: 'Conflict',
            slug: 'alpha',
          })
        ).status,
        409,
      )
      const current = await request('/auth/me', cookie)
      assert.equal(current.status, 200)
      assert.equal((await current.json()).id, owner)
      for (const org of [alpha, beta]) {
        const identity = await request(
          `/organizations/${org.slug}/auth/me`,
          cookie,
        )
        assert.equal(identity.status, 200)
        const user = await identity.json()
        assert.equal(user.id, owner)
        assert.equal(user.email, 'owner@example.com')
        assert.equal(user.admin, true)
        const local = await runWithOrganization(org, () =>
          pool.query('SELECT id,admin,password_hash FROM users'),
        )
        assert.equal(local.rows.length, 1)
        assert.equal(local.rows[0].id, owner)
        assert.equal(local.rows[0].admin, true)
        assert.equal(local.rows[0].password_hash, 'global-account')
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
        for (const resource of [
          'projects',
          'connectors',
          'admin/git-connections',
        ]) {
          const response = await request(
            `/organizations/${org.slug}/${resource}`,
            cookie,
          )
          assert.equal(response.status, 200, await response.clone().text())
          const rows = await response.json()
          assert.equal(rows.length, 1)
          assert.equal(rows[0].name, org.name)
          assert.equal(rows[0].encrypted_credentials, undefined)
        }
        const manifest = runWithOrganization(org, () => appManifest('Org app'))
        assert.equal(
          manifest.redirect_url,
          `${publicOrigin}/api/organizations/${org.slug}/git/github/manifest`,
        )
        assert.equal(
          manifest.setup_url,
          `${publicOrigin}/api/organizations/${org.slug}/git/github/setup`,
        )
      }
      const list = await request('/organizations', cookie)
      assert.equal(list.status, 200)
      assert.deepEqual(
        (await list.json()).map((org: any) => org.slug).sort(),
        ['alpha', 'alpha-2', 'beta', 'default', 'organization'].sort(),
      )
      // A login through one organization's URL issues the same account session cookie.
      const login = await request('/organizations/beta/auth/password', '', {
        username: 'owner@example.com',
        password: 'correct horse battery staple',
      })
      assert.equal(login.status, 200, await login.clone().text())
      const sharedCookie = login.headers
        .getSetCookie()
        .find((value) => value.startsWith('session='))!
        .split(';')[0]!
      assert.equal(
        (await request('/organizations/alpha/projects', sharedCookie)).status,
        200,
      )
      assert.equal(
        (await request('/organizations/beta/projects', sharedCookie)).status,
        200,
      )
      // Organization Administrators can edit the default display metadata without changing URLs.
      const metadata = {
        name: 'Home infrastructure',
        description: 'Our servers',
        website: 'https://example.com',
      }
      const patched = await request(
        '/organizations/current',
        cookie,
        metadata,
        'PATCH',
      )
      assert.equal(patched.status, 200, await patched.clone().text())
      assert.deepEqual(await patched.json(), { slug: 'default', ...metadata })
      const details = await (
        await request('/organizations/current', cookie)
      ).json()
      assert.equal(details.slug, 'default')
      assert.equal(details.name, metadata.name)
      assert.equal(details.description, metadata.description)
      assert.equal(details.website, metadata.website)
      await withAccounts(async () => {
        await pool.query(
          "INSERT INTO users(id,username,password_hash,account_email) VALUES($1,'member','hash','member@example.com')",
          [member],
        )
        await pool.query(
          "INSERT INTO sessions VALUES($1,$2,now()+interval '1 hour')",
          [digest(memberSession), member],
        )
      })
      await transaction((db) =>
        linkOrganizationAccount(
          db,
          { id: member, username: 'member', email: 'member@example.com' },
          { admin: false },
        ),
      )
      assert.equal(
        (
          await request(
            '/organizations/current',
            memberCookie,
            { name: 'Take over' },
            'PATCH',
          )
        ).status,
        403,
      )
      assert.equal(
        (
          await request('/organizations', memberCookie, {
            name: 'Unauthorized member create',
          })
        ).status,
        403,
      )
      assert.equal(
        (await request('/organizations/alpha/projects', memberCookie)).status,
        403,
      )
      const available = await (
        await request('/organizations', memberCookie)
      ).json()
      assert.deepEqual(
        available.map((org: any) => org.slug),
        ['default'],
      )
      await runWithOrganization(beta, () =>
        transaction((db) =>
          linkOrganizationAccount(
            db,
            { id: member, username: 'member', email: 'member@example.com' },
            { admin: false },
          ),
        ),
      )
      assert.equal(
        (
          await (
            await request('/organizations/beta/auth/me', memberCookie)
          ).json()
        ).admin,
        false,
      )
      assert.equal(
        (
          await request(
            '/organizations/beta/organizations/current',
            memberCookie,
            { name: 'Take over beta' },
            'PATCH',
          )
        ).status,
        403,
      )
      assert.equal(
        (
          await request(
            '/organizations/alpha/projects',
            cookie,
            undefined,
            'GET',
            { 'x-kloud-organization': 'beta' },
          )
        ).status,
        400,
      )
      assert.equal(
        (
          await request('/projects', cookie, undefined, 'GET', {
            'x-kloud-organization': 'alpha',
          })
        ).status,
        200,
      )
      assert.equal(
        (await request('/organizations/missing/projects', cookie)).status,
        404,
      )
      assert.equal(
        (await request('/organizations/alpha/git/github/manifest?state=wrong'))
          .status,
        400,
      )
      assert.equal((await request('/organizations/lookup/beta')).status, 200)
      assert.equal(
        (await (await request('/projects', cookie)).json()).length,
        0,
      )
      assert.equal(
        (await pool.query('SELECT count(*) FROM connectors')).rows[0].count,
        '0',
      )
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
      const accounts = getAccountSchema()
      await pool.end()
      for (const created of createdSchemas) {
        assert.match(created, /^kloud_org_[a-f0-9]{32}$/)
        await database.query(`DROP SCHEMA "${created}" CASCADE`)
      }
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      if (accounts) {
        assert.match(accounts, /^kloud_accounts_[a-f0-9]{32}$/)
        await database.query(`DROP SCHEMA "${accounts}" CASCADE`)
      }
      await database.end()
    }
  },
)
