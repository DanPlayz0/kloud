import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'saved Git and registry identities cross team/project boundaries without bypassing app or credential permissions',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = `git_sharing_${randomUUID().replaceAll('-', '')}`
    await root.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    process.env.PLATFORM_ENCRYPTION_KEY = 'ac'.repeat(32)
    const { pool } = await import('./db.js'),
      { migrate } = await import('./migrate.js'),
      { app } = await import('./app.js'),
      { digest, token, publicOrigin } = await import('./security.js')
    const { validateGitSource, resolveGitSource } =
      await import('./git-connections.js')
    const { validateRegistryInputs, resolveRegistryInputs } =
      await import('./registry-connections.js')
    const admin = randomUUID(),
      member = randomUUID(),
      owner = randomUUID()
    const sessions = [token(), token(), token()]
    const actors = [admin, member, owner]
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      Response.json({
        id: 991,
        full_name: 'org/private',
        default_branch: 'main',
        private: true,
      })
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
    const source = (connection_id: string) => ({
      connection_id,
      repository_id: '991',
      provider_url: 'https://github.com',
      repository: 'org/private',
      branch: 'main',
      connector_id: randomUUID(),
      container_name: 'web',
      kind: 'dockerfile' as const,
      build_file: 'Dockerfile',
      context: '.',
      service: 'app',
      enabled: true,
    })
    const actor = (index: number) => ({
      id: actors[index]!,
      username: 'test',
      admin: index === 0,
      capabilities: index === 2 ? ['git.create' as const] : [],
    })
    try {
      await migrate()
      await migrate()
      await pool.query(
        "INSERT INTO users(id,username,admin,capabilities) VALUES($1,'admin',true,'{}'),($2,'member',false,'{}'),($3,'owner',false,ARRAY['git.create'])",
        [admin, member, owner],
      )
      for (let i = 0; i < 3; i++)
        await pool.query(
          "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
          [digest(sessions[i]!), actors[i]],
        )
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('alpha','Alpha'),('beta','Beta'),('gamma','Gamma')",
      )
      await pool.query(
        "INSERT INTO services(project_slug,slug,name,type) SELECT slug,'web','Web','application' FROM projects",
      )
      for (const user of [member, owner])
        for (const project of ['alpha', 'beta', 'gamma']) {
          await pool.query(
            "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,$2,'member')",
            [user, project],
          )
          await pool.query(
            "INSERT INTO service_grants(user_id,project_slug,capability,service) VALUES($1,$2,'deploy','web')",
            [user, project],
          )
        }
      const created = await request('/projects/alpha/git-connections', 'POST', {
        name: 'Reusable App credential',
        provider: 'github',
        scope: 'shared',
        token: 'shared-secret',
        available_projects: ['alpha', 'beta'],
      })
      assert.equal(created.status, 201, await created.clone().text())
      const { id } = (await created.json()) as any
      const list = async (project: string, index = 1) =>
        (await (
          await request(
            `/projects/${project}/git-connections?service=web`,
            'GET',
            undefined,
            index,
          )
        ).json()) as any[]
      assert.ok((await list('beta')).some((row) => row.id === id))
      assert.ok(!(await list('gamma')).some((row) => row.id === id))
      assert.equal(
        (
          await request(
            `/projects/gamma/git-connections/${id}/repository`,
            'POST',
            { service: 'web', url: 'https://github.com/org/private' },
            1,
          )
        ).status,
        403,
      )
      await validateGitSource(pool, actor(1), 'beta', 'web', source(id))
      assert.equal(
        (await resolveGitSource(pool, 'beta', 'web', source(id)))?.token,
        'shared-secret',
      )
      await pool.query(
        "DELETE FROM service_grants WHERE user_id=$1 AND project_slug='beta'",
        [member],
      )
      assert.equal(
        (
          await request(
            `/projects/beta/git-connections/${id}/repository`,
            'POST',
            { service: 'web', url: 'https://github.com/org/private' },
            1,
          )
        ).status,
        403,
      )
      await pool.query(
        "INSERT INTO service_grants(user_id,project_slug,capability,service) VALUES($1,'beta','deploy','web')",
        [member],
      )
      assert.equal(
        (
          await request(`/admin/git-connections/${id}`, 'PUT', {
            all_projects: true,
            available_projects: [],
          })
        ).status,
        200,
      )
      assert.ok((await list('gamma')).some((row) => row.id === id))
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('future','Future'); INSERT INTO services(project_slug,slug,name,type) VALUES('future','web','Web','application')",
      )
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'future','member');",
        [member],
      )
      await pool.query(
        "INSERT INTO service_grants(user_id,project_slug,capability,service) VALUES($1,'future','deploy','web')",
        [member],
      )
      assert.ok((await list('future')).some((row) => row.id === id))
      assert.equal(
        (
          await request(`/admin/git-connections/${id}`, 'PUT', {
            all_projects: false,
            available_projects: [],
          })
        ).status,
        200,
      )
      assert.ok(!(await list('gamma')).some((row) => row.id === id))
      assert.ok(
        (await list('beta')).some((row) => row.id === id),
        'explicit repository binding remains independently delegated',
      )
      assert.equal(
        (
          await request(
            '/projects/alpha/git-connections',
            'POST',
            {
              name: 'Escalation',
              provider: 'github',
              token: 'x',
              scope: 'personal',
              service: 'web',
              all_projects: true,
            },
            2,
          )
        ).status,
        403,
      )
      assert.equal(
        (
          await request(`/admin/git-connections/${id}`, 'PUT', {
            available_projects: ['missing'],
          })
        ).status,
        400,
      )
      const personal = await request(
        '/projects/alpha/git-connections',
        'POST',
        {
          name: 'Personal reusable',
          provider: 'github',
          scope: 'personal',
          service: 'web',
          token: 'owner-secret',
        },
        2,
      )
      assert.equal(personal.status, 201)
      const personalId = ((await personal.json()) as any).id
      await validateGitSource(pool, actor(2), 'beta', 'web', source(personalId))
      await pool.query(
        "INSERT INTO git_repository_bindings(connection,project,service,repository_id,repository) VALUES($1,'beta','web','991','org/private') ON CONFLICT DO NOTHING",
        [personalId],
      )
      await pool.query(
        "DELETE FROM memberships WHERE user_id=$1 AND project_slug='beta'",
        [owner],
      )
      await assert.rejects(() =>
        resolveGitSource(pool, 'beta', 'web', source(personalId)),
      )
      assert.ok(!(await list('beta')).some((row) => row.id === personalId))
      const registry = await request(
        '/projects/alpha/registry-connections',
        'POST',
        {
          name: 'Shared registry',
          server: 'registry.example',
          username: 'registry-user',
          password: 'registry-secret',
          scope: 'shared',
          service: 'web',
        },
      )
      assert.equal(registry.status, 201)
      const registryId = ((await registry.json()) as any).id
      const inputs = {
        secrets: {},
        registries: [],
        registry_connection_ids: [registryId],
      }
      await assert.rejects(() =>
        validateRegistryInputs(pool, actor(1), 'beta', 'web', inputs),
      )
      await validateRegistryInputs(pool, actor(0), 'beta', 'web', inputs)
      assert.equal(
        (await resolveRegistryInputs(pool, 'beta', 'web', inputs))
          ?.registries[0]?.password,
        'registry-secret',
      )
      await pool.query("DELETE FROM projects WHERE slug='alpha'")
      assert.equal(
        (
          await pool.query('SELECT project FROM git_connections WHERE id=$1', [
            id,
          ])
        ).rows[0].project,
        null,
      )
      assert.equal(
        (await resolveGitSource(pool, 'beta', 'web', source(id)))?.token,
        'shared-secret',
      )
      assert.equal(
        (await resolveRegistryInputs(pool, 'beta', 'web', inputs))
          ?.registries[0]?.password,
        'registry-secret',
      )
      const metadata = await (await request('/admin/git-connections')).text()
      assert.ok(metadata.includes(id))
      assert.ok(!metadata.includes('shared-secret'))
      assert.equal(
        (
          await request(`/admin/git-connections/${id}`, 'PUT', {
            revoked: true,
          })
        ).status,
        200,
      )
      await assert.rejects(() =>
        resolveGitSource(pool, 'beta', 'web', source(id)),
      )
    } finally {
      globalThis.fetch = originalFetch
      await pool.end()
      await root.query(`DROP SCHEMA ${schema} CASCADE`)
      await root.end()
    }
  },
)
