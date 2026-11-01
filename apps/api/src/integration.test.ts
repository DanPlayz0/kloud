import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  randomUUID,
  randomBytes,
  generateKeyPairSync,
  createHash,
  sign,
} from 'node:crypto'
import pg from 'pg'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import WebSocket from 'ws'
import { serve } from '@hono/node-server'

test(
  'PostgreSQL, passkeys, access control, assignments and connector integration',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = `verify_${randomUUID().replaceAll('-', '')}`
    await database.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js')
    const { migrate } = await import('./migrate.js')
    const { app } = await import('./app.js')
    const { token, digest, publicOrigin, rpID } = await import('./security.js')
    const { acceptSnapshot, attachConnectors } = await import('./connectors.js')
    const adminID = randomUUID(),
      memberID = randomUUID(),
      strangerID = randomUUID()
    const invitation = token()
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      cookie = '',
    ) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          'content-type': 'application/json',
          cookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const cookie = (response: Response, name: string) =>
      response.headers
        .getSetCookie()
        .find((c) => c.startsWith(name + '='))!
        .split(';')[0]!
    let adminCookie = '',
      memberCookie = ''
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })
    const jwk = publicKey.export({ format: 'jwk' }),
      credentialID = randomBytes(32),
      keyID = credentialID.toString('base64url')
    const rpHash = createHash('sha256').update(rpID).digest()
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
      ]),
    )
    function registration(challenge: string, origin = publicOrigin) {
      const length = Buffer.alloc(2)
      length.writeUInt16BE(credentialID.length)
      const authData = Buffer.concat([
        rpHash,
        Buffer.from([0x45]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        credentialID,
        Buffer.from(cose),
      ])
      const attestationObject = isoCBOR.encode(
        new Map<string, any>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', new Uint8Array(authData)],
        ]),
      )
      return {
        id: keyID,
        rawId: keyID,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: Buffer.from(
            JSON.stringify({ type: 'webauthn.create', challenge, origin }),
          ).toString('base64url'),
          attestationObject:
            Buffer.from(attestationObject).toString('base64url'),
          transports: ['internal'],
        },
      }
    }
    function assertion(challenge: string, origin = publicOrigin) {
      const counter = Buffer.alloc(4)
      counter.writeUInt32BE(1)
      const authenticatorData = Buffer.concat([
        rpHash,
        Buffer.from([5]),
        counter,
      ])
      const clientData = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', challenge, origin }),
      )
      const signature = sign(
        'sha256',
        Buffer.concat([
          authenticatorData,
          createHash('sha256').update(clientData).digest(),
        ]),
        privateKey,
      )
      return {
        id: keyID,
        rawId: keyID,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      }
    }
    try {
      await t.test(
        'password-only setup creates exactly one administrator',
        async () => {
          await migrate()
          assert.deepEqual(await (await request('/auth/setup')).json(), {
            required: true,
          })
          assert.equal(
            (
              await request('/auth/setup', 'POST', {
                username: 'owner',
                password: 'short',
              })
            ).status,
            400,
          )
          const attempts = await Promise.all(
            [1, 2].map(() =>
              request('/auth/setup', 'POST', {
                username: 'First.Admin',
                password: 'correct horse battery staple',
              }),
            ),
          )
          assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409])
          const users = await pool.query('SELECT * FROM users')
          assert.equal(users.rowCount, 1)
          assert.equal(users.rows[0].username, 'first.admin')
          assert.equal(users.rows[0].admin, true)
          assert.equal((await pool.query('SELECT 1 FROM passkeys')).rowCount, 0)
          assert.deepEqual(await (await request('/auth/setup')).json(), {
            required: false,
          })
          await pool.query('DELETE FROM users')
        },
      )
      await t.test(
        'invitation is single-use; passkey enrollment is optional and verified',
        async () => {
          await migrate()
          await migrate()
          await pool.query(
            "INSERT INTO users(id,username,admin) VALUES($1,'owner',true),($2,'member',false),($3,'stranger',false)",
            [adminID, memberID, strangerID],
          )
          await pool.query(
            "INSERT INTO invitations(token,user_id,expires) VALUES($1,$2,now()+interval '24 hours')",
            [digest(invitation), adminID],
          )
          const attempts = await Promise.all(
            [1, 2].map(() =>
              request('/auth/enroll', 'POST', {
                token: invitation,
                password: 'correct horse battery staple',
              }),
            ),
          )
          assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 400])
          const login = await request('/auth/password', 'POST', {
            username: 'owner',
            password: 'correct horse battery staple',
          })
          assert.deepEqual(await login.json(), { status: 'authenticated' })
          const session = cookie(login, 'session')
          const reauth = await request(
            '/auth/security/reauth',
            'POST',
            { password: 'correct horse battery staple' },
            session,
          )
          const authorized = session + '; ' + cookie(reauth, 'security_grant')
          const begin = await request(
            '/auth/security/enroll',
            'POST',
            { method: 'passkey', name: 'Test device' },
            authorized,
          )
          assert.equal(begin.status, 200, await begin.clone().text())
          const options = (await begin.json()).options
          const complete = await request(
            '/auth/security/confirm',
            'POST',
            { response: registration(options.challenge) },
            authorized + '; ' + cookie(begin, 'factor_enrollment'),
          )
          assert.equal(complete.status, 200, await complete.clone().text())
          assert.equal((await complete.json()).recoveryCodes.length, 10)
          assert.equal((await pool.query('SELECT 1 FROM passkeys')).rowCount, 1)
        },
      )
      await t.test(
        'password alone cannot authenticate; valid passkey issues session and rejects replay',
        async () => {
          const response = await request('/auth/password', 'POST', {
            username: 'owner',
            password: 'correct horse battery staple',
          })
          assert.equal(response.status, 200)
          const pending = cookie(response, 'pending'),
            options = (
              await (
                await request(
                  '/auth/factor/challenge',
                  'POST',
                  { method: 'passkey' },
                  pending,
                )
              ).json()
            ).options
          assert.equal(
            (await request('/auth/me', 'GET', undefined, pending)).status,
            401,
          )
          const verify = await request(
            '/auth/verify',
            'POST',
            assertion(options.challenge),
            pending,
          )
          assert.equal(verify.status, 200, await verify.text())
          adminCookie = cookie(verify, 'session')
          assert.equal(
            (await request('/auth/me', 'GET', undefined, adminCookie)).status,
            200,
          )
          assert.equal(
            (
              await request(
                '/auth/verify',
                'POST',
                assertion(options.challenge),
                pending,
              )
            ).status,
            401,
          )
          const docs = await (
            await request('/openapi.json', 'GET', undefined, adminCookie)
          ).json()
          assert.ok(docs.paths['/projects/{project}/containers'])
        },
      )
      await t.test(
        'expired challenges, invalid credentials and wrong origins cannot log in',
        async () => {
          const expiredInvitation = token()
          await pool.query(
            `INSERT INTO invitations(token,user_id,expires) VALUES($1,$2,now()-interval '1 second')`,
            [digest(expiredInvitation), strangerID],
          )
          assert.equal(
            (
              await request('/auth/enroll', 'POST', {
                token: expiredInvitation,
                password: 'correct horse battery staple',
              })
            ).status,
            400,
          )
          assert.equal(
            (
              await request('/auth/password', 'POST', {
                username: 'owner',
                password: 'wrong',
              })
            ).status,
            401,
          )
          for (const expired of [false, true]) {
            const response = await request('/auth/password', 'POST', {
              username: 'owner',
              password: 'correct horse battery staple',
            })
            const pending = cookie(response, 'pending'),
              options = (
                await (
                  await request(
                    '/auth/factor/challenge',
                    'POST',
                    { method: 'passkey' },
                    pending,
                  )
                ).json()
              ).options
            if (expired)
              await pool.query(
                `UPDATE auth_pending SET expires=now()-interval '1 second'`,
              )
            assert.equal(
              (
                await request(
                  '/auth/verify',
                  'POST',
                  assertion(options.challenge, 'https://wrong.example'),
                  pending,
                )
              ).status,
              401,
            )
          }
        },
      )
      await t.test(
        'membership and super-admin restrictions are enforced by APIs',
        async () => {
          for (const slug of ['your-project-slug', 'private'])
            assert.equal(
              (
                await request(
                  '/admin/projects',
                  'POST',
                  { slug, name: slug },
                  adminCookie,
                )
              ).status,
              201,
            )
          const session = token()
          assert.equal(
            (
              await request(
                '/admin/projects',
                'POST',
                { slug: 'your-project-slug', name: 'Duplicate' },
                adminCookie,
              )
            ).status,
            409,
          )
          await pool.query(
            `INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')`,
            [digest(session), memberID],
          )
          memberCookie = `session=${session}`
          await pool.query(
            `INSERT INTO memberships(user_id,project_slug) VALUES($1,'your-project-slug')`,
            [memberID],
          )
          await pool.query(
            `INSERT INTO container_grants(id,user_id,project_slug,capability,kind) VALUES($1,$2,'your-project-slug','view','all')`,
            [randomUUID(), memberID],
          )
          assert.equal(
            (await request('/admin/users', 'GET', undefined, memberCookie))
              .status,
            403,
          )
          assert.equal(
            (
              await request(
                '/projects/private/containers',
                'GET',
                undefined,
                memberCookie,
              )
            ).status,
            404,
          )
          assert.deepEqual(
            (
              await (
                await request('/projects', 'GET', undefined, memberCookie)
              ).json()
            ).map((p: any) => p.slug),
            ['your-project-slug'],
          )
        },
      )
      let connector: { id: string; token: string }
      const raw = {
        id: 'a'.repeat(64),
        name: 'imgen',
        state: 'running',
        project: 'your-project-slug',
        application: 'imgen',
        cpu: 10,
        memory: 1024,
        memoryLimit: 2048,
      }
      const snapshot = (containers: any[]) => ({
        version: 1,
        type: 'snapshot',
        host: 'docker-host',
        containers,
      })
      await t.test(
        'snapshots, discovery, label precedence, stale hosts and replacement work',
        async () => {
          connector = await (
            await request(
              '/admin/connectors',
              'POST',
              { name: 'test-host' },
              adminCookie,
            )
          ).json()
          await acceptSnapshot(
            connector.id,
            snapshot([
              raw,
              { ...raw, id: 'b'.repeat(64), project: null, application: null },
            ]),
          )
          assert.equal(
            (await pool.query('SELECT count(*) FROM inventory')).rows[0].count,
            '1',
          )
          assert.equal(
            (
              await request(
                '/projects/your-project-slug/applications/imgen',
                'GET',
                undefined,
                memberCookie,
              )
            ).status,
            200,
          )
          assert.equal(
            (
              await request(
                '/projects/private/applications/imgen',
                'GET',
                undefined,
                memberCookie,
              )
            ).status,
            404,
          )
          await request(
            `/admin/connectors/${connector.id}`,
            'PUT',
            { discovery: true, revoked: false },
            adminCookie,
          )
          await acceptSnapshot(
            connector.id,
            snapshot([
              raw,
              { ...raw, id: 'b'.repeat(64), project: null, application: null },
            ]),
          )
          assert.equal(
            (
              await request(
                `/admin/containers/${connector.id}/${raw.id}`,
                'PUT',
                { project: 'private', application: 'override' },
                adminCookie,
              )
            ).status,
            409,
          )
          assert.equal(
            (
              await request(
                `/admin/containers/${connector.id}/${'b'.repeat(64)}`,
                'PUT',
                { project: 'your-project-slug', application: 'manual' },
                adminCookie,
              )
            ).status,
            200,
          )
          let rows = await (
            await request(
              '/projects/your-project-slug/containers',
              'GET',
              undefined,
              memberCookie,
            )
          ).json()
          assert.equal(rows.length, 2)
          await pool.query(
            `UPDATE connectors SET seen=now()-interval '21 seconds',docker_seen=now()-interval '21 seconds' WHERE id=$1`,
            [connector.id],
          )
          rows = await (
            await request(
              '/projects/your-project-slug/containers',
              'GET',
              undefined,
              memberCookie,
            )
          ).json()
          assert.equal(
            rows.every((r: any) => r.stale),
            true,
          )
          await assert.rejects(
            acceptSnapshot(connector.id, snapshot([{ ...raw, cpu: -2 }])),
          )
          assert.equal(
            (await pool.query('SELECT count(*) FROM inventory')).rows[0].count,
            '2',
          )
          await acceptSnapshot(connector.id, snapshot([]))
          const seenBeforeReplacedSnapshot = (
            await pool.query('SELECT seen FROM connectors WHERE id=$1', [
              connector.id,
            ])
          ).rows[0].seen
          assert.equal(
            await acceptSnapshot(connector.id, snapshot([raw]), () => false),
            false,
          )
          assert.equal(
            (await pool.query('SELECT count(*) FROM inventory')).rows[0].count,
            '0',
          )
          assert.equal(
            (
              await pool.query('SELECT seen FROM connectors WHERE id=$1', [
                connector.id,
              ])
            ).rows[0].seen.toISOString(),
            seenBeforeReplacedSnapshot.toISOString(),
          )
          assert.equal(
            (await pool.query('SELECT count(*) FROM assignments')).rows[0]
              .count,
            '0',
          )
        },
      )
      await t.test(
        'WebSocket rejects invalid credentials and accepts authenticated snapshots',
        async () => {
          const server = serve({
            fetch: app.fetch,
            port: 0,
          }) as import('node:http').Server
          const close = attachConnectors(server)
          if (!server.listening)
            await new Promise<void>((resolve) =>
              server.once('listening', resolve),
            )
          const port = (server.address() as import('node:net').AddressInfo).port
          try {
            await new Promise<void>((resolve, reject) => {
              const ws = new WebSocket(`ws://localhost:${port}/connectors/ws`)
              ws.on('unexpected-response', (_, res) => {
                assert.equal(res.statusCode, 401)
                res.resume()
                ws.terminate()
                resolve()
              })
              ws.on('open', () =>
                reject(new Error('Anonymous connection accepted')),
              )
              ws.on('error', () => {})
            })
            await new Promise<void>((resolve, reject) => {
              const ws = new WebSocket(`ws://localhost:${port}/connectors/ws`, {
                headers: { authorization: `Bearer ${connector.token}` },
              })
              ws.on('open', () => ws.send(JSON.stringify(snapshot([raw]))))
              ws.on('message', (data) => {
                assert.equal(JSON.parse(data.toString()).type, 'accepted')
                ws.close()
                resolve()
              })
              ws.on('error', reject)
            })
          } finally {
            close()
            await new Promise<void>((resolve) => server.close(() => resolve()))
          }
          const listedBefore = await request(
            '/admin/connectors',
            'GET',
            undefined,
            adminCookie,
          )
          assert.equal(listedBefore.status, 200)
          assert.ok(
            (await listedBefore.json()).some(
              (c: { id: string }) => c.id === connector.id,
            ),
          )
          const revoked = await request(
            `/admin/connectors/${connector.id}`,
            'PUT',
            { discovery: true, revoked: true },
            adminCookie,
          )
          assert.equal(revoked.status, 200)
          const listedAfter = await request(
            '/admin/connectors',
            'GET',
            undefined,
            adminCookie,
          )
          assert.equal(listedAfter.status, 200)
          assert.ok(
            !(await listedAfter.json()).some(
              (c: { id: string }) => c.id === connector.id,
            ),
          )
          assert.equal(
            await acceptSnapshot(connector.id, snapshot([raw])),
            false,
          )
        },
      )
      await t.test(
        'disabled users, expired sessions and logout invalidate access',
        async () => {
          await pool.query(
            `INSERT INTO login_attempts(key,attempts,expires) VALUES($1,10,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=10,expires=now()+interval '15 minutes'`,
            [digest('owner')],
          )
          assert.equal(
            (
              await request('/auth/password', 'POST', {
                username: 'owner',
                password: 'correct horse battery staple',
              })
            ).status,
            429,
          )
          await request(
            `/admin/users/${memberID}`,
            'PUT',
            { disabled: true, projects: ['your-project-slug'] },
            adminCookie,
          )
          assert.equal(
            (await request('/auth/me', 'GET', undefined, memberCookie)).status,
            401,
          )
          await pool.query(
            `UPDATE sessions SET expires=now()-interval '1 second' WHERE user_id=$1`,
            [adminID],
          )
          assert.equal(
            (await request('/auth/me', 'GET', undefined, adminCookie)).status,
            401,
          )
          const secret = token()
          await pool.query(
            `INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')`,
            [digest(secret), adminID],
          )
          const fresh = `session=${secret}`
          assert.equal(
            (await request('/auth/logout', 'POST', {}, fresh)).status,
            200,
          )
          assert.equal(
            (await request('/auth/me', 'GET', undefined, fresh)).status,
            401,
          )
        },
      )
    } finally {
      await pool.end()
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      await database.end()
    }
  },
)
