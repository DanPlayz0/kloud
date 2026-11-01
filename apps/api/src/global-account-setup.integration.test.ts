import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'first shared account setup requires email and atomically creates one account with default organization administration',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = 'setup_account_' + randomUUID().replaceAll('-', '')
    await database.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', '-c search_path=' + schema)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate, migrateDatabase } = await import('./migrate.js')
    const { ensureOrganizationRegistry } = await import('./organizations.js')
    const { initializeGlobalAccounts, withAccounts, getAccountSchema } =
      await import('./global-accounts.js')
    const { app } = await import('./app.js')
    const { publicOrigin } = await import('./security.js')
    let central: string | undefined
    const request = (path: string, body?: unknown, cookie = '') =>
      app.request(path, {
        method: body ? 'POST' : 'GET',
        headers: {
          origin: publicOrigin,
          cookie,
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    try {
      await migrate()
      await ensureOrganizationRegistry()
      await initializeGlobalAccounts(migrateDatabase)
      central = getAccountSchema()
      assert.equal((await (await request('/auth/setup')).json()).required, true)
      const password = 'strong first organization administrator password'
      const noEmail = await request('/auth/setup', {
        username: 'owner',
        password,
      })
      assert.equal(noEmail.status, 400)
      assert.equal(
        (await withAccounts(() => pool.query('SELECT count(*) FROM users')))
          .rows[0].count,
        '0',
      )
      assert.equal(
        (await pool.query('SELECT count(*) FROM users')).rows[0].count,
        '0',
      )
      const attempts = await Promise.all([
        request('/auth/setup', {
          username: 'owner-a',
          email: 'OWNER-A@example.com',
          password,
        }),
        request('/auth/setup', {
          username: 'owner-b',
          email: 'OWNER-B@example.com',
          password,
        }),
      ])
      assert.deepEqual(
        attempts.map((response) => response.status).sort(),
        [200, 409],
      )
      const accounts = (
        await withAccounts(() =>
          pool.query(
            'SELECT id,username,account_email,password_hash,admin FROM users',
          ),
        )
      ).rows
      const shadows = (
        await pool.query(
          'SELECT id,username,account_email,password_hash,admin FROM users',
        )
      ).rows
      assert.equal(accounts.length, 1)
      assert.equal(shadows.length, 1)
      assert.equal(accounts[0].id, shadows[0].id)
      assert.equal(accounts[0].username, shadows[0].username)
      assert.equal(
        accounts[0].account_email,
        accounts[0].account_email.toLowerCase(),
      )
      assert.equal(shadows[0].admin, true)
      assert.equal(accounts[0].admin, false)
      assert.equal(shadows[0].password_hash, 'global-account')
      assert.notEqual(accounts[0].password_hash, 'global-account')
      assert.equal(
        (await (await request('/auth/setup')).json()).required,
        false,
      )
      const login = await request('/auth/password', {
        username: accounts[0].account_email,
        password,
      })
      assert.equal(login.status, 200, await login.clone().text())
      assert.equal((await login.json()).status, 'authenticated')
      const cookie = login.headers
        .getSetCookie()
        .find((value) => value.startsWith('session='))!
        .split(';')[0]!
      const me = await request('/auth/me', undefined, cookie)
      assert.equal(me.status, 200)
      const identity = await me.json()
      assert.equal(identity.id, accounts[0].id)
      assert.equal(identity.email, accounts[0].account_email)
      assert.equal(identity.admin, true)
      assert.equal(
        (await request('/admin/users', undefined, cookie)).status,
        200,
      )
    } finally {
      await pool.end()
      // Only exact test-created schemas are removed.
      if (central) await database.query(`DROP SCHEMA "${central}" CASCADE`)
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      await database.end()
    }
  },
)
