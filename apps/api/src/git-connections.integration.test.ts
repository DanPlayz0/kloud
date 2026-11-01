import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'Git PAT direct URL needs no listing permission; encrypted ownership, repository delegation and revocation remain enforced',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
    const schema = `git_${randomUUID().replaceAll('-', '')}`
    await db.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    process.env.PLATFORM_ENCRYPTION_KEY = 'ac'.repeat(32)
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { digest, token, publicOrigin } = await import('./security.js')
    const { validateGitSource, resolveGitSource } =
      await import('./git-connections.js')
    const admin = randomUUID(),
      owner = randomUUID(),
      teammate = randomUUID(),
      sessions = [token(), token(), token()]
    const project = 'demo',
      service = 'web',
      base = '/projects/demo/git-connections'
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = async (input, options) => {
      const url = String(input)
      requests.push(url)
      assert.equal(
        (options?.headers as Record<string, string>).authorization,
        'Bearer private-pat',
      )
      if (/\/repos\/org\/private\/branches/.test(url))
        return new Response(
          JSON.stringify([{ name: 'main', commit: { sha: 'a'.repeat(40) } }]),
        )
      if (url === 'https://api.github.com/repos/org/private')
        return new Response(
          JSON.stringify({
            id: 99,
            full_name: 'org/private',
            default_branch: 'main',
            private: true,
          }),
        )
      if (url === 'https://api.github.com/repos/org/other')
        return new Response(
          JSON.stringify({
            id: 100,
            full_name: 'org/other',
            default_branch: 'main',
            private: true,
          }),
        )
      return new Response('{}', { status: 403 })
    }
    const request = (path: string, method = 'GET', body?: unknown, actor = 1) =>
      app.request(base + path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: `session=${sessions[actor]}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    try {
      await migrate()
      await pool.query(
        "INSERT INTO users(id,username,admin) VALUES($1,'admin',true),($2,'owner',false),($3,'teammate',false)",
        [admin, owner, teammate],
      )
      for (const [i, id] of [admin, owner, teammate].entries())
        await pool.query(
          "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
          [digest(sessions[i]!), id],
        )
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('demo','Demo'); INSERT INTO services(project_slug,slug,name,type) VALUES('demo','web','Web','application')",
      )
      for (const id of [owner, teammate]) {
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
          await request('', 'POST', {
            name: 'Shared',
            provider: 'github',
            scope: 'shared',
            service,
            token: 'private-pat',
          })
        ).status,
        403,
      )
      const created = await request('', 'POST', {
        name: 'Organization PAT',
        provider: 'github',
        scope: 'personal',
        service,
        token: 'private-pat',
      })
      assert.equal(created.status, 201, await created.clone().text())
      const id = ((await created.json()) as any).id
      assert.equal(
        requests.length,
        0,
        'creating PAT connection requires no /user or repository listing',
      )
      const encrypted = (
        await pool.query(
          'SELECT encrypted_credentials FROM git_connections WHERE id=$1',
          [id],
        )
      ).rows[0].encrypted_credentials
      assert.ok(!encrypted.includes('private-pat'))
      const repo = await request(`/${id}/repository`, 'POST', {
        service,
        url: 'https://github.com/org/private',
      })
      assert.equal(repo.status, 200, await repo.clone().text())
      assert.ok(!requests.some((url) => url.includes('/user/repos')))
      assert.equal(
        (
          await request(
            `/${id}/repository`,
            'POST',
            { service, url: 'https://github.com/org/private' },
            2,
          )
        ).status,
        403,
      )
      const actor = {
        id: owner,
        username: 'owner',
        admin: false,
        capabilities: [],
      }
      const host = randomUUID()
      await pool.query(
        "INSERT INTO connectors(id,name,token) VALUES($1,'Host',$2)",
        [host, digest(token())],
      )
      const legacy = { repository: 'org/private', connector_id: host } as any
      await assert.rejects(
        validateGitSource(pool, actor, project, service, legacy),
        /administrator/,
      )
      await validateGitSource(
        pool,
        { id: admin, username: 'admin', admin: true, capabilities: [] },
        project,
        service,
        legacy,
      )
      await validateGitSource(pool, actor, project, service, legacy)
      assert.equal(
        await resolveGitSource(pool, project, service, legacy),
        undefined,
      )
      const config = {
        connection_id: id,
        repository_id: '99',
        provider_url: 'https://github.com',
        repository: 'org/private',
      } as any
      await validateGitSource(pool, actor, project, service, config)
      assert.deepEqual(await resolveGitSource(pool, project, service, config), {
        token: 'private-pat',
        url: 'https://github.com/org/private.git',
        username: undefined,
      })
      await assert.rejects(
        validateGitSource(pool, actor, project, service, legacy),
        /administrator/,
      )
      await assert.rejects(
        resolveGitSource(pool, project, service, legacy),
        /Legacy source authorization was removed/,
      )
      const delegated = await request(
        `/${id}/repository`,
        'POST',
        { service, url: 'https://github.com/org/private' },
        2,
      )
      assert.equal(delegated.status, 200)
      assert.equal(
        (
          await request(
            `/${id}/repository`,
            'POST',
            { service, url: 'https://github.com/org/other' },
            2,
          )
        ).status,
        403,
      )
      const listed = await (
        await request('?service=web', 'GET', undefined, 2)
      ).text()
      assert.ok(!listed.includes('private-pat'))
      assert.ok(!listed.includes('encrypted_credentials'))
      const registryRequest = (
        path: string,
        method = 'GET',
        body?: unknown,
        actor = 1,
      ) =>
        app.request('/projects/demo/registry-connections' + path, {
          method,
          headers: {
            origin: publicOrigin,
            cookie: `session=${sessions[actor]}`,
            'content-type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      const { resolveRegistryInputs, validateRegistryInputs } =
        await import('./registry-connections.js')
      const registryCreated = await registryRequest('', 'POST', {
        name: 'Private registry',
        server: 'registry.example',
        username: 'user',
        password: 'registry-password',
        scope: 'personal',
        service,
      })
      assert.equal(
        registryCreated.status,
        201,
        await registryCreated.clone().text(),
      )
      const registryId = ((await registryCreated.json()) as any).id
      const inputs = {
        secrets: {},
        registries: [],
        registry_connection_ids: [registryId],
      }
      await validateRegistryInputs(
        pool,
        { id: teammate, username: 'teammate', admin: false, capabilities: [] },
        project,
        service,
        inputs,
      )
      assert.deepEqual(
        (await resolveRegistryInputs(pool, project, service, inputs))
          ?.registries,
        [
          {
            server: 'registry.example',
            username: 'user',
            password: 'registry-password',
          },
        ],
      )
      assert.ok(
        !(
          await (
            await registryRequest('?service=web', 'GET', undefined, 2)
          ).text()
        ).includes('registry-password'),
      )
      assert.equal(
        (await registryRequest(`/${registryId}`, 'DELETE', undefined, 2))
          .status,
        403,
      )
      assert.equal(
        (
          await registryRequest(`/${registryId}/delegation`, 'PUT', {
            service,
            enabled: false,
          })
        ).status,
        200,
      )
      await assert.rejects(
        resolveRegistryInputs(pool, project, service, inputs),
        /delegation was revoked/,
      )
      assert.equal(
        (await registryRequest(`/${registryId}`, 'DELETE')).status,
        200,
      )
      await pool.query(
        'DELETE FROM memberships WHERE user_id=$1 AND project_slug=$2',
        [owner, project],
      )
      await assert.rejects(
        resolveGitSource(pool, project, service, config),
        /personal connection owner/,
      )
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'demo','member')",
        [owner],
      )
      assert.equal((await request(`/${id}`, 'DELETE')).status, 200)
      await assert.rejects(
        resolveGitSource(pool, project, service, config),
        /revoked/,
      )
    } finally {
      globalThis.fetch = originalFetch
      await pool.end()
      await db.query(`DROP SCHEMA ${schema} CASCADE`)
      await db.end()
    }
  },
)
