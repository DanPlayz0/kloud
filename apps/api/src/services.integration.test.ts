import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'services: migration, scoped grants, deployment authority, initial deployments and revocation',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = `services_${randomUUID().replaceAll('-', '')}`
    await database.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { token, digest, publicOrigin } = await import('./security.js')
    const admin = randomUUID(),
      member = randomUUID(),
      outsider = randomUUID(),
      connector = randomUUID()
    const sessions = new Map<string, string>()
    async function request(
      actor: string,
      path: string,
      method = 'GET',
      body?: unknown,
    ) {
      return app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: `session=${sessions.get(actor)}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    }
    const base = '/projects/demo/services'
    const access = `/projects/demo/access/members/${member}`
    const deployment = '/projects/demo/applications/web/deployment'
    const grants = async (service_grants: unknown[]) => {
      const res = await request(admin, access, 'PUT', {
        role: 'member',
        grants: [],
        service_grants,
      })
      assert.equal(res.status, 200, await res.text())
    }
    try {
      await migrate()
      await migrate()
      for (const [id, name] of [
        [admin, 'admin'],
        [member, 'member'],
        [outsider, 'outsider'],
      ]) {
        await pool.query(
          'INSERT INTO users(id,username,admin) VALUES($1,$2,$3)',
          [id, name, id === admin],
        )
        const secret = token()
        sessions.set(id!, secret)
        await pool.query(
          "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
          [digest(secret), id],
        )
      }
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('demo','Demo'),('other','Other')",
      )
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug) VALUES($1,'demo')",
        [member],
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token) VALUES($1,'Host',$2)",
        [connector, digest(token())],
      )
      assert.equal((await request(outsider, base)).status, 404)
      assert.equal(
        (
          await request(member, base, 'POST', {
            slug: 'web',
            name: 'Web',
            type: 'application',
          })
        ).status,
        403,
      )
      assert.equal(
        (
          await request(admin, base, 'POST', {
            slug: 'web',
            name: 'Web',
            type: 'application',
          })
        ).status,
        201,
      )
      assert.equal(
        (
          await request(admin, base, 'POST', {
            slug: 'stack',
            name: 'Stack',
            type: 'compose',
          })
        ).status,
        201,
      )
      assert.deepEqual(
        ((await (await request(member, base)).json()) as any).services,
        [],
      )
      await grants([{ capability: 'read', service: 'web' }])
      let list = (await (await request(member, base)).json()) as any
      assert.deepEqual(
        list.services.map((s: any) => s.slug),
        ['web'],
      )
      assert.equal(list.services[0].can_deploy, false)
      assert.equal(
        (await request(member, `${base}/web`, 'PUT', { name: 'Changed' }))
          .status,
        403,
      )
      assert.equal((await request(member, deployment, 'POST')).status, 403)
      assert.equal(
        (await request(member, `${base}/web/connectors`)).status,
        403,
      )
      assert.equal(
        (
          await request(admin, access, 'PUT', {
            role: 'member',
            grants: [],
            service_grants: [{ capability: 'read', service: 'missing' }],
          })
        ).status,
        400,
      )
      await grants([{ capability: 'deploy', service: 'web' }])
      const config = {
        connector_id: connector,
        container_name: 'kloud-demo-web',
        managed: true,
        repository: 'owner/repo',
        branch: 'main',
        kind: 'dockerfile',
        build_file: 'Dockerfile',
        context: '.',
        service: 'app',
        enabled: true,
      }
      assert.equal(
        (
          await request(member, deployment, 'PUT', {
            ...config,
            container_name: 'stolen',
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await request(member, deployment, 'PUT', {
            ...config,
            kind: 'compose',
          })
        ).status,
        400,
      )
      const saved = await request(member, deployment, 'PUT', config)
      assert.equal(saved.status, 200, await saved.clone().text())
      const savedData = (await saved.json()) as any
      assert.ok(savedData.webhook_secret)
      assert.equal(
        (await request(member, deployment, 'POST', { commit: 'a'.repeat(40) }))
          .status,
        200,
      )
      assert.equal(
        (
          await request(
            member,
            '/projects/demo/applications/stack/deployment',
            'PUT',
            config,
          )
        ).status,
        403,
      )
      assert.equal((await request(member, `${base}/web`, 'DELETE')).status, 403)
      // Read access follows container replacement and stays inside this project and service.
      for (const [id, application] of [
        ['a', 'web'],
        ['b', 'stack'],
      ])
        await pool.query(
          'INSERT INTO inventory(connector_id,container_id,data) VALUES($1,$2,$3)',
          [
            connector,
            id!.repeat(64),
            { name: application, project: 'demo', application },
          ],
        )
      let containers = (await (
        await request(member, '/projects/demo/containers')
      ).json()) as any[]
      assert.deepEqual(
        containers.map((c) => c.application),
        ['web'],
      )
      await pool.query(
        'UPDATE inventory SET container_id=$1 WHERE container_id=$2',
        ['c'.repeat(64), 'a'.repeat(64)],
      )
      containers = (await (
        await request(member, '/projects/demo/containers')
      ).json()) as any[]
      assert.equal(containers[0].container_id, 'c'.repeat(64))
      await grants([])
      assert.equal((await request(member, deployment)).status, 404)
      assert.deepEqual(
        await (await request(member, '/projects/demo/containers')).json(),
        [],
      )
      // A creator receives access only to services they create.
      await grants([{ capability: 'create', service: null }])
      assert.equal(
        (
          await request(member, base, 'POST', {
            slug: 'mine',
            name: 'Mine',
            type: 'compose',
          })
        ).status,
        201,
      )
      list = (await (await request(member, base)).json()) as any
      assert.deepEqual(
        list.services.map((s: any) => s.slug),
        ['mine'],
      )
      assert.equal(list.services[0].can_deploy, false)
      await grants([{ capability: 'delete', service: 'web' }])
      await pool.query(
        "UPDATE deployment_builds SET status='running' WHERE deployment_id=$1",
        [savedData.id],
      )
      assert.equal((await request(member, `${base}/web`, 'DELETE')).status, 409)
      await pool.query(
        "UPDATE deployment_builds SET status='succeeded' WHERE deployment_id=$1",
        [savedData.id],
      )
      assert.equal((await request(member, `${base}/web`, 'DELETE')).status, 200)
      assert.equal(
        (
          await pool.query('SELECT 1 FROM deployments WHERE id=$1', [
            savedData.id,
          ])
        ).rowCount,
        0,
      )
      assert.equal(
        (await pool.query("SELECT 1 FROM service_grants WHERE service='web'"))
          .rowCount,
        0,
      )
    } finally {
      await pool.end()
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      await database.end()
    }
  },
)
