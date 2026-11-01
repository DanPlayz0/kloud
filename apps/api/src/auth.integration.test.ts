import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SMTPServer } from 'smtp-server'
import * as OTPAuth from 'otpauth'
import pg from 'pg'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test(
  'password login, optional factors, recovery and migration',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = 'auth_' + randomUUID().replaceAll('-', '')
    await database.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    process.env.ALLOWED_ORIGINS =
      'http://localhost:8080,http://127.0.0.1:8080,http://203.0.113.10:8080,https://kloud.example.com'
    process.env.AUTH_ENCRYPTION_KEY = 'ab'.repeat(32)
    process.env.SMTP_HOST = '127.0.0.1'
    process.env.SMTP_FROM = 'kloud@example.com'
    process.env.SMTP_TLS = 'plain'
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASSWORD
    const messages: string[] = []
    let rejectMail = false
    const smtp = new SMTPServer({
      disabledCommands: ['AUTH', 'STARTTLS'],
      onData(stream, _session, callback) {
        let body = ''
        stream.on('data', (chunk) => {
          body += chunk
        })
        stream.on('end', () => {
          if (rejectMail) callback(new Error('Delivery rejected'))
          else {
            messages.push(body)
            callback()
          }
        })
      },
    })
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve))
    process.env.SMTP_PORT = String(
      (smtp.server.address() as { port: number }).port,
    )
    const { pool } = await import('./db.js')
    const { migrate, migration } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { digest, hashPassword, publicOrigin } = await import('./security.js')
    const { encryptSecret, decryptSecret, newTotp } =
      await import('./auth-factors.js')
    const password = 'a long secure test password'
    const lastCode = () => messages.at(-1)!.match(/code is (\d{6})/)![1]!
    const client = (origin = publicOrigin) => {
      const jar = new Map<string, string>()
      return {
        jar,
        async request(
          path: string,
          body?: unknown,
          method = body === undefined ? 'GET' : 'POST',
        ) {
          const response = await app.request(path, {
            method,
            headers: {
              origin,
              'content-type': 'application/json',
              cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
          for (const cookie of response.headers.getSetCookie()) {
            const [key, value] = cookie.split(';')[0]!.split('=')
            jar.set(key!, value!)
          }
          return response
        },
      }
    }
    const owner = client()
    const login = async (name = 'owner') => {
      const c = client(),
        response = await c.request('/auth/password', {
          username: name,
          password,
        })
      assert.equal(response.status, 200, await response.clone().text())
      return { c, result: await response.json() }
    }
    let userID = '',
      recovery: string[] = []
    const allowEmail = () =>
      pool.query(
        "UPDATE auth_email_limits SET sent_at=now()-interval '61 seconds',window_start=now()-interval '16 minutes',sends=0",
      )
    const reauth = async (c = owner) => {
      const r = await c.request('/auth/security/reauth', { password })
      assert.equal(r.status, 200, await r.clone().text())
      const data = await r.json()
      if (data.status === 'second_factor_required') {
        const response = await c.request('/auth/factor/verify', {
          method: 'recovery',
          code: recovery.shift(),
        })
        assert.equal(response.status, 200, await response.clone().text())
      }
    }
    try {
      await t.test(
        'migration backfills existing passkeys and is idempotent',
        async () => {
          await pool.query(migration)
          await pool.query(
            'CREATE TABLE migrations(version integer PRIMARY KEY,applied timestamptz NOT NULL DEFAULT now()); INSERT INTO migrations(version) VALUES(1)',
          )
          const id = randomUUID()
          await pool.query(
            "INSERT INTO users(id,username,password_hash) VALUES($1,'legacy',$2)",
            [id, await hashPassword(password)],
          )
          await pool.query(
            "INSERT INTO passkeys(id,user_id,public_key,counter,transports) VALUES('legacy',$1,$2,0,'[]')",
            [id, Buffer.from('public')],
          )
          await migrate()
          await migrate()
          assert.equal(
            (
              await pool.query('SELECT passkey_2fa FROM users WHERE id=$1', [
                id,
              ])
            ).rows[0].passkey_2fa,
            true,
          )
          const { result } = await login('legacy')
          assert.equal(result.status, 'second_factor_required')
          assert.deepEqual(result.methods, ['passkey'])
          await pool.query('DELETE FROM users')
        },
      )
      await t.test(
        'setup accepts passwords only and existing installations stay closed',
        async () => {
          assert.equal(
            (
              await owner.request('/auth/setup', {
                username: 'owner',
                password,
              })
            ).status,
            200,
          )
          assert.equal(
            (
              await owner.request('/auth/setup', {
                username: 'other',
                password,
              })
            ).status,
            409,
          )
          const r = await owner.request('/auth/password', {
            username: 'OWNER',
            password,
          })
          assert.deepEqual(await r.json(), { status: 'authenticated' })
          userID = (await (await owner.request('/auth/me')).json()).id
          assert.equal((await pool.query('SELECT * FROM passkeys')).rowCount, 0)
          assert.equal(
            (await owner.request('/auth/security/remove', { method: 'all' }))
              .status,
            401,
          )
        },
      )
      await t.test(
        'password login works on localhost, direct IP and the tunnel with per-address cookies',
        async () => {
          for (const origin of [
            'http://localhost:8080',
            'http://127.0.0.1:8080',
            'http://203.0.113.10:8080',
            'https://kloud.example.com',
          ]) {
            const c = client(origin)
            const response = await c.request('/auth/password', {
              username: 'owner',
              password,
            })
            assert.equal(response.status, 200, await response.clone().text())
            assert.equal((await response.json()).status, 'authenticated')
            const cookie = response.headers
              .getSetCookie()
              .find((value) => value.startsWith('session='))!
            assert.equal(
              cookie.includes('; Secure'),
              origin.startsWith('https:'),
            )
            assert.match(cookie, /HttpOnly/)
            assert.match(cookie, /SameSite=Strict/)
            assert.doesNotMatch(cookie, /Domain=/)
            assert.equal((await c.request('/auth/me')).status, 200)
            const reauth = await c.request('/auth/security/reauth', {
              password,
            })
            assert.equal(reauth.status, 200)
            assert.equal(
              reauth.headers
                .getSetCookie()
                .some(
                  (value) =>
                    value.startsWith('security_grant=') &&
                    value.includes('; Secure'),
                ),
              origin.startsWith('https:'),
            )
            if (origin.includes('203.0.113')) {
              assert.equal(
                (await (await c.request('/auth/security')).json())
                  .passkeyAvailable,
                false,
              )
              assert.equal(
                (
                  await c.request('/auth/security/enroll', {
                    method: 'passkey',
                  })
                ).status,
                400,
              )
            }
          }
          const evil = client('https://attacker.example')
          assert.equal(
            (
              await evil.request('/auth/password', {
                username: 'owner',
                password,
              })
            ).status,
            403,
          )
          const missing = await app.request('/auth/password', {
            method: 'POST',
            headers: {
              'x-kloud-origin': 'https://kloud.example.com',
              'x-forwarded-proto': 'https',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ username: 'owner', password }),
          })
          assert.equal(missing.status, 403)
          const direct = client('http://203.0.113.10:8080')
          await direct.request('/auth/password', {
            username: 'owner',
            password,
          })
          const invite = await direct.request('/admin/users', {
            username: 'direct-invitation',
          })
          assert.equal(invite.status, 201)
          assert.match(
            (await invite.json()).enrollmentUrl,
            /^http:\/\/203\.0\.113\.10:8080\/enroll#/,
          )
        },
      )
      await t.test(
        'security grants expire and cannot be reused with a different session',
        async () => {
          await reauth()
          const second = await login()
          second.c.jar.set('security_grant', owner.jar.get('security_grant')!)
          assert.equal(
            (
              await second.c.request('/auth/security/enroll', {
                method: 'totp',
              })
            ).status,
            401,
          )
          await pool.query(
            "UPDATE auth_pending SET expires=now()-interval '1 second' WHERE purpose='grant'",
          )
          assert.equal(
            (await owner.request('/auth/security/enroll', { method: 'totp' }))
              .status,
            401,
          )
        },
      )
      await t.test(
        'Email stays disabled without SMTP; enrollment verifies address and returns recovery codes',
        async () => {
          await reauth()
          const host = process.env.SMTP_HOST
          delete process.env.SMTP_HOST
          assert.equal(
            (await (await owner.request('/auth/security')).json())
              .emailAvailable,
            false,
          )
          assert.equal(
            (
              await owner.request('/auth/security/enroll', {
                method: 'email',
                email: 'owner@example.com',
              })
            ).status,
            503,
          )
          process.env.SMTP_HOST = host
          const before = owner.jar.get('session')!
          assert.equal(
            (
              await owner.request('/auth/security/enroll', {
                method: 'email',
                email: 'owner@example.com',
              })
            ).status,
            200,
          )
          assert.deepEqual(
            (await (await owner.request('/auth/security')).json()).methods,
            [],
          )
          assert.equal(
            (
              await owner.request('/auth/security/enroll', {
                method: 'email',
                email: 'owner@example.com',
              })
            ).status,
            429,
          )
          assert.equal(
            (await owner.request('/auth/security/confirm', { code: 'wrong' }))
              .status,
            400,
          )
          const done = await owner.request('/auth/security/confirm', {
            code: lastCode(),
          })
          assert.equal(done.status, 200, await done.clone().text())
          recovery = (await done.json()).recoveryCodes
          assert.equal(recovery.length, 10)
          assert.notEqual(owner.jar.get('session'), before)
          assert.equal(
            (
              await pool.query('SELECT 1 FROM sessions WHERE token=$1', [
                digest(before),
              ])
            ).rowCount,
            0,
          )
          assert.equal(
            (await owner.request('/auth/security/remove', { method: 'email' }))
              .status,
            401,
          )
          assert.equal(
            (await pool.query('SELECT hash FROM recovery_codes')).rows.some(
              (r) => recovery.includes(r.hash),
            ),
            false,
          )
        },
      )
      await t.test(
        'email sends are throttled, resending invalidates old codes, and login rejects replay',
        async () => {
          await allowEmail()
          const { c, result } = await login()
          assert.deepEqual(result.methods, ['email'])
          assert.equal(c.jar.get('session'), undefined)
          assert.equal((await c.request('/auth/me')).status, 401)
          assert.equal(
            (await c.request('/auth/factor/challenge', { method: 'email' }))
              .status,
            200,
          )
          const old = lastCode()
          assert.equal(
            (await c.request('/auth/factor/challenge', { method: 'email' }))
              .status,
            429,
          )
          await allowEmail()
          assert.equal(
            (await c.request('/auth/factor/challenge', { method: 'email' }))
              .status,
            200,
          )
          const fresh = lastCode()
          if (old !== fresh)
            assert.equal(
              (
                await c.request('/auth/factor/verify', {
                  method: 'email',
                  code: old,
                })
              ).status,
              401,
            )
          assert.equal(
            (
              await c.request('/auth/factor/verify', {
                method: 'email',
                code: fresh,
              })
            ).status,
            200,
          )
          assert.equal(
            (
              await c.request('/auth/factor/verify', {
                method: 'email',
                code: fresh,
              })
            ).status,
            401,
          )
        },
      )
      await t.test(
        'email send window and second-factor account limits are shared across challenges',
        async () => {
          const { c } = await login()
          await pool.query(
            "UPDATE auth_email_limits SET sent_at=now()-interval '61 seconds',window_start=now(),sends=5",
          )
          assert.equal(
            (await c.request('/auth/factor/challenge', { method: 'email' }))
              .status,
            429,
          )
          await pool.query(
            "INSERT INTO login_attempts(key,attempts,expires) VALUES($1,20,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=20,expires=EXCLUDED.expires",
            [digest('factor:' + userID)],
          )
          assert.equal(
            (
              await c.request('/auth/factor/verify', {
                method: 'recovery',
                code: recovery[0],
              })
            ).status,
            429,
          )
          await pool.query('DELETE FROM login_attempts')
        },
      )
      await t.test(
        'SMTP loss and delivery failure never downgrade enrolled users',
        async () => {
          delete process.env.SMTP_HOST
          const { c, result } = await login()
          assert.equal(result.status, 'second_factor_required')
          assert.equal(result.emailAvailable, false)
          assert.equal(
            (await c.request('/auth/factor/challenge', { method: 'email' }))
              .status,
            503,
          )
          process.env.SMTP_HOST = '127.0.0.1'
          rejectMail = true
          await allowEmail()
          assert.equal(
            (await c.request('/auth/factor/challenge', { method: 'email' }))
              .status,
            503,
          )
          assert.equal((await c.request('/auth/me')).status, 401)
          rejectMail = false
        },
      )
      await t.test(
        'pending verification and security grants cannot move between configured origins',
        async () => {
          const local = client('http://localhost:8080'),
            remote = client('https://kloud.example.com')
          const r = await local.request('/auth/password', {
            username: 'owner',
            password,
          })
          assert.equal((await r.json()).status, 'second_factor_required')
          for (const [key, value] of local.jar) remote.jar.set(key, value)
          assert.equal(
            (
              await remote.request('/auth/factor/verify', {
                method: 'recovery',
                code: recovery[0],
              })
            ).status,
            401,
          )
          assert.equal(
            (
              await local.request('/auth/factor/verify', {
                method: 'recovery',
                code: recovery.shift(),
              })
            ).status,
            200,
          )
          const reauthResponse = await local.request('/auth/security/reauth', {
            password,
          })
          assert.equal(reauthResponse.status, 200)
          assert.equal(
            (
              await local.request('/auth/factor/verify', {
                method: 'recovery',
                code: recovery.shift(),
              })
            ).status,
            200,
          )
          for (const [key, value] of local.jar) remote.jar.set(key, value)
          assert.equal(
            (await remote.request('/auth/security/enroll', { method: 'totp' }))
              .status,
            401,
          )
          await pool.query('DELETE FROM login_attempts')
        },
      )
      await t.test(
        'recovery codes are consumed once even under concurrent logins',
        async () => {
          const a = await login(),
            b = await login(),
            code = recovery.shift()
          const attempts = await Promise.all(
            [a.c, b.c].map((c) =>
              c.request('/auth/factor/verify', { method: 'recovery', code }),
            ),
          )
          assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 401])
        },
      )
      await t.test(
        'TOTP enables only after verification; multiple methods and concurrent replay protection work',
        async () => {
          await reauth()
          const begin = await owner.request('/auth/security/enroll', {
            method: 'totp',
          })
          assert.equal(begin.status, 200)
          const { secret, uri } = await begin.json()
          assert.match(uri, /^otpauth:\/\/totp\//)
          const totp = new OTPAuth.TOTP({
            secret: OTPAuth.Secret.fromBase32(secret),
          })
          const complete = await owner.request('/auth/security/confirm', {
            code: totp.generate(),
          })
          assert.equal(complete.status, 200, await complete.clone().text())
          const stored = (
            await pool.query('SELECT totp_secret FROM users WHERE id=$1', [
              userID,
            ])
          ).rows[0].totp_secret
          assert.notEqual(stored, secret)
          assert.equal(decryptSecret(stored), secret)
          assert.deepEqual(
            (await (await owner.request('/auth/security')).json()).methods,
            ['email', 'totp'],
          )
          const a = await login(),
            b = await login()
          const code = totp.generate({ timestamp: Date.now() + 30000 })
          const results = await Promise.all(
            [a.c, b.c].map((c) =>
              c.request('/auth/factor/verify', { method: 'totp', code }),
            ),
          )
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 401])
        },
      )
      await t.test(
        'password/version changes, expiration, attempts and disabled users invalidate pending authentication',
        async () => {
          for (const change of [
            'security_version=security_version+1',
            "password_hash='changed'",
            'disabled=true',
          ]) {
            const { c } = await login()
            await pool.query(`UPDATE users SET ${change} WHERE id=$1`, [userID])
            assert.equal(
              (
                await c.request('/auth/factor/verify', {
                  method: 'recovery',
                  code: recovery[0],
                })
              ).status,
              401,
            )
            await pool.query(
              'UPDATE users SET password_hash=$1,disabled=false WHERE id=$2',
              [await hashPassword(password), userID],
            )
          }
          const { c } = await login()
          await pool.query(
            "UPDATE auth_pending SET expires=now()-interval '1 second'",
          )
          assert.equal(
            (
              await c.request('/auth/factor/verify', {
                method: 'recovery',
                code: recovery[0],
              })
            ).status,
            401,
          )
          const next = await login()
          for (let i = 0; i < 5; i++)
            assert.equal(
              (
                await next.c.request('/auth/factor/verify', {
                  method: 'recovery',
                  code: 'wrong',
                })
              ).status,
              401,
            )
          assert.equal(
            (
              await next.c.request('/auth/factor/verify', {
                method: 'recovery',
                code: recovery[0],
              })
            ).status,
            401,
          )
          await pool.query('DELETE FROM login_attempts')
        },
      )
      await t.test(
        'recovery regeneration invalidates previous codes and disabling all factors permits password-only login',
        async () => {
          // Reauthenticate with the current password after the explicit invalidation tests.
          const loginResult = await login()
          const logged = await loginResult.c.request('/auth/factor/verify', {
            method: 'recovery',
            code: recovery.shift(),
          })
          assert.equal(logged.status, 200)
          const c = loginResult.c
          await reauth(c)
          const old = recovery[0]
          const regenerate = await c.request(
            '/auth/security/recovery-codes',
            {},
          )
          assert.equal(regenerate.status, 200, await regenerate.clone().text())
          recovery = (await regenerate.json()).recoveryCodes
          assert.equal(
            (
              await pool.query('SELECT 1 FROM recovery_codes WHERE hash=$1', [
                digest(old!),
              ])
            ).rowCount,
            0,
          )
          await reauth(c)
          assert.equal(
            (await c.request('/auth/security/remove', { method: 'all' }))
              .status,
            200,
          )
          assert.equal(
            (await pool.query('SELECT 1 FROM recovery_codes')).rowCount,
            0,
          )
          assert.equal((await login()).result.status, 'authenticated')
        },
      )
      await t.test(
        'administrator and CLI recovery clear all factors and issue password-only invitations',
        async () => {
          const { c } = await login()
          const id = randomUUID()
          await pool.query(
            "INSERT INTO users(id,username,password_hash,email_2fa,email,totp_secret) VALUES($1,'recover',$2,true,'recover@example.com',$3)",
            [
              id,
              await hashPassword(password),
              encryptSecret(newTotp('recover').secret.base32),
            ],
          )
          const reset = await c.request(`/admin/users/${id}/enrollment`, {})
          assert.equal(reset.status, 200, await reset.clone().text())
          let user = (await pool.query('SELECT * FROM users WHERE id=$1', [id]))
            .rows[0]
          assert.equal(user.password_hash, null)
          assert.equal(user.totp_secret, null)
          assert.equal(user.email_2fa, false)
          const invitation = new URL(
            (await reset.json()).enrollmentUrl,
          ).hash.slice(1)
          assert.equal(
            (await c.request('/auth/enroll', { token: invitation, password }))
              .status,
            200,
          )
          const cli = await promisify(execFile)(
            process.execPath,
            ['--import', 'tsx', 'src/cli.ts', 'recover', 'recover'],
            { env: { ...process.env, DATABASE_URL: url.href } },
          )
          assert.match(cli.stdout, /\/enroll#/)
          user = (await pool.query('SELECT * FROM users WHERE id=$1', [id]))
            .rows[0]
          assert.equal(user.password_hash, null)
          assert.equal(user.passkey_2fa, false)
        },
      )
    } finally {
      await pool.end()
      await new Promise<void>((resolve) => smtp.close(resolve))
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      await database.end()
    }
  },
)
