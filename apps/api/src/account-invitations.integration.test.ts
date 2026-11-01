import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test(
  'existing accounts accept email organization invitations without resetting credentials or granting access before acceptance',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const root = 'invite_test_' + randomUUID().replaceAll('-', '')
    const second = 'invite_org_' + randomUUID().replaceAll('-', '')
    await database.query(`CREATE SCHEMA ${root}`)
    await database.query(`CREATE SCHEMA ${second}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', '-c search_path=' + root)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate, migrateDatabase } = await import('./migrate.js')
    const { runWithOrganization } = await import('./organization-context.js')
    const { ensureOrganizationRegistry } = await import('./organizations.js')
    const { initializeGlobalAccounts, withAccounts, getAccountSchema } =
      await import('./global-accounts.js')
    const { app } = await import('./app.js')
    const { digest, token, publicOrigin, hashPassword } =
      await import('./security.js')
    const secondary = { slug: 'second', schema: second }
    const owner = randomUUID(),
      friend = randomUUID(),
      stranger = randomUUID()
    const sessions = { owner: token(), friend: token(), stranger: token() }
    let central: string | undefined
    const request = (
      path: string,
      session?: string,
      body?: unknown,
      method = body ? 'POST' : 'GET',
    ) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: session ? 'session=' + session : '',
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    try {
      await migrate()
      await runWithOrganization(secondary, () => migrate())
      await ensureOrganizationRegistry()
      await pool.query(
        "INSERT INTO kloud_organizations(slug,name,schema_name) VALUES('second','Second organization',$1)",
        [second],
      )
      await pool.query(
        "INSERT INTO users(id,username,admin,email,password_hash) VALUES($1,'owner',true,'owner@example.com',$3),($2,'stranger',false,'stranger@example.com',$3)",
        [
          owner,
          stranger,
          await hashPassword('owner password of sufficient length'),
        ],
      )
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('private','Private project')",
      )
      const passwordHash = await hashPassword(
        'friend account password unchanged',
      )
      await runWithOrganization(secondary, () =>
        pool.query(
          "INSERT INTO users(id,username,email,password_hash,totp_secret,email_2fa) VALUES($1,'friend','friend@example.com',$2,'encrypted-existing-totp',true)",
          [friend, passwordHash],
        ),
      )
      await initializeGlobalAccounts(migrateDatabase)
      central = getAccountSchema()
      await withAccounts(async () => {
        for (const [who, id] of Object.entries({ owner, friend, stranger }))
          await pool.query(
            "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
            [digest(sessions[who as keyof typeof sessions]), id],
          )
      })
      const before = (
        await withAccounts(() =>
          pool.query(
            'SELECT password_hash,totp_secret,email_2fa,security_version FROM users WHERE id=$1',
            [friend],
          ),
        )
      ).rows[0]
      const issued = await request(
        '/organizations/invitations',
        sessions.owner,
        { email: 'FRIEND@example.com' },
      )
      assert.equal(issued.status, 201, await issued.clone().text())
      const invitation = (await issued.json()).invitationUrl as string
      const secret = new URL(invitation).hash.slice(1)
      assert.ok(secret)
      assert.equal((await request('/projects', sessions.friend)).status, 403)
      const premature = await app.request('/admin/users/' + friend, {
        method: 'PUT',
        headers: {
          origin: publicOrigin,
          cookie: 'session=' + sessions.owner,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ disabled: false, admin: true }),
      })
      assert.equal(premature.status, 409)
      // Even a stale enabled shadow must not authorize an unaccepted invitation.
      await pool.query(
        'UPDATE users SET disabled=false,admin=true WHERE id=$1',
        [friend],
      )
      assert.equal((await request('/projects', sessions.friend)).status, 403)
      assert.equal(
        (await (await request('/auth/me', sessions.friend)).json())
          .organization_member,
        false,
      )
      const listed = await (
        await request('/organizations', sessions.friend)
      ).json()
      assert.ok(!listed.some((org: { slug: string }) => org.slug === 'default'))
      await pool.query(
        'UPDATE users SET disabled=true,admin=false WHERE id=$1',
        [friend],
      )
      const identity = await request('/auth/me', sessions.friend)
      assert.equal(identity.status, 200)
      assert.equal((await identity.json()).id, friend)
      const metadata = await request(
        '/auth/invitation?token=' + encodeURIComponent(secret),
      )
      assert.equal(metadata.status, 200)
      assert.equal((await metadata.json()).existing_account, true)
      const reset = await request('/auth/enroll', undefined, {
        token: secret,
        password: 'unwanted replacement password',
      })
      assert.equal(reset.status, 409)
      assert.equal(
        (
          await request('/auth/invitations/accept', sessions.stranger, {
            token: secret,
          })
        ).status,
        403,
      )
      assert.equal(
        (
          await request('/auth/invitations/accept', sessions.friend, {
            token: secret,
          })
        ).status,
        200,
      )
      assert.equal(
        (
          await request('/auth/invitations/accept', sessions.friend, {
            token: secret,
          })
        ).status,
        409,
      )
      assert.equal((await request('/projects', sessions.friend)).status, 200)
      assert.equal(
        (await request('/organizations/second/projects', sessions.friend))
          .status,
        200,
      )
      const after = (
        await withAccounts(() =>
          pool.query(
            'SELECT password_hash,totp_secret,email_2fa,security_version FROM users WHERE id=$1',
            [friend],
          ),
        )
      ).rows[0]
      assert.deepEqual(after, before)
      assert.equal(
        (
          await withAccounts(() =>
            pool.query(
              'SELECT count(*) FROM users WHERE lower(account_email)=$1',
              ['friend@example.com'],
            ),
          )
        ).rows[0].count,
        '1',
      )
      assert.equal(
        (
          await pool.query('SELECT id,disabled FROM users WHERE id=$1', [
            friend,
          ])
        ).rows[0].disabled,
        false,
      )
      // Organization membership is scoped; acceptance does not confer project access.
      assert.equal(
        (await request('/projects/private/containers', sessions.friend)).status,
        404,
      )
      // A new email creates only a pending account until the recipient enrolls.
      const newEmail = 'new-member@example.com'
      const newPassword = 'new account password of sufficient length'
      const newInvite = await request('/admin/users', sessions.owner, {
        email: newEmail,
        capabilities: ['connectors.manage'],
      })
      assert.equal(newInvite.status, 201, await newInvite.clone().text())
      const newSecret = new URL(
        (await newInvite.json()).enrollmentUrl,
      ).hash.slice(1)
      const pending = (
        await withAccounts(() =>
          pool.query(
            'SELECT id,password_hash FROM users WHERE account_email=$1',
            [newEmail],
          ),
        )
      ).rows[0]
      assert.equal(pending.password_hash, null)
      const pendingShadow = (
        await pool.query(
          'SELECT disabled,invitation_pending,capabilities FROM users WHERE id=$1',
          [pending.id],
        )
      ).rows[0]
      assert.equal(pendingShadow.disabled, true)
      assert.equal(pendingShadow.invitation_pending, true)
      assert.deepEqual(pendingShadow.capabilities, [])
      assert.equal(
        (
          await request('/auth/password', undefined, {
            username: newEmail,
            password: newPassword,
          })
        ).status,
        401,
      )
      const newMetadata = await request(
        '/auth/invitation?token=' + encodeURIComponent(newSecret),
      )
      assert.equal(newMetadata.status, 200)
      assert.equal((await newMetadata.json()).existing_account, false)
      assert.equal(
        (
          await request('/auth/enroll', undefined, {
            token: newSecret,
            password: newPassword,
          })
        ).status,
        200,
      )
      const newLogin = await request('/auth/password', undefined, {
        username: newEmail,
        password: newPassword,
      })
      assert.equal(newLogin.status, 200, await newLogin.clone().text())
      assert.equal((await newLogin.json()).status, 'authenticated')
      const newSession = newLogin.headers
        .getSetCookie()
        .find((value) => value.startsWith('session='))!
        .split(';')[0]!
        .slice('session='.length)
      const newIdentity = await request('/auth/me', newSession)
      const newUser = await newIdentity.json()
      assert.equal(newUser.id, pending.id)
      assert.equal(newUser.email, newEmail)
      assert.equal(newUser.admin, false)
      assert.deepEqual(newUser.capabilities, ['connectors.manage'])
      assert.equal((await request('/projects', newSession)).status, 200)
      assert.equal(
        (await request('/organizations/second/projects', newSession)).status,
        403,
      )

      // Account email is global and separate from the verified MFA delivery address.
      assert.equal(
        (
          await request(
            '/auth/profile',
            sessions.friend,
            { email: 'friend-renamed@example.com', password: 'incorrect' },
            'PATCH',
          )
        ).status,
        403,
      )
      const profile = await request(
        '/auth/profile',
        sessions.friend,
        {
          email: 'FRIEND-RENAMED@example.com',
          password: 'friend account password unchanged',
        },
        'PATCH',
      )
      assert.equal(profile.status, 200, await profile.clone().text())
      for (const base of ['', '/organizations/second']) {
        const me = await request(base + '/auth/me', sessions.friend)
        assert.equal(me.status, 200)
        assert.equal((await me.json()).email, 'friend-renamed@example.com')
      }
      const unchanged = (
        await withAccounts(() =>
          pool.query(
            'SELECT password_hash,totp_secret,email_2fa,security_version FROM users WHERE id=$1',
            [friend],
          ),
        )
      ).rows[0]
      assert.deepEqual(unchanged, before)
      assert.equal(
        (
          await withAccounts(() =>
            pool.query('SELECT email FROM users WHERE id=$1', [friend]),
          )
        ).rows[0].email,
        'friend@example.com',
      )
      assert.equal(
        (
          await request(
            '/auth/profile',
            sessions.friend,
            {
              email: 'owner@example.com',
              password: 'friend account password unchanged',
            },
            'PATCH',
          )
        ).status,
        409,
      )

      // Existing accounts receive project-scoped grants only after accepting.
      const projectBody = {
        email: 'friend-renamed@example.com',
        role: 'member',
        grants: [
          { capability: 'logs', kind: 'all', connector_id: null, target: null },
        ],
        service_grants: [{ capability: 'deploy', service: null }],
        pm2_grants: [],
        dns_grants: [],
      }
      const projectInvite = await request(
        '/projects/private/access/members',
        sessions.owner,
        projectBody,
      )
      assert.equal(
        projectInvite.status,
        201,
        await projectInvite.clone().text(),
      )
      const projectSecret = new URL(
        (await projectInvite.json()).enrollmentUrl,
      ).hash.slice(1)
      assert.equal(
        (await request('/projects/private/containers', sessions.friend)).status,
        404,
      )
      const projectAccepted = await request(
        '/auth/invitations/accept',
        sessions.friend,
        { token: projectSecret },
      )
      assert.equal(
        projectAccepted.status,
        200,
        await projectAccepted.clone().text(),
      )
      assert.equal(
        (await request('/projects/private/containers', sessions.friend)).status,
        200,
      )
      assert.deepEqual(
        (
          await pool.query(
            'SELECT capability FROM container_grants WHERE user_id=$1 AND project_slug=$2 ORDER BY capability',
            [friend, 'private'],
          )
        ).rows.map((row) => row.capability),
        ['logs', 'view'],
      )
      assert.deepEqual(
        (
          await pool.query(
            'SELECT capability FROM service_grants WHERE user_id=$1 AND project_slug=$2 ORDER BY capability',
            [friend, 'private'],
          )
        ).rows.map((row) => row.capability),
        ['deploy', 'read'],
      )

      // A project administrator cannot revive revoked organization membership.
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'private','admin')",
        [stranger],
      )
      await pool.query(
        'UPDATE users SET disabled=true,invitation_pending=false WHERE id=$1',
        [friend],
      )
      assert.equal(
        (
          await request(
            '/projects/private/access/members',
            sessions.stranger,
            projectBody,
          )
        ).status,
        409,
      )
      assert.equal(
        (await pool.query('SELECT disabled FROM users WHERE id=$1', [friend]))
          .rows[0].disabled,
        true,
      )
      assert.equal(
        (
          await request(
            '/admin/users/' + friend,
            sessions.owner,
            { disabled: false },
            'PUT',
          )
        ).status,
        200,
      )
      assert.equal(
        (await pool.query('SELECT disabled FROM users WHERE id=$1', [friend]))
          .rows[0].disabled,
        false,
      )

      // A queued invitation cannot retain its issuer's revoked privileges.
      const revokedInvite = await request(
        '/organizations/invitations',
        sessions.owner,
        { email: 'revoked-issuer@example.com' },
      )
      assert.equal(revokedInvite.status, 201)
      const revokedSecret = new URL(
        (await revokedInvite.json()).invitationUrl,
      ).hash.slice(1)
      await pool.query(
        "UPDATE users SET admin=false,capabilities='{}' WHERE id=$1",
        [owner],
      )
      const denied = await request('/auth/enroll', undefined, {
        token: revokedSecret,
        password: 'recipient password never applied',
      })
      assert.equal(denied.status, 403, await denied.clone().text())
      assert.equal(
        (
          await withAccounts(() =>
            pool.query(
              'SELECT password_hash FROM users WHERE account_email=$1',
              ['revoked-issuer@example.com'],
            ),
          )
        ).rows[0].password_hash,
        null,
      )
    } finally {
      await pool.end()
      // Only the exact schemas generated by this test are removed.
      if (central) await database.query(`DROP SCHEMA "${central}" CASCADE`)
      await database.query(`DROP SCHEMA ${second} CASCADE`)
      await database.query(`DROP SCHEMA ${root} CASCADE`)
      await database.end()
    }
  },
)
