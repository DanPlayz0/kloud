import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'issued connector and enrollment tokens cannot be retrieved through read APIs',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = 'token_exposure_' + randomUUID().replaceAll('-', '')
    await database.query('CREATE SCHEMA ' + schema)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', '-c search_path=' + schema)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { token, digest, publicOrigin } = await import('./security.js')
    const session = token()
    const admin = randomUUID()
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      authenticated = true,
    ) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          ...(authenticated ? { cookie: 'session=' + session } : {}),
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    try {
      await migrate()
      await pool.query(
        "INSERT INTO users(id,username,admin,password_hash) VALUES($1,'admin',true,'private-password-hash')",
        [admin],
      )
      await pool.query(
        "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
        [digest(session), admin],
      )
      await pool.query("INSERT INTO projects(slug,name) VALUES('demo','Demo')")
      await pool.query(
        "INSERT INTO services(project_slug,slug,name,type) VALUES('demo','web','Web','application')",
      )

      const issued = await request('/admin/connectors', 'POST', {
        name: 'Host',
      })
      assert.equal(issued.status, 201)
      assert.equal(issued.headers.get('cache-control'), 'no-store')
      const created = (await issued.json()) as { id: string; token: string }
      const enrollment = await request('/admin/users', 'POST', {
        username: 'invited',
      })
      assert.equal(enrollment.status, 201)
      const invitation = new URL(
        ((await enrollment.json()) as { enrollmentUrl: string }).enrollmentUrl,
      ).hash.slice(1)
      const secrets = [
        session,
        digest(session),
        created.token,
        digest(created.token),
        invitation,
        digest(invitation),
        'private-password-hash',
      ]
      const reads = [
        '/admin/connectors',
        '/connectors',
        '/connectors/' + created.id,
        '/projects/demo/services/web/connectors',
        '/admin/users',
        '/auth/me',
        '/auth/security',
      ]
      const assertNoSecrets = async () => {
        for (const path of reads) {
          const response = await request(path)
          assert.equal(response.status, 200, path)
          assert.equal(response.headers.get('cache-control'), 'no-store', path)
          const text = await response.text()
          for (const secret of secrets)
            assert.ok(
              !text.includes(secret),
              `${path} exposed a stored credential`,
            )
          assert.doesNotMatch(
            text,
            /"(?:token|password_hash|encrypted_credentials|enrollmentUrl)"\s*:/,
            path,
          )
        }
      }
      const stored = (
        await pool.query('SELECT token FROM connectors WHERE id=$1', [
          created.id,
        ])
      ).rows[0].token
      assert.equal(stored, digest(created.token))
      await assertNoSecrets()
      assert.equal(
        (await request('/connectors/' + created.id, 'GET', undefined, false))
          .status,
        401,
      )
      assert.equal(
        (
          await request(
            '/admin/connectors/' + created.id + '/rotate',
            'POST',
            undefined,
            false,
          )
        ).status,
        401,
      )
      const rotatedResponse = await request(
        '/admin/connectors/' + created.id + '/rotate',
        'POST',
      )
      assert.equal(rotatedResponse.status, 200)
      assert.equal(rotatedResponse.headers.get('cache-control'), 'no-store')
      const rotated = (await rotatedResponse.json()) as { token: string }
      assert.notEqual(rotated.token, created.token)
      secrets.push(rotated.token, digest(rotated.token))
      await assertNoSecrets()
      const claim = (value: string) =>
        app.request('/connectors/platform/claim', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + value },
        })
      assert.equal((await claim(created.token)).status, 401)
      assert.equal((await claim(rotated.token)).status, 200)
      await request('/admin/connectors/' + created.id, 'PUT', {
        discovery: false,
        revoked: true,
      })
      assert.equal((await claim(rotated.token)).status, 401)
      assert.equal((await request('/connectors/' + created.id)).status, 404)
      const listing = await (await request('/admin/connectors')).text()
      for (const secret of secrets) assert.ok(!listing.includes(secret))
    } finally {
      await pool.end()
      await database.query('DROP SCHEMA ' + schema + ' CASCADE')
      await database.end()
    }
  },
)
