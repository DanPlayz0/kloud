import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'connector workspace migration and real inventory queries preserve capability and connector boundaries',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = 'connector_workspace_' + randomUUID().replaceAll('-', '')
    await database.query('CREATE SCHEMA ' + schema)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', '-c search_path=' + schema)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { token, digest, publicOrigin } = await import('./security.js')
    const host = randomUUID(),
      other = randomUUID(),
      user = randomUUID(),
      pm2 = randomUUID()
    const secret = token(),
      container = 'a'.repeat(64)
    const request = (path: string, body?: unknown) =>
      app.request(path, {
        method: body ? 'POST' : 'GET',
        headers: {
          origin: publicOrigin,
          cookie: 'session=' + secret,
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    try {
      await migrate()
      await pool.query(
        "INSERT INTO users(id,username,capabilities) VALUES($1,'inventory',ARRAY['inventory.manage'])",
        [user],
      )
      // Simulate a v9 installation so the new constraint is exercised as an upgrade.
      await pool.query('DELETE FROM migrations WHERE version=10')
      await pool.query(
        "ALTER TABLE users DROP CONSTRAINT users_capabilities_check; ALTER TABLE users ADD CONSTRAINT users_capabilities_check CHECK (capabilities <@ ARRAY['dns.manage','users.manage','projects.create','projects.manage','connectors.manage','inventory.manage']::text[])",
      )
      await migrate()
      await migrate()
      assert.deepEqual(
        (await pool.query('SELECT capabilities FROM users WHERE id=$1', [user]))
          .rows[0].capabilities,
        ['inventory.manage'],
      )
      await pool.query(
        "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
        [digest(secret), user],
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token,discovery,seen,docker_seen,pm2_seen,pm2_available,capabilities) VALUES($1,'host',$2,true,now(),now(),now(),true,ARRAY['runtime','pm2']),($3,'other',$4,true,now(),now(),now(),true,ARRAY['runtime','pm2'])",
        [host, digest(token()), other, digest(token())],
      )
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('alpha','Alpha')",
      )
      await pool.query(
        'INSERT INTO inventory(connector_id,container_id,data) VALUES($1,$3,$4),($2,$3,$4)',
        [
          host,
          other,
          container,
          JSON.stringify({
            name: 'web',
            project: null,
            application: null,
            cpu: null,
            memory: null,
            memoryLimit: null,
            state: 'running',
          }),
        ],
      )
      await pool.query(
        "INSERT INTO pm2_apps(id,connector_id,namespace,name) VALUES($1,$2,'default','worker'),($3,$4,'default','worker')",
        [pm2, host, randomUUID(), other],
      )
      const base = '/connectors/' + host
      assert.equal((await request('/connectors')).status, 200)
      for (const collection of ['containers', 'pm2']) {
        const rows = (await (
          await request(base + '/' + collection)
        ).json()) as { connector_id: string }[]
        assert.equal(rows.length, 1)
        assert.equal(rows[0]!.connector_id, host)
      }
      assert.equal(
        (
          await request(base + '/containers/' + container + '/operation', {
            action: 'restart',
          })
        ).status,
        403,
      )
      await pool.query(
        "UPDATE users SET capabilities=ARRAY['connectors.operate'] WHERE id=$1",
        [user],
      )
      const document = (await (await request('/openapi.json')).json()) as any
      assert.ok(
        document.paths['/connectors/{connector}/pm2/{resource}/operation'],
      )
      assert.ok(
        document.components.schemas.User.properties.capabilities.items.enum.includes(
          'connectors.operate',
        ),
      )
      const perms = (await (
        await request(base + '/containers/' + container + '/permissions')
      ).json()) as any
      assert.equal(perms.lifecycle, true)
      assert.equal(
        (await request('/connectors/' + other + '/pm2/' + pm2 + '/permissions'))
          .status,
        404,
      )
      await pool.query('UPDATE connectors SET discovery=false WHERE id=$1', [
        host,
      ])
      assert.deepEqual(await (await request(base + '/containers')).json(), [])
      assert.deepEqual(await (await request(base + '/pm2')).json(), [])
      await pool.query(
        "INSERT INTO assignments(connector_id,container_id,project_slug,application) VALUES($1,$2,'alpha','web')",
        [host, container],
      )
      await pool.query("UPDATE pm2_apps SET project_slug='alpha' WHERE id=$1", [
        pm2,
      ])
      assert.equal(
        ((await (await request(base + '/containers')).json()) as unknown[])
          .length,
        1,
      )
      assert.equal(
        ((await (await request(base + '/pm2')).json()) as unknown[]).length,
        1,
      )
      await pool.query(
        "UPDATE connectors SET docker_seen=now()-interval '1 minute' WHERE id=$1",
        [host],
      )
      assert.equal(
        (
          await request(base + '/containers/' + container + '/operation', {
            action: 'restart',
          })
        ).status,
        409,
      )
      assert.equal(
        (
          (await (
            await request(base + '/pm2/' + pm2 + '/permissions')
          ).json()) as any
        ).available,
        true,
      )
      await pool.query('UPDATE connectors SET revoked=true WHERE id=$1', [host])
      assert.equal((await request(base)).status, 404)
      assert.equal((await request(base + '/pm2')).status, 404)
    } finally {
      await pool.end()
      await database.query('DROP SCHEMA ' + schema + ' CASCADE')
      await database.end()
    }
  },
)
