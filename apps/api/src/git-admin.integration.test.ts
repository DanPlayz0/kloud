import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'administrators prepare connections without services and control creation separately from using shared connections',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = `git_admin_${randomUUID().replaceAll('-', '')}`
    await root.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    process.env.PLATFORM_ENCRYPTION_KEY = 'ac'.repeat(32)
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { digest, token, publicOrigin } = await import('./security.js')
    const { unseal } = await import('./platform-secrets.js')
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const sessions = ids.map(() => token())
    const originalFetch = globalThis.fetch
    let providerCalls = 0
    globalThis.fetch = async () => {
      providerCalls++
      return Response.json({
        id: 99,
        full_name: 'org/private',
        default_branch: 'main',
        private: true,
      })
    }
    const request = (path: string, method = 'GET', body?: unknown, actor = 0) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: `session=${sessions[actor]}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const base = '/projects/demo/git-connections'
    const personal = {
      service: 'web',
      name: 'Personal',
      provider: 'github',
      token: 'personal-secret',
    }
    try {
      await migrate()
      await migrate()
      for (const [index, id] of ids.entries()) {
        await pool.query(
          'INSERT INTO users(id,username,admin,capabilities) VALUES($1,$2,$3,$4)',
          [
            id,
            `user-${index}`,
            index === 0,
            index === 2 ? ['git.create', 'git.manage'] : [],
          ],
        )
        await pool.query(
          "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
          [digest(sessions[index]!), id],
        )
      }
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('demo','Demo'),('elsewhere','Elsewhere')",
      )
      assert.equal(
        (await request('/admin/git-connections', 'GET', undefined, 1)).status,
        403,
      )
      assert.equal(
        (await request('/admin/git-connections/projects', 'GET', undefined, 1))
          .status,
        403,
      )
      assert.equal(
        (await request('/admin/git-connections', 'GET', undefined, 2)).status,
        200,
      )
      const prepared = await request(
        base,
        'POST',
        {
          name: 'Prepared',
          provider: 'github',
          scope: 'shared',
          project_access: true,
          token: 'prepared-secret',
        },
        2,
      )
      assert.equal(prepared.status, 201)
      const { id } = await prepared.json()
      assert.equal((await pool.query('SELECT * FROM services')).rowCount, 0)
      const saved = (
        await pool.query('SELECT * FROM git_connections WHERE id=$1', [id])
      ).rows[0]
      assert.equal(saved.owner, null)
      assert.equal(saved.project_access, true)
      assert.equal(unseal(saved.encrypted_credentials).token, 'prepared-secret')
      const manifestStart = await request(
        base + '/github-app/start',
        'POST',
        { name: 'Prepared app', scope: 'shared', project_access: true },
        2,
      )
      assert.equal(manifestStart.status, 200)
      const started = await manifestStart.json()
      assert.equal(
        (await pool.query('SELECT service FROM github_app_setups')).rows[0]
          .service,
        null,
      )
      await request(`/admin/users/${ids[2]}`, 'PUT', {
        disabled: false,
        capabilities: ['git.manage'],
      })
      assert.equal(
        (
          await request(
            base,
            'POST',
            { name: 'Denied', provider: 'github', token: 'secret' },
            2,
          )
        ).status,
        403,
      )
      assert.equal(
        (
          await request(
            base + '/github-app/finish',
            'POST',
            { state: started.state, code: 'manifest-code' },
            2,
          )
        ).status,
        403,
      )
      assert.equal(providerCalls, 0)
      await pool.query(
        "INSERT INTO services(project_slug,slug,name,type) VALUES('demo','web','Web','application')",
      )
      for (const actor of [1, 2]) {
        await pool.query(
          "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'demo','member')",
          [ids[actor]],
        )
        await pool.query(
          "INSERT INTO service_grants(user_id,project_slug,service,capability) VALUES($1,'demo','web','deploy')",
          [ids[actor]],
        )
      }
      assert.equal((await request(base, 'POST', personal, 1)).status, 403)
      assert.equal(
        (
          await request(
            base + '/github-app/start',
            'POST',
            { name: 'Denied', service: 'web' },
            1,
          )
        ).status,
        403,
      )
      const available = await request(
        base + '?service=web',
        'GET',
        undefined,
        1,
      )
      assert.equal(available.status, 200)
      assert.equal((await available.json())[0].id, id)
      assert.equal(
        (
          await request(
            base + `/${id}/repository`,
            'POST',
            { service: 'web', url: 'https://github.com/org/private' },
            1,
          )
        ).status,
        200,
      )
      assert.equal(
        (
          await request(
            base + `/${id}/delegations`,
            'PUT',
            { service: 'web', repositories: ['org/private'] },
            1,
          )
        ).status,
        403,
      )
      assert.equal(
        (
          await request(
            `/admin/git-connections/${id}`,
            'PUT',
            { revoked: true },
            1,
          )
        ).status,
        403,
      )
      const updated = await request(`/admin/users/${ids[1]}`, 'PUT', {
        disabled: false,
        capabilities: ['git.create'],
      })
      assert.equal(updated.status, 200)
      assert.equal((await request(base, 'POST', personal, 1)).status, 201)
      assert.equal(
        (await request(base, 'POST', { ...personal, scope: 'shared' }, 1))
          .status,
        403,
      )
      assert.equal(
        (
          await request(
            '/projects/elsewhere/git-connections',
            'POST',
            personal,
            1,
          )
        ).status,
        404,
      )
      assert.equal((await request(base, 'POST', personal, 3)).status, 403)
      await request(`/admin/users/${ids[1]}`, 'PUT', {
        disabled: false,
        capabilities: [],
      })
      assert.equal((await request(base, 'POST', personal, 1)).status, 403)
      assert.equal(
        (
          await request(`/admin/git-connections/${id}`, 'PUT', {
            name: 'Renamed',
            project_access: false,
          })
        ).status,
        200,
      )
      const restricted = await (
        await request(base + '?service=web', 'GET', undefined, 1)
      ).json()
      assert.equal(
        restricted.some((row: any) => row.id === id),
        false,
      )
      assert.equal(
        (
          await request(
            base + `/${id}/repository`,
            'POST',
            { service: 'web', url: 'https://github.com/org/private' },
            1,
          )
        ).status,
        403,
      )
      const listing = await (await request('/admin/git-connections')).json()
      assert.equal(JSON.stringify(listing).includes('prepared-secret'), false)
      assert.equal(
        listing.some((row: any) => 'encrypted_credentials' in row),
        false,
      )
      assert.equal(
        (
          await request(
            `/admin/git-connections/${id}`,
            'PUT',
            { revoked: true },
            2,
          )
        ).status,
        200,
      )
      assert.equal(
        (
          await pool.query('SELECT revoked FROM git_connections WHERE id=$1', [
            id,
          ])
        ).rows[0].revoked,
        true,
      )
    } finally {
      globalThis.fetch = originalFetch
      await pool.end()
      await root.query(`DROP SCHEMA ${schema} CASCADE`)
      await root.end()
    }
  },
)
