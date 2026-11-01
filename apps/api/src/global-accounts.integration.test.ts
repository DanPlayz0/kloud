import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'shared account migration preserves IDs and authentication while isolating organization roles',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const root = 'account_test_' + randomUUID().replaceAll('-', '')
    const second = 'account_org_' + randomUUID().replaceAll('-', '')
    await database.query(`CREATE SCHEMA ${root}`)
    await database.query(`CREATE SCHEMA ${second}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', '-c search_path=' + root)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate, migrateDatabase } = await import('./migrate.js')
    const { runWithOrganization } = await import('./organization-context.js')
    const {
      initializeGlobalAccounts,
      accountsEnabled,
      withAccounts,
      getAccountSchema,
      linkOrganizationAccount,
    } = await import('./global-accounts.js')
    const firstId = randomUUID(),
      secondId = randomUUID(),
      thirdId = randomUUID()
    let central: string | undefined
    const secondary = { slug: 'second', schema: second }
    try {
      await migrate()
      await runWithOrganization(secondary, () => migrate())
      await pool.query(
        'CREATE TABLE kloud_organizations(slug text PRIMARY KEY,name text,schema_name text UNIQUE)',
      )
      await pool.query(
        "INSERT INTO kloud_organizations VALUES('default','Default',$1),('second','Second',$2)",
        [root, second],
      )
      await pool.query(
        `INSERT INTO users(id,username,password_hash,admin,email,email_2fa,totp_secret,passkey_2fa) VALUES($1,'owner','first-hash',true,'OWNER@example.com',true,'first-cipher',true)`,
        [firstId],
      )
      await pool.query(
        "INSERT INTO passkeys(id,user_id,public_key,counter,transports) VALUES('credential',$1,'key',4,'[]')",
        [firstId],
      )
      await pool.query(
        "INSERT INTO sessions VALUES('first-session',$1,now()+interval '1 hour')",
        [firstId],
      )
      await pool.query(
        "INSERT INTO invitations VALUES('first-invitation',$1,now()+interval '1 hour')",
        [firstId],
      )
      await pool.query(
        "INSERT INTO recovery_codes VALUES($1,'first-recovery')",
        [firstId],
      )
      await runWithOrganization(secondary, async () => {
        await pool.query(
          `INSERT INTO users(id,username,password_hash,email,email_2fa,totp_secret,capabilities,disabled) VALUES($1,'owner','second-hash','owner@example.com',true,'second-cipher',ARRAY['inventory.manage'],true)`,
          [secondId],
        )
        await pool.query(
          "INSERT INTO sessions VALUES('second-session',$1,now()+interval '1 hour')",
          [secondId],
        )
      })
      assert.equal(accountsEnabled(), false)
      await runWithOrganization(secondary, () =>
        pool.query(
          "INSERT INTO sessions VALUES('first-session',$1,now()+interval '1 hour')",
          [secondId],
        ),
      )
      await assert.rejects(
        initializeGlobalAccounts(migrateDatabase),
        /authentication records conflict/,
      )
      assert.equal(accountsEnabled(), false)
      assert.equal(
        (
          await pool.query('SELECT password_hash FROM users WHERE id=$1', [
            firstId,
          ])
        ).rows[0].password_hash,
        'first-hash',
      )
      assert.equal(
        (await pool.query('SELECT count(*) FROM sessions')).rows[0].count,
        '1',
      )
      await runWithOrganization(secondary, () =>
        pool.query("DELETE FROM sessions WHERE token='first-session'"),
      )
      await initializeGlobalAccounts(migrateDatabase)
      central = getAccountSchema()
      assert.match(central!, /^kloud_accounts_[a-f0-9]{32}$/)
      assert.equal(accountsEnabled(), true)
      const users = await withAccounts(() =>
        pool.query('SELECT * FROM users ORDER BY username'),
      )
      const first = users.rows.find((user) => user.id === firstId),
        other = users.rows.find((user) => user.id === secondId)
      assert.equal(users.rows.length, 2)
      assert.equal(first.username, 'owner')
      assert.notEqual(other.username, 'owner')
      assert.equal(first.password_hash, 'first-hash')
      assert.equal(other.password_hash, 'second-hash')
      assert.equal(first.account_email, 'owner@example.com')
      assert.equal(other.account_email, null)
      assert.equal(other.email, 'owner@example.com')
      assert.equal(other.email_2fa, true)
      assert.equal(first.totp_secret, 'first-cipher')
      assert.equal(first.passkey_2fa, true)
      assert.equal(first.disabled, false)
      assert.equal(other.disabled, false)
      assert.equal(
        (
          await runWithOrganization(secondary, () =>
            pool.query('SELECT disabled FROM users WHERE id=$1', [secondId]),
          )
        ).rows[0].disabled,
        true,
      )
      assert.equal(first.admin, false)
      assert.deepEqual(other.capabilities, [])
      assert.equal(
        (await withAccounts(() => pool.query('SELECT count(*) FROM sessions')))
          .rows[0].count,
        '2',
      )
      assert.equal(
        (await withAccounts(() => pool.query('SELECT counter FROM passkeys')))
          .rows[0].counter,
        '4',
      )
      assert.equal(
        (
          await withAccounts(() =>
            pool.query('SELECT count(*) FROM recovery_codes'),
          )
        ).rows[0].count,
        '1',
      )
      assert.equal(
        (
          await withAccounts(() =>
            pool.query('SELECT count(*) FROM invitations'),
          )
        ).rows[0].count,
        '1',
      )
      const local = (
        await pool.query('SELECT * FROM users WHERE id=$1', [firstId])
      ).rows[0]
      assert.equal(local.password_hash, 'global-account')
      assert.equal(local.totp_secret, null)
      assert.equal(local.email_2fa, false)
      assert.equal(local.admin, true)
      assert.equal(
        (await pool.query('SELECT count(*) FROM sessions')).rows[0].count,
        '0',
      )
      await withAccounts(() =>
        pool.query(
          "INSERT INTO users(id,username,password_hash,account_email) VALUES($1,'friend','third-hash','friend@example.com')",
          [thirdId],
        ),
      )
      // Link using a scoped checked-out transaction, preserving revoked shadows.
      const { transaction } = await import('./db.js')
      await runWithOrganization(secondary, () =>
        transaction(async (db) => {
          await linkOrganizationAccount(
            db,
            {
              id: thirdId,
              username: 'friend',
              email: 'friend@example.com',
              password_hash: 'third-hash',
            },
            { admin: false },
          )
          await db.query('UPDATE users SET disabled=true WHERE id=$1', [
            thirdId,
          ])
          await linkOrganizationAccount(
            db,
            {
              id: thirdId,
              username: 'friend',
              email: 'friend@example.com',
              password_hash: 'third-hash',
            },
            { admin: true },
          )
          assert.equal(
            (
              await db.query('SELECT disabled FROM users WHERE id=$1', [
                thirdId,
              ])
            ).rows[0].disabled,
            true,
          )
        }),
      )
      await assert.rejects(
        runWithOrganization(secondary, () =>
          pool.query("INSERT INTO users(id,username) VALUES($1,'unknown')", [
            randomUUID(),
          ]),
        ),
        /foreign key/,
      )
      // Reinitializing never copies a shadow marker over the real password.
      await initializeGlobalAccounts(migrateDatabase)
      assert.equal(
        (
          await withAccounts(() =>
            pool.query('SELECT password_hash FROM users WHERE id=$1', [
              firstId,
            ]),
          )
        ).rows[0].password_hash,
        'first-hash',
      )
    } finally {
      await pool.end()
      // These are the exact schemas created by this test; no registry enumeration.
      if (central) await database.query(`DROP SCHEMA "${central}" CASCADE`)
      await database.query(`DROP SCHEMA ${second} CASCADE`)
      await database.query(`DROP SCHEMA ${root} CASCADE`)
      await database.end()
    }
  },
)
