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
      wrongApp = false,
      optionalSecretsAbsent = false,
      missingKey = false
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
          ...(!missingKey ? { pem } : {}),
          ...(!optionalSecretsAbsent
            ? { client_id: 'client', client_secret: 'secret-client' }
            : {}),
          webhook_secret: optionalSecretsAbsent ? null : 'secret-hook',
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
      await pool.query(
        "UPDATE users SET capabilities=ARRAY['git.create'] WHERE id=ANY($1::uuid[])",
        [[actor, other]],
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
      assert.equal(
        started.manifest.redirect_url,
        `${publicOrigin}/api/git/github/manifest`,
      )
      assert.equal(
        started.manifest.setup_url,
        `${publicOrigin}/api/git/github/setup`,
      )
      assert.equal(
        started.manifest.callback_urls,
        undefined,
        'installation authentication does not register an unused user OAuth callback',
      )
      assert.equal(started.manifest.default_permissions.contents, 'read')
      assert.equal(
        started.manifest.default_permissions.repository_hooks,
        'write',
      )
      assert.equal(
        (await request('/start', { service: 'web', name: 'x'.repeat(35) }))
          .status,
        400,
        'GitHub limits App names to 34 characters',
      )
      const callbackPath = `/git/github/manifest?state=${started.state}&code=manifest-code`
      assert.equal(
        (await request('/status', { service: 'web', state: started.state }, 1))
          .status,
        403,
      )
      assert.equal(
        (
          await app.request(
            `/git/github/setup?state=${started.state}&installation_id=456&setup_action=install`,
          )
        ).status,
        403,
      )
      const relayed = await app.request(
        callbackPath + '&opener_origin=https://evil.example',
      )
      assert.equal(relayed.status, 200)
      assert.match(
        relayed.headers.get('content-security-policy')!,
        /frame-ancestors 'none'/,
      )
      assert.equal(relayed.headers.get('referrer-policy'), 'no-referrer')
      const relayHtml = await relayed.text()
      assert.ok(relayHtml.includes(JSON.stringify(publicOrigin)))
      assert.ok(
        !relayHtml.includes('evil.example'),
        'relay authority comes from stored state, never query parameters',
      )
      assert.equal(
        (await app.request(callbackPath)).status,
        200,
        'identical callback reload is idempotent',
      )
      assert.equal(
        (
          await app.request(
            `/git/github/manifest?state=${started.state}&code=different-code`,
          )
        ).status,
        409,
      )
      assert.equal(
        (await app.request(callbackPath + '&installation_id=456')).status,
        400,
      )
      const receipt = await (
        await request('/status', { service: 'web', state: started.state })
      ).json()
      assert.deepEqual(receipt.callback, {
        phase: 'manifest',
        code: 'manifest-code',
      })
      const encryptedReceipt = (
        await pool.query(
          'SELECT callback_payload FROM github_app_setups WHERE state=$1',
          [digest(started.state)],
        )
      ).rows[0].callback_payload
      assert.equal(encryptedReceipt.includes('manifest-code'), false)
      assert.equal(
        calls,
        0,
        'the unauthenticated relay never exchanges provider credentials',
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
      assert.equal(
        (await request('/status', { service: 'web', state: started.state }))
          .status,
        403,
      )
      assert.equal((await app.request(callbackPath)).status, 403)
      const stored = (await pool.query('SELECT * FROM github_app_setups'))
        .rows[0]
      assert.notEqual(stored.state, install.state)
      assert.equal(stored.encrypted_credentials.includes('PRIVATE KEY'), false)
      assert.equal(
        stored.callback_payload,
        null,
        'a rotated phase cannot replay the creation callback',
      )
      const installPath = `/git/github/setup?state=${install.state}&installation_id=456&setup_action=install`
      const installCallback = await app.request(installPath)
      assert.equal(installCallback.status, 200)
      assert.deepEqual(
        (
          await (
            await request('/status', { service: 'web', state: install.state })
          ).json()
        ).callback,
        { phase: 'install', installation_id: 456, setup_action: 'install' },
      )
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
      assert.equal(
        (await app.request(installPath)).status,
        403,
        'completed installation states cannot be replayed',
      )
      assert.equal(
        (await app.request('/git/github/manifest?state=bad&code=x')).status,
        400,
      )
      assert.equal(
        (await app.request(`/git/github/manifest?state=${token()}&code=x`))
          .status,
        403,
      )
      const denied = await (await start()).json()
      assert.equal(
        (
          await app.request(
            `/git/github/manifest?state=${denied.state}&error=access_denied&error_description=untrusted`,
          )
        ).status,
        200,
      )
      const denial = await (
        await request('/status', { service: 'web', state: denied.state })
      ).json()
      assert.match(denial.callback.error, /GitHub setup was denied/)
      assert.ok(!JSON.stringify(denial).includes('untrusted'))
      // The same complete manifest/install flow also works before any service exists.
      optionalSecretsAbsent = true
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('prepared','Prepared'); UPDATE users SET capabilities=ARRAY['git.create','git.manage'] WHERE username='owner'",
      )
      const prepare = (suffix: string, body: unknown) =>
        app.request('/projects/prepared/git-connections/github-app' + suffix, {
          method: 'POST',
          headers: {
            origin: publicOrigin,
            cookie: `session=${sessions[0]}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        })
      const beforeService = await prepare('/start', {
        name: 'Prepared App',
        scope: 'shared',
        project_access: true,
      })
      assert.equal(beforeService.status, 200)
      const preparation = await beforeService.json()
      const conversion = await prepare('/finish', {
        state: preparation.state,
        code: 'manifest-code',
      })
      assert.equal(conversion.status, 200)
      const installation = await conversion.json()
      const prepared = await prepare('/finish', {
        state: installation.state,
        installation_id: 456,
        setup_action: 'install',
      })
      assert.equal(prepared.status, 200)
      const preparedRow = (
        await pool.query(
          "SELECT owner,project_access FROM git_connections WHERE project='prepared'",
        )
      ).rows[0]
      assert.equal(preparedRow.owner, null)
      assert.equal(preparedRow.project_access, true)
      const preparedCredentials = unseal(
        (
          await pool.query(
            "SELECT encrypted_credentials FROM git_connections WHERE project='prepared'",
          )
        ).rows[0].encrypted_credentials,
      )
      assert.equal(preparedCredentials.private_key, pem)
      assert.equal(preparedCredentials.webhook_secret, null)
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM services WHERE project_slug='prepared'",
          )
        ).rowCount,
        0,
      )
      missingKey = true
      const invalidSetup = await (
        await prepare('/start', { name: 'Invalid App', scope: 'shared' })
      ).json()
      const invalidConversion = await prepare('/finish', {
        state: invalidSetup.state,
        code: 'manifest-code',
      })
      assert.equal(invalidConversion.status, 502)
      const invalidMessage = await invalidConversion.json()
      assert.match(invalidMessage.error, /incomplete app configuration \(pem\)/)
      assert.equal(
        JSON.stringify(invalidMessage).includes('PRIVATE KEY'),
        false,
      )
      const invalidRequest = await prepare('/finish', {
        state: 'invalid',
        code: 'manifest-code',
      })
      assert.equal(invalidRequest.status, 400)
      assert.match(
        (await invalidRequest.json()).error,
        /Invalid GitHub setup request: state/,
      )
    } finally {
      globalThis.fetch = originalFetch
      await pool.end()
      await root.query(`DROP SCHEMA ${schema} CASCADE`)
      await root.end()
    }
  },
)
