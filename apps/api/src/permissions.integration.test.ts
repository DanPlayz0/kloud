import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { setTimeout as delay } from 'node:timers/promises'

test(
  'granular permissions, migration and concurrency integration',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = `permissions_${randomUUID().replaceAll('-', '')}`
    await database.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    url.searchParams.set('application_name', schema)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate, migration } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { digest, token, publicOrigin } = await import('./security.js')
    const { acceptSnapshot } = await import('./connectors.js')
    const admin = randomUUID(),
      projectAdmin = randomUUID(),
      member = randomUUID(),
      other = randomUUID()
    const connector = randomUUID(),
      secondConnector = randomUUID()
    const cookies = new Map<string, string>()
    async function account(
      id: string,
      name: string,
      isAdmin = false,
      capabilities: string[] = [],
    ) {
      await pool.query(
        'INSERT INTO users(id,username,admin,capabilities) VALUES($1,$2,$3,$4)',
        [id, name, isAdmin, capabilities],
      )
      const secret = token()
      await pool.query(
        `INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')`,
        [digest(secret), id],
      )
      cookies.set(id, `session=${secret}`)
      return id
    }
    const request = (
      actor: string,
      path: string,
      method = 'GET',
      body?: unknown,
    ) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          'content-type': 'application/json',
          cookie: cookies.get(actor) ?? '',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    async function status(
      actor: string,
      path: string,
      method: string,
      body: unknown,
      expected: number,
    ) {
      const response = await request(actor, path, method, body)
      assert.equal(
        response.status,
        expected,
        `${method} ${path}: ${await response.text()}`,
      )
    }
    const access = '/projects/alpha/access'
    const grant = (
      kind: string,
      target: string | null = null,
      capability = 'view',
      host = connector,
    ) => ({
      capability,
      kind,
      target,
      connector_id: kind === 'all' ? null : host,
    })
    const setGrants = (grants: unknown[]) =>
      status(
        projectAdmin,
        `${access}/members/${member}`,
        'PUT',
        { role: 'member', grants },
        200,
      )
    const containers = async (actor = member, project = 'alpha') => {
      const response = await request(actor, `/projects/${project}/containers`)
      assert.equal(response.status, 200)
      return response.json() as Promise<any[]>
    }
    const raw = {
      id: 'a'.repeat(64),
      name: 'web',
      state: 'running',
      project: 'alpha',
      application: 'web',
      cpu: 1,
      memory: 10,
      memoryLimit: 20,
    }
    const snapshot = (items: any[]) => ({
      version: 1,
      type: 'snapshot',
      host: 'host',
      containers: items,
    })
    try {
      // Exercise the actual upgrade path, including a membership predating grants.
      await pool.query(migration)
      await pool.query(
        `CREATE TABLE migrations(version integer PRIMARY KEY,applied timestamptz NOT NULL DEFAULT now()); INSERT INTO migrations(version) VALUES(1)`,
      )
      await pool.query(
        "INSERT INTO users(id,username,admin) VALUES($1,'legacy',false)",
        [member],
      )
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('alpha','Alpha'),('beta','Beta')",
      )
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug) VALUES($1,'alpha')",
        [member],
      )
      await migrate()
      // Simulate an existing manager upgrading from migration 3.
      await pool.query(
        "UPDATE users SET capabilities=ARRAY['projects.manage'] WHERE id=$1",
        [member],
      )
      await pool.query('DELETE FROM migrations WHERE version=4')
      await migrate()
      await migrate()
      assert.deepEqual(
        (
          await pool.query('SELECT capabilities FROM users WHERE id=$1', [
            member,
          ])
        ).rows[0].capabilities,
        ['projects.manage', 'projects.create'],
      )
      assert.deepEqual(
        (
          await pool.query(
            'SELECT capability,kind FROM container_grants WHERE user_id=$1',
            [member],
          )
        ).rows,
        [{ capability: 'view', kind: 'all' }],
      )
      assert.equal(
        (await pool.query("SELECT grant_mode FROM projects WHERE slug='alpha'"))
          .rows[0].grant_mode,
        'id',
      )
      await pool.query('DELETE FROM users WHERE id=$1', [member])
      await account(admin, 'server-admin', true)
      await account(projectAdmin, 'project-admin')
      await account(member, 'member')
      await account(other, 'other')
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'alpha','admin'),($2,'alpha','member'),($3,'beta','member')",
        [projectAdmin, member, other],
      )
      for (const id of [connector, secondConnector])
        await pool.query(
          'INSERT INTO connectors(id,name,token,discovery) VALUES($1,$2,$3,true)',
          [id, id, digest(token())],
        )
      await acceptSnapshot(
        connector,
        snapshot([
          raw,
          {
            ...raw,
            id: 'b'.repeat(64),
            name: 'private',
            application: 'private',
          },
        ]),
      )

      await t.test(
        'membership alone reveals no containers or applications; project admins bypass grants',
        async () => {
          assert.equal((await containers()).length, 0)
          assert.equal((await containers(projectAdmin)).length, 2)
          await status(
            member,
            '/projects/alpha/applications/private',
            'GET',
            undefined,
            404,
          )
          await status(
            other,
            '/projects/alpha/containers',
            'GET',
            undefined,
            404,
          )
          await status(member, access, 'GET', undefined, 403)
          await status(
            projectAdmin,
            '/admin/projects/alpha',
            'PUT',
            { name: 'No' },
            403,
          )
          await status(projectAdmin, '/admin/containers', 'GET', undefined, 403)
          await status(projectAdmin, '/admin/users', 'GET', undefined, 403)
        },
      )
      await t.test(
        'ID and name grants filter applications, survive snapshots and stay scoped',
        async () => {
          await setGrants([grant('id', raw.id)])
          assert.deepEqual(
            (await containers()).map((c) => c.container_id),
            [raw.id],
          )
          await status(
            member,
            '/projects/alpha/applications/web',
            'GET',
            undefined,
            200,
          )
          await status(
            member,
            '/projects/alpha/applications/private',
            'GET',
            undefined,
            404,
          )
          const recreated = { ...raw, id: 'c'.repeat(64) }
          await acceptSnapshot(connector, snapshot([recreated]))
          assert.equal((await containers()).length, 0)
          await setGrants([grant('name', 'web', 'logs')])
          assert.equal((await containers()).length, 1)
          const saved = (await (
            await request(projectAdmin, access)
          ).json()) as any
          assert.deepEqual(
            saved.members
              .find((m: any) => m.id === member)
              .grants.map((g: any) => g.capability),
            ['logs', 'view'],
          )
          await status(
            projectAdmin,
            `${access}/settings`,
            'PUT',
            { grant_mode: 'name' },
            200,
          )
          await status(
            projectAdmin,
            `${access}/settings`,
            'PUT',
            { grant_mode: 'id' },
            200,
          )
          assert.equal((await containers()).length, 1)
          await acceptSnapshot(
            secondConnector,
            snapshot([{ ...recreated, id: 'd'.repeat(64) }]),
          )
          assert.equal((await containers()).length, 1)
          await setGrants([
            grant('name', 'web'),
            grant('id', 'd'.repeat(64), 'view', secondConnector),
          ])
          assert.equal((await containers()).length, 2)
          await status(
            projectAdmin,
            `${access}/settings`,
            'PUT',
            { grant_mode: 'name' },
            200,
          )
          assert.equal((await containers()).length, 2)
          await setGrants([grant('name', 'web')])
          await acceptSnapshot(
            connector,
            snapshot([{ ...recreated, project: 'beta' }]),
          )
          assert.equal((await containers()).length, 0)
          await status(
            member,
            '/projects/beta/containers',
            'GET',
            undefined,
            404,
          )
          await acceptSnapshot(
            connector,
            snapshot([{ ...recreated, name: 'Web' }]),
          )
          assert.equal((await containers()).length, 0)
          await setGrants([grant('all')])
          assert.equal((await containers()).length, 2)
          await acceptSnapshot(
            secondConnector,
            snapshot([
              { ...recreated, id: 'd'.repeat(64) },
              { ...recreated, id: 'f'.repeat(64), name: 'future-container' },
            ]),
          )
          assert.equal((await containers()).length, 3)
          await acceptSnapshot(
            secondConnector,
            snapshot([{ ...recreated, id: 'd'.repeat(64) }]),
          )
          await setGrants([])
          assert.equal((await containers()).length, 0)
        },
      )
      await t.test(
        'scoped invitations preserve existing accounts and other projects',
        async () => {
          await status(
            projectAdmin,
            `${access}/members`,
            'POST',
            { username: 'new-member', role: 'member', grants: [] },
            201,
          )
          const newUser = (
            await pool.query("SELECT id FROM users WHERE username='new-member'")
          ).rows[0]
          assert.equal(
            (
              await pool.query('SELECT 1 FROM invitations WHERE user_id=$1', [
                newUser.id,
              ])
            ).rowCount,
            1,
          )
          const result = await request(
            projectAdmin,
            `${access}/members`,
            'POST',
            { username: 'other', role: 'member', grants: [] },
          )
          assert.equal(result.status, 201)
          assert.equal(((await result.json()) as any).enrollmentUrl, undefined)
          assert.equal(
            (
              await pool.query('SELECT 1 FROM memberships WHERE user_id=$1', [
                other,
              ])
            ).rowCount,
            2,
          )
          await status(
            projectAdmin,
            `${access}/members`,
            'POST',
            { username: 'escalate', role: 'member', grants: [], admin: true },
            400,
          )
          await status(
            projectAdmin,
            '/projects/beta/access/members',
            'POST',
            { username: 'new-member', role: 'admin', grants: [] },
            404,
          )
          await status(
            projectAdmin,
            `${access}/members/${member}`,
            'PUT',
            { role: 'admin', grants: [] },
            200,
          )
          await status(
            member,
            `${access}/members/${projectAdmin}`,
            'PUT',
            { role: 'member', grants: [] },
            200,
          )
          await status(
            projectAdmin,
            `${access}/settings`,
            'PUT',
            { grant_mode: 'name' },
            403,
          )
          await status(
            member,
            `${access}/members/${projectAdmin}`,
            'PUT',
            { role: 'admin', grants: [] },
            200,
          )
          await status(
            projectAdmin,
            `${access}/members/${member}`,
            'PUT',
            { role: 'member', grants: [grant('all')] },
            200,
          )
          await status(
            projectAdmin,
            `${access}/members/${member}`,
            'DELETE',
            undefined,
            200,
          )
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM container_grants WHERE user_id=$1',
                [member],
              )
            ).rowCount,
            0,
          )
          await status(
            member,
            '/projects/alpha/containers',
            'GET',
            undefined,
            404,
          )
        },
      )
      await t.test(
        'project creation grants access only to the new project',
        async () => {
          const creator = await account(randomUUID(), 'creator', false, [
            'projects.create',
          ])
          const manager = await account(randomUUID(), 'manager-only', false, [
            'projects.manage',
          ])
          for (const actor of [manager, projectAdmin, member, other]) {
            await status(
              actor,
              '/admin/projects',
              'POST',
              { slug: 'forbidden-create', name: 'Forbidden' },
              403,
            )
          }
          await status(creator, '/admin/projects', 'GET', undefined, 403)
          await status(
            creator,
            '/admin/projects',
            'POST',
            { slug: 'creator-project', name: 'Creator project' },
            201,
          )
          await status(
            creator,
            '/projects/creator-project/containers',
            'GET',
            undefined,
            200,
          )
          await status(
            creator,
            '/projects/creator-project/access',
            'GET',
            undefined,
            200,
          )
          await status(creator, '/projects/beta/access', 'GET', undefined, 404)
          await status(
            creator,
            '/admin/projects/alpha',
            'PUT',
            { name: 'Forbidden' },
            403,
          )
          await status(
            creator,
            '/admin/projects/alpha',
            'DELETE',
            undefined,
            403,
          )
          await status(
            creator,
            '/admin/projects',
            'POST',
            { slug: 'creator-project', name: 'Duplicate' },
            409,
          )
          const visible = (await (
            await request(creator, '/projects')
          ).json()) as any[]
          assert.deepEqual(
            visible.map((p) => [p.slug, p.role, p.can_manage_access]),
            [['creator-project', 'admin', true]],
          )
          assert.equal(
            (
              await pool.query('SELECT 1 FROM memberships WHERE user_id=$1', [
                creator,
              ])
            ).rowCount,
            1,
          )
          await status(
            admin,
            `/admin/users/${creator}`,
            'PUT',
            {
              disabled: false,
              capabilities: [
                'users.manage',
                'projects.create',
                'projects.manage',
                'connectors.manage',
                'inventory.manage',
              ],
            },
            200,
          )
          await pool.query("DELETE FROM projects WHERE slug='creator-project'")
          await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [
            [creator, manager],
          ])
        },
      )

      await t.test(
        'server capabilities authorize only their own domains',
        async () => {
          for (const [capability, path] of [
            ['users.manage', 'users'],
            ['projects.manage', 'projects'],
            ['connectors.manage', 'connectors'],
            ['inventory.manage', 'containers'],
          ]) {
            const id = await account(randomUUID(), path!, false, [capability!])
            for (const endpoint of [
              'users',
              'projects',
              'connectors',
              'containers',
            ])
              await status(
                id,
                `/admin/${endpoint}`,
                'GET',
                undefined,
                endpoint === path ? 200 : 403,
              )
            if (capability === 'projects.manage') {
              assert.equal((await containers(id)).length, 2)
              await status(id, access, 'GET', undefined, 200)
              await status(
                id,
                '/admin/projects/alpha',
                'PUT',
                { name: 'Renamed' },
                200,
              )
            } else
              await status(
                id,
                '/projects/alpha/containers',
                'GET',
                undefined,
                404,
              )
            await status(
              id,
              '/admin/users',
              'POST',
              { username: `attempt-${path}`, admin: true },
              403,
            )
            if (capability === 'users.manage') {
              await status(
                id,
                `/admin/users/${admin}`,
                'PUT',
                { disabled: true },
                403,
              )
              await status(
                id,
                `/admin/users/${admin}/enrollment`,
                'POST',
                {},
                403,
              )
              await status(
                id,
                `/admin/users/${id}`,
                'PUT',
                { disabled: false, capabilities: [] },
                403,
              )
              await status(
                id,
                '/admin/users',
                'POST',
                { username: 'ordinary' },
                201,
              )
              await status(
                id,
                `/admin/users/${other}`,
                'PUT',
                { disabled: false, projects: [] },
                403,
              )
            }
            if (capability === 'inventory.manage') {
              await status(
                id,
                '/admin/containers/projects',
                'GET',
                undefined,
                200,
              )
              await status(
                id,
                `/admin/containers/${connector}/${'c'.repeat(64)}`,
                'PUT',
                { project: 'beta', application: 'moved' },
                409,
              )
              await acceptSnapshot(
                connector,
                snapshot([
                  { ...raw, id: 'c'.repeat(64), name: 'Web' },
                  {
                    ...raw,
                    id: 'e'.repeat(64),
                    project: null,
                    application: null,
                  },
                ]),
              )
              await status(
                id,
                `/admin/containers/${connector}/${'e'.repeat(64)}`,
                'PUT',
                { project: 'beta', application: 'manual' },
                200,
              )
              await status(
                id,
                `/admin/containers/${connector}/${'e'.repeat(64)}`,
                'PUT',
                null,
                200,
              )
            }
            if (capability === 'connectors.manage')
              await status(
                id,
                '/admin/connectors',
                'POST',
                { name: 'delegated' },
                201,
              )
            await status(
              admin,
              `/admin/users/${id}`,
              'PUT',
              { disabled: false, capabilities: [] },
              200,
            )
            await status(id, `/admin/${path}`, 'GET', undefined, 403)
          }
        },
      )
      await t.test(
        'queued mutations cannot retain revoked project authority',
        async () => {
          await status(
            projectAdmin,
            `${access}/members`,
            'POST',
            { username: 'member', role: 'admin', grants: [] },
            201,
          )
          const blocker = await pool.connect()
          let revocation: Promise<Response> | undefined,
            stale: Promise<Response> | undefined
          async function waitForQueued(count: number) {
            for (let attempt = 0; attempt < 200; attempt++) {
              const result = await pool.query(
                `SELECT count(*)::integer AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
              WHERE l.locktype='advisory' AND l.objid=842193 AND NOT l.granted AND a.application_name=$1`,
                [schema],
              )
              if (result.rows[0].count >= count) return
              await delay(10)
            }
            throw new Error('Permission mutation did not queue')
          }
          try {
            await blocker.query('BEGIN')
            await blocker.query('SELECT pg_advisory_xact_lock(842193)')
            revocation = request(
              admin,
              `${access}/members/${projectAdmin}`,
              'PUT',
              { role: 'member', grants: [] },
            )
            await waitForQueued(1)
            stale = request(projectAdmin, `${access}/settings`, 'PUT', {
              grant_mode: 'name',
            })
            await waitForQueued(2)
            await blocker.query('COMMIT')
          } finally {
            await blocker.query('ROLLBACK')
            blocker.release()
          }
          assert.equal((await revocation!).status, 200)
          assert.equal((await stale!).status, 403)
          await status(
            admin,
            `${access}/members/${projectAdmin}`,
            'PUT',
            { role: 'admin', grants: [] },
            200,
          )
          await status(
            projectAdmin,
            `${access}/members/${member}`,
            'DELETE',
            undefined,
            200,
          )
        },
      )
      await t.test(
        'last active administrators are protected, including concurrent updates',
        async () => {
          await status(
            admin,
            `/admin/users/${admin}`,
            'PUT',
            { disabled: false, admin: false },
            409,
          )
          await status(
            admin,
            `/admin/users/${projectAdmin}`,
            'PUT',
            { disabled: true },
            409,
          )
          await status(
            projectAdmin,
            `${access}/members/${projectAdmin}`,
            'DELETE',
            undefined,
            409,
          )
          await status(
            projectAdmin,
            `${access}/members/${projectAdmin}`,
            'PUT',
            { role: 'member', grants: [] },
            409,
          )
          await status(
            projectAdmin,
            `${access}/members`,
            'POST',
            { username: 'member', role: 'admin', grants: [] },
            201,
          )
          const results = await Promise.all(
            [projectAdmin, member].map((id) =>
              request(id, `${access}/members/${id}`, 'PUT', {
                role: 'member',
                grants: [],
              }),
            ),
          )
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
          const secondAdmin = await account(randomUUID(), 'second-admin', true)
          const serverResults = await Promise.all(
            [admin, secondAdmin].map((id) =>
              request(id, `/admin/users/${id}`, 'PUT', {
                disabled: false,
                admin: false,
              }),
            ),
          )
          assert.deepEqual(
            serverResults.map((r) => r.status).sort(),
            [200, 409],
          )
          const remaining = (
            await pool.query('SELECT id FROM users WHERE admin')
          ).rows[0].id
          await status(
            remaining,
            '/admin/projects/alpha',
            'DELETE',
            undefined,
            200,
          )
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM container_grants WHERE project_slug='alpha'",
              )
            ).rowCount,
            0,
          )
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM memberships WHERE project_slug='alpha'",
              )
            ).rowCount,
            0,
          )
        },
      )
      await t.test(
        'OpenAPI exposes new interfaces and planned capabilities',
        async () => {
          const remaining = (
            await pool.query('SELECT id FROM users WHERE admin')
          ).rows[0].id
          const response = await request(remaining, '/openapi.json')
          assert.equal(response.status, 200)
          const document = (await response.json()) as any
          assert.ok(
            document.paths['/projects/{project}/access/members/{id}'].delete,
          )
          assert.ok(document.paths['/admin/projects/{project}'].delete)
        },
      )
    } finally {
      await pool.end()
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      await database.end()
    }
  },
)
