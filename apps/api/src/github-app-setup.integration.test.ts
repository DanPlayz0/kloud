import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'GitHub manifest setup binds both one-use phases to the actor, service, permissions and verified installation',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = `github_${randomUUID().replaceAll('-', '')}`
    await root.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    process.env.PLATFORM_ENCRYPTION_KEY = 'ac'.repeat(32)
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { token, digest, publicOrigin } = await import('./security.js')
    const { unseal } = await import('./platform-secrets.js')
    const actor = randomUUID(),
      other = randomUUID(),
      sessions = [token(), token()]
    const base = '/projects/demo/git-connections/github-app'
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString()
    const originalFetch = globalThis.fetch
    let calls = 0,
      wrongApp = false
    globalThis.fetch = async (input, options) => {
      calls++
      const target = String(input)
      if (target.endsWith('/app-manifests/manifest-code/conversions')) {
        assert.equal(
          (options?.headers as Record<string, string>).authorization,
          undefined,
        )
        return Response.json({
          id: 123,
          slug: 'kloud-test',
          pem,
          client_id: 'client',
          client_secret: 'secret-client',
          webhook_secret: 'secret-hook',
        })
      }
      assert.match(
        (options?.headers as Record<string, string>).authorization,
        /^Bearer ey/,
      )
      if (target.endsWith('/app/installations/456'))
        return Response.json({
          id: 456,
          app_id: wrongApp ? 999 : 123,
          account: { id: 1, login: 'owner' },
          suspended_at: null,
        })
      if (target.endsWith('/app/installations/456/access_tokens'))
        return Response.json({ token: 'installation-secret' })
      throw new Error(`Unexpected GitHub request: ${target}`)
    }
    const request = (
      suffix: string,
      body: unknown,
      who = 0,
      origin = publicOrigin,
    ) =>
      app.request(base + suffix, {
        method: 'POST',
        headers: {
          origin,
          cookie: `session=${sessions[who]}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    const start = () =>
      request('/start', {
        service: 'web',
        name: 'Kloud',
        organization: 'my-org',
      })
    try {
      await migrate()
      await pool.query(
        "INSERT INTO users(id,username) VALUES($1,'owner'),($2,'other')",
        [actor, other],
      )
      for (const [i, id] of [actor, other].entries()) {
        await pool.query(
          "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
          [digest(sessions[i]!), id],
        )
      }
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('demo','Demo'); INSERT INTO services(project_slug,slug,name,type) VALUES('demo','web','Web','application'),('demo','other','Other','application')",
      )
      for (const id of [actor, other]) {
        await pool.query(
          "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'demo','member')",
          [id],
        )
        await pool.query(
          "INSERT INTO service_grants(user_id,project_slug,capability,service) VALUES($1,'demo','deploy','web')",
          [id],
        )
      }
      assert.equal(
        (
          await app.request(base + '/start', {
            method: 'POST',
            headers: { origin: publicOrigin },
          })
        ).status,
        401,
      )
      assert.equal(
        (
          await request('/start', {
            service: 'web',
            name: 'Shared',
            scope: 'shared',
          })
        ).status,
        403,
      )
      assert.equal(
        (await request('/start', { service: 'other', name: 'Other' })).status,
        403,
      )
      assert.equal(
        (
          await request(
            '/start',
            { service: 'web', name: 'Bad' },
            0,
            'https://evil.example',
          )
        ).status,
        403,
      )
      const initial = await start()
      assert.equal(initial.status, 200)
      const started = await initial.json()
      assert.match(
        started.action,
        /^https:\/\/github.com\/organizations\/my-org\/settings\/apps\/new\?state=/,
      )
      assert.equal(started.manifest.request_oauth_on_install, false)
      assert.equal(started.manifest.default_permissions.contents, 'read')
      assert.equal(
        started.manifest.default_permissions.repository_hooks,
        'write',
      )
      const finish = {
        service: 'web',
        state: started.state,
        code: 'manifest-code',
      }
      assert.equal((await request('/finish', finish, 1)).status, 403)
      assert.equal(calls, 0)
      const converted = await request('/finish', finish)
      assert.equal(converted.status, 200)
      const install = await converted.json()
      assert.match(
        install.install_url,
        /^https:\/\/github.com\/apps\/kloud-test\/installations\/new\?state=/,
      )
      assert.notEqual(install.state, started.state)
      assert.equal(JSON.stringify(install).includes(pem), false)
      assert.equal((await request('/finish', finish)).status, 403)
      const stored = (await pool.query('SELECT * FROM github_app_setups'))
        .rows[0]
      assert.notEqual(stored.state, install.state)
      assert.equal(stored.encrypted_credentials.includes('PRIVATE KEY'), false)
      const completed = {
        service: 'web',
        state: install.state,
        installation_id: 456,
        setup_action: 'install',
      }
      wrongApp = true
      assert.equal((await request('/finish', completed)).status, 403)
      assert.equal(
        (await pool.query('SELECT * FROM git_connections')).rowCount,
        0,
      )
      wrongApp = false
      await pool.query('DELETE FROM service_grants WHERE user_id=$1', [actor])
      assert.equal((await request('/finish', completed)).status, 403)
      await pool.query(
        "INSERT INTO service_grants(user_id,project_slug,capability,service) VALUES($1,'demo','deploy','web')",
        [actor],
      )
      const saved = await request('/finish', completed)
      assert.equal(saved.status, 200)
      const { id } = await saved.json()
      const row = (
        await pool.query('SELECT * FROM git_connections WHERE id=$1', [id])
      ).rows[0]
      assert.equal(row.owner, actor)
      assert.equal(row.identity.account, 'owner')
      assert.equal(unseal(row.encrypted_credentials).private_key, pem)
      assert.equal(unseal(row.encrypted_credentials).installation_id, 456)
      assert.equal((await request('/finish', completed)).status, 403)
      const expired = await (await start()).json()
      await pool.query(
        "UPDATE github_app_setups SET expires=now()-interval '1 second'",
      )
      assert.equal(
        (await request('/finish', { ...finish, state: expired.state })).status,
        403,
      )
      const callback = await app.request(
        '/git/github/callback?opener_origin=' +
          encodeURIComponent(publicOrigin),
      )
      assert.equal(callback.status, 200)
      assert.match(
        callback.headers.get('content-security-policy')!,
        /frame-ancestors 'none'/,
      )
      assert.equal(
        (
          await app.request(
            '/git/github/callback?opener_origin=https://evil.example',
          )
        ).status,
        400,
      )
    } finally {
      globalThis.fetch = originalFetch
      await pool.end()
      await root.query(`DROP SCHEMA ${schema} CASCADE`)
      await root.end()
    }
  },
)
