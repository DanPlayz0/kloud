import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHmac } from 'node:crypto'
import pg from 'pg'
import { EventEmitter } from 'node:events'
test(
  'platform drafts, masked secrets, queue deduplication, rollback, domains and runtime permissions',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
    const schema = `platform_${randomUUID().replaceAll('-', '')}`
    await db.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    process.env.PLATFORM_ENCRYPTION_KEY = 'cd'.repeat(32)
    const { pool } = await import('./db.js'),
      { migrate } = await import('./migrate.js'),
      { app } = await import('./app.js'),
      { digest, token, publicOrigin } = await import('./security.js')
    const admin = randomUUID(),
      member = randomUUID(),
      host = randomUUID(),
      credential = token(),
      adminSession = token(),
      memberSession = token()
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      session = adminSession,
    ) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: `session=${session}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const machine = (path: string, body: unknown = {}) =>
      app.request(`/connectors/platform/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    try {
      await migrate()
      await migrate()
      await pool.query(
        "INSERT INTO users(id,username,admin) VALUES($1,'admin',true),($2,'member',false)",
        [admin, member],
      )
      await pool.query(
        "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')",
        [digest(adminSession), admin, digest(memberSession), member],
      )
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('demo','Demo'); INSERT INTO services(project_slug,slug,name,type) VALUES('demo','web','Web','application')",
      )
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'demo','member')",
        [member],
      )
      await pool.query(
        "INSERT INTO service_grants(user_id,project_slug,capability,service) VALUES($1,'demo','read','web')",
        [member],
      )
      await pool.query(
        "INSERT INTO connectors(id,name,token,capabilities,seen,docker_seen) VALUES($1,'Host',$2,ARRAY['deploy','runtime','proxy'],now(),now())",
        [host, digest(credential)],
      )
      const base = '/projects/demo/services/web'
      const config = {
        connector_id: host,
        source: {
          type: 'image',
          image: 'nginx:alpine',
          registry: {
            server: 'ghcr.io',
            username: 'user',
            password: 'registry-secret',
          },
        },
        runtime: { environment: { TOKEN: 'top-secret' } },
      }
      assert.equal(
        (
          await request(
            `${base}/configuration`,
            'PUT',
            { config },
            memberSession,
          )
        ).status,
        403,
      )
      const saved = await request(`${base}/configuration`, 'PUT', { config })
      assert.equal(saved.status, 201, await saved.clone().text())
      const revision = ((await saved.json()) as any).id
      assert.equal((await pool.query('SELECT * FROM service_runs')).rowCount, 0)
      const stored = (
        await pool.query('SELECT encrypted_config FROM service_revisions')
      ).rows[0].encrypted_config
      assert.ok(!stored.includes('top-secret'))
      const masked = (await (
        await request(`${base}/configuration/${revision}`)
      ).json()) as any
      assert.equal(masked.runtime.environment.TOKEN, '********')
      assert.equal(masked.source.registry.password, '********')
      assert.equal(
        (
          await request(
            `${base}/configuration/${revision}`,
            'GET',
            undefined,
            memberSession,
          )
        ).status,
        403,
      )
      const key = randomUUID()
      const first = await request(`${base}/deploy`, 'POST', {
        revision,
        request_key: key,
      })
      assert.equal(first.status, 202)
      assert.equal(
        (
          await request(`${base}/deploy`, 'POST', {
            revision,
            request_key: key,
          })
        ).status,
        202,
      )
      assert.equal((await pool.query('SELECT * FROM service_runs')).rowCount, 1)
      const claimed = await machine('claim')
      assert.equal(claimed.status, 200, await claimed.clone().text())
      const job = ((await claimed.json()) as any).job
      assert.equal(job.config.runtime.environment.TOKEN, 'top-secret')
      assert.equal(((await (await machine('claim')).json()) as any).job, null)
      assert.equal((await request(base, 'DELETE')).status, 409)
      assert.equal(
        (
          await machine(`${job.id}/result`, {
            status: 'succeeded',
            log: 'top-secret registry-secret',
            artifacts: { image: 'sha256:abc' },
          })
        ).status,
        200,
      )
      const history = (await (
        await request(`${base}/configuration`)
      ).json()) as any
      assert.equal(history.runs[0].log, '[redacted] [redacted]')
      assert.equal(
        (
          await request(`${base}/deploy`, 'POST', {
            revision,
            request_key: randomUUID(),
            rollback: job.id,
          })
        ).status,
        202,
      )
      const target = 'a'.repeat(64)
      await pool.query(
        'INSERT INTO inventory(connector_id,container_id,data) VALUES($1,$2,$3)',
        [
          host,
          target,
          {
            id: target,
            name: 'dedi-demo-web',
            project: 'demo',
            application: 'web',
            state: 'running',
            cpu: 0,
            memory: 0,
            memoryLimit: 0,
          },
        ],
      )
      const operation = `/projects/demo/containers/${host}/${target}/operation`
      assert.equal(
        (await request(operation, 'POST', { action: 'logs' }, memberSession))
          .status,
        403,
      )
      const { registerRpc, acceptRpc } = await import('./connector-rpc.js')
      const socket = Object.assign(new EventEmitter(), {
        readyState: 1,
        send(data: string) {
          const message = JSON.parse(data)
          queueMicrotask(() =>
            acceptRpc(host, {
              id: message.id,
              result: { output: 'hello from container' },
            }),
          )
        },
      })
      registerRpc(host, socket as any)
      await pool.query(
        "INSERT INTO container_grants(id,user_id,project_slug,capability,kind,connector_id,target) VALUES($1,$2,'demo','logs','id',$3,$4)",
        [randomUUID(), member, host, target],
      )
      assert.equal(
        (await request(operation, 'POST', { action: 'logs' }, memberSession))
          .status,
        200,
      )
      assert.equal(
        (await request(operation, 'POST', { action: 'restart' }, memberSession))
          .status,
        403,
      )
      const logs = await request(
        operation.replace('/operation', '/logs'),
        'GET',
        undefined,
        memberSession,
      )
      assert.equal(logs.headers.get('x-accel-buffering'), 'no')
      const reader = logs.body!.getReader()
      const firstEvent = await reader.read()
      assert.match(
        new TextDecoder().decode(firstEvent.value),
        /hello from container/,
      )
      await pool.query(
        "DELETE FROM container_grants WHERE user_id=$1 AND capability='logs'",
        [member],
      )
      const ended = await reader.read()
      assert.match(new TextDecoder().decode(ended.value), /unavailable/)
      await reader.cancel()
      socket.emit('close')

      const gitConfig = {
        connector_id: host,
        source: {
          type: 'github',
          config: {
            connector_id: host,
            container_name: 'dedi-demo-web',
            repository: 'owner/repository',
            branch: 'main',
            kind: 'dockerfile',
            build_file: 'Dockerfile',
            context: '.',
            service: 'app',
            enabled: true,
            managed: true,
          },
        },
        runtime: {},
      }
      const gitSaved = await request(`${base}/configuration`, 'PUT', {
        config: gitConfig,
      })
      assert.equal(gitSaved.status, 201, await gitSaved.clone().text())
      const gitRevision = ((await gitSaved.json()) as any).id
      const hook = (await pool.query('SELECT * FROM deployments')).rows[0]
      assert.equal(
        hook.config.enabled,
        false,
        'saving a draft must not activate a webhook',
      )
      assert.equal(
        (
          await request(`${base}/deploy`, 'POST', {
            revision: gitRevision,
            request_key: randomUUID(),
            commit: 'b'.repeat(40),
          })
        ).status,
        202,
      )
      const payload = JSON.stringify({
        ref: 'refs/heads/main',
        after: 'c'.repeat(40),
        repository: { full_name: 'owner/repository' },
      })
      const hookRequest = () =>
        app.request(`/hooks/github/${hook.id}`, {
          method: 'POST',
          headers: {
            'x-github-event': 'push',
            'x-github-delivery': 'delivery-1',
            'x-hub-signature-256': `sha256=${createHmac('sha256', hook.webhook_secret).update(payload).digest('hex')}`,
          },
          body: payload,
        })
      assert.equal((await hookRequest()).status, 202)
      assert.equal((await hookRequest()).status, 202)
      assert.equal(
        (
          await pool.query('SELECT 1 FROM service_runs WHERE commit=$1', [
            'c'.repeat(40),
          ])
        ).rowCount,
        1,
      )
      const domain = {
        connector_id: host,
        config: {
          hostname: 'app.example.com',
          container: 'dedi-demo-web',
          network: 'app',
          port: 80,
        },
      }
      assert.equal(
        (await request(`${base}/domains`, 'POST', domain)).status,
        201,
      )
      assert.equal(
        (await request(`${base}/domains`, 'POST', domain)).status,
        409,
      )
      const proxy = (await (
        await machine('proxy', { applied: null, error: null })
      ).json()) as any
      assert.equal(proxy.routes.length, 1)
      assert.equal(proxy.desired.length, 64)
      await pool.query('UPDATE connectors SET revoked=true WHERE id=$1', [host])
      assert.equal((await machine('claim')).status, 401)
    } finally {
      await pool.end()
      await db.query(`DROP SCHEMA ${schema} CASCADE`)
      await db.end()
    }
  },
)
