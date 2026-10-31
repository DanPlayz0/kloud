import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import {
  platformConfigSchema,
  runtimeRequestSchema,
  domainSchema,
} from '@dedi-dash/protocol/platform'
import { pool, transaction } from './db.js'
import { requireUser, currentUser, type Env, type User } from './auth.js'
import { streamSSE } from 'hono/streaming'
import { demandService, serviceAccess } from './service-permissions.js'
import { permissionTransaction, projectAccess } from './permissions.js'
import { inventoryQuery } from './dashboard.js'
import { connectorRpc } from './connector-rpc.js'
import { seal, unseal, redact } from './platform-secrets.js'
import { digest, token } from './security.js'

export const platform = new Hono<Env>()
platform.use('*', requireUser)
const base = '/projects/:project/services/:service'
const uuid = z.string().uuid()
platform.get('/projects/:project/hosts', async (c) => {
  await projectAccess(c.get('user'), c.req.param('project'))
  // Host selection is only useful for users allowed to create or deploy services.
  const access = await serviceAccess(c.get('user'), c.req.param('project'))
  const grants = await pool.query(
    "SELECT 1 FROM service_grants WHERE user_id=$1 AND project_slug=$2 AND capability='deploy'",
    [c.get('user').id, c.req.param('project')],
  )
  if (!access.allows('create') && !access.allows('deploy') && !grants.rowCount)
    throw new HTTPException(403)
  return c.json(
    (
      await pool.query(
        'SELECT id,name,host,seen,capabilities FROM connectors WHERE NOT revoked ORDER BY name',
      )
    ).rows,
  )
})
platform.get(`${base}/configuration`, async (c) => {
  await demandService(
    c.get('user'),
    c.req.param('project'),
    'read',
    c.req.param('service'),
  )
  const rows = (
    await pool.query(
      'SELECT id,created FROM service_revisions WHERE project=$1 AND service=$2 ORDER BY created DESC,id DESC LIMIT 30',
      [c.req.param('project'), c.req.param('service')],
    )
  ).rows
  const runs = (
    await pool.query(
      `SELECT r.id,r.revision,r.status,r.created,r.finished,r.log,r.artifacts FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE v.project=$1 AND v.service=$2 ORDER BY r.created DESC,r.id DESC LIMIT 30`,
      [c.req.param('project'), c.req.param('service')],
    )
  ).rows
  return c.json({ revisions: rows, runs })
})
platform.get(`${base}/configuration/:revision`, async (c) => {
  await demandService(
    c.get('user'),
    c.req.param('project'),
    'deploy',
    c.req.param('service'),
  )
  const row = (
    await pool.query(
      'SELECT encrypted_config FROM service_revisions WHERE id=$1 AND project=$2 AND service=$3',
      [
        uuid.parse(c.req.param('revision')),
        c.req.param('project'),
        c.req.param('service'),
      ],
    )
  ).rows[0]
  if (!row) throw new HTTPException(404)
  const config = unseal(row.encrypted_config)
  // Configuration is write-only for secrets. Editing preserves masked values server-side.
  for (const key of Object.keys(config.runtime.environment))
    config.runtime.environment[key] = '********'
  if (config.source.registry) config.source.registry.password = '********'
  if (config.source.type === 'compose') config.source.content = '********'
  return c.json(config)
})
platform.put(`${base}/configuration`, async (c) => {
  const body = z
    .object({ config: platformConfigSchema, previous: uuid.optional() })
    .strict()
    .parse(await c.req.json())
  const id = randomUUID()
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    const connector = (
      await db.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [body.config.connector_id],
      )
    ).rows[0]
    if (!connector?.capabilities.includes('deploy'))
      throw new HTTPException(409, {
        message: 'Choose a host with deployment support enabled',
      })
    const service = (
      await db.query(
        'SELECT type FROM services WHERE project_slug=$1 AND slug=$2',
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    const compose =
      body.config.source.type === 'compose' ||
      (body.config.source.type === 'github' &&
        body.config.source.config.kind === 'compose')
    if ((service.type === 'compose') !== compose)
      throw new HTTPException(400, {
        message: 'Source must match the service type',
      })
    if (body.previous) {
      const old = (
        await db.query(
          'SELECT encrypted_config FROM service_revisions WHERE id=$1 AND project=$2 AND service=$3',
          [body.previous, c.req.param('project'), c.req.param('service')],
        )
      ).rows[0]
      if (!old) throw new HTTPException(404)
      const config = unseal(old.encrypted_config)
      if (
        body.config.source.type === 'compose' &&
        body.config.source.content === '********'
      ) {
        if (config.source.type !== 'compose') throw new HTTPException(400)
        body.config.source.content = config.source.content
      }
      for (const [key, value] of Object.entries(
        body.config.runtime.environment,
      ))
        if (value === '********') {
          if (!(key in config.runtime.environment))
            throw new HTTPException(400, {
              message: 'Masked variable has no previous value',
            })
          body.config.runtime.environment[key] = config.runtime.environment[key]
        }
      if (
        body.config.source.type === 'image' &&
        body.config.source.registry?.password === '********'
      ) {
        if (!config.source.registry) throw new HTTPException(400)
        body.config.source.registry.password = config.source.registry.password
      }
    }
    await db.query(
      'INSERT INTO service_revisions(id,project,service,encrypted_config,source_label,connector_id) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        c.req.param('project'),
        c.req.param('service'),
        seal(body.config),
        body.config.source.type === 'image'
          ? body.config.source.image
          : body.config.source.type === 'compose'
            ? 'Pasted Compose'
            : body.config.source.config.repository,
        body.config.connector_id,
      ],
    )
    if (body.config.source.type === 'github') {
      const git = {
        ...body.config.source.config,
        managed: true,
        connector_id: body.config.connector_id,
        container_name: `dedi-${c.req.param('project')}-${c.req.param('service')}`,
      }
      await db.query(
        'INSERT INTO deployments(id,project,application,connector_id,config,webhook_secret,service_revision) VALUES($1,$2,$3,$4,$5,$6,NULL) ON CONFLICT(project,application) DO NOTHING',
        [
          randomUUID(),
          c.req.param('project'),
          c.req.param('service'),
          body.config.connector_id,
          { ...git, enabled: false },
          token(),
        ],
      )
    }
  })
  return c.json({ id }, 201)
})
platform.post(`${base}/deploy`, async (c) => {
  const body = z
    .object({
      revision: uuid,
      request_key: uuid,
      commit: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .optional(),
      rollback: uuid.optional(),
    })
    .strict()
    .parse(await c.req.json())
  const id = await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    const row = (
      await db.query(
        'SELECT * FROM service_revisions WHERE id=$1 AND project=$2 AND service=$3 FOR UPDATE',
        [body.revision, c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    if (!row) throw new HTTPException(404)
    const config = unseal(row.encrypted_config)
    const activeHost = (
      await db.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [config.connector_id],
      )
    ).rows[0]
    if (!activeHost?.capabilities.includes('deploy'))
      throw new HTTPException(409, {
        message:
          'The deployment host is revoked or no longer supports deployments',
      })
    if (config.source.type === 'github' && !body.commit && !body.rollback)
      throw new HTTPException(400, {
        message: 'Enter a full commit SHA for Git deployments',
      })
    if (body.rollback) {
      const old = (
        await db.query(
          "SELECT r.artifacts,r.revision FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE r.id=$1 AND v.project=$2 AND v.service=$3 AND r.status='succeeded'",
          [body.rollback, c.req.param('project'), c.req.param('service')],
        )
      ).rows[0]
      if (!old || old.revision !== body.revision || !old.artifacts)
        throw new HTTPException(400, {
          message:
            'Choose the revision of a successful deployment for rollback',
        })
    }
    const existing = (
      await db.query(
        'SELECT r.id FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE r.request_key=$1 AND v.project=$2 AND v.service=$3',
        [body.request_key, c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    if (existing) return existing.id
    if (config.source.type === 'github') {
      const git = {
        ...config.source.config,
        managed: true,
        connector_id: config.connector_id,
        container_name: `dedi-${c.req.param('project')}-${c.req.param('service')}`,
      }
      await db.query(
        'UPDATE deployments SET connector_id=$1,config=$2,service_revision=$3 WHERE project=$4 AND application=$5',
        [
          config.connector_id,
          git,
          row.id,
          c.req.param('project'),
          c.req.param('service'),
        ],
      )
    } else {
      await db.query(
        "UPDATE deployments SET config=jsonb_set(config,'{enabled}','false'),service_revision=NULL WHERE project=$1 AND application=$2",
        [c.req.param('project'), c.req.param('service')],
      )
    }
    const run = randomUUID()
    const artifacts = body.rollback
      ? (
          await db.query('SELECT artifacts FROM service_runs WHERE id=$1', [
            body.rollback,
          ])
        ).rows[0].artifacts
      : null
    await db.query(
      'INSERT INTO service_runs(id,revision,connector_id,request_key,artifacts,commit) VALUES($1,$2,$3,$4,$5,$6)',
      [
        run,
        row.id,
        config.connector_id,
        body.request_key,
        artifacts,
        body.commit ?? null,
      ],
    )
    return run
  })
  return c.json({ id }, 202)
})

export async function containerPermission(
  user: User,
  project: string,
  connector: string,
  container: string,
  capability: string,
) {
  const access = await projectAccess(user, project)
  const row = (
    await pool.query(
      `SELECT * FROM (${inventoryQuery}) inventory WHERE project=$1 AND connector_id=$2 AND container_id=$3`,
      [project, connector, container],
    )
  ).rows[0]
  if (!row) throw new HTTPException(404, { message: 'Container not found' })
  if (!access.can_manage_access) {
    const allowed = await pool.query(
      `SELECT 1 FROM container_grants WHERE user_id=$1 AND project_slug=$2 AND capability=$3 AND (kind='all' OR (connector_id=$4 AND ((kind='id' AND target=$5) OR (kind='name' AND target=$6))))`,
      [user.id, project, capability, connector, container, row.data.name],
    )
    if (!allowed.rowCount)
      throw new HTTPException(403, {
        message: `${capability} permission required`,
      })
  }
  if (row.stale)
    throw new HTTPException(409, { message: 'Host inventory is stale' })
  return row
}
platform.get(
  '/projects/:project/containers/:connector/:container/logs',
  async (c) => {
    const connector = uuid.parse(c.req.param('connector')),
      container = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(c.req.param('container'))
    await containerPermission(
      c.get('user'),
      c.req.param('project'),
      connector,
      container,
      'logs',
    )
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        try {
          const user = await currentUser(c)
          if (!user) throw new HTTPException(401)
          const row = await containerPermission(
            user,
            c.req.param('project'),
            connector,
            container,
            'logs',
          )
          const host = (
            await pool.query(
              'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
              [connector],
            )
          ).rows[0]
          if (!host?.capabilities.includes('runtime'))
            throw new HTTPException(409)
          const result = await connectorRpc(connector, {
            kind: 'runtime',
            action: 'logs',
            container,
            owner: user.id,
            project: row.project,
            application: row.application,
          })
          const current = await currentUser(c)
          if (!current) throw new HTTPException(401)
          await containerPermission(
            current,
            c.req.param('project'),
            connector,
            container,
            'logs',
          )
          if (!stream.aborted)
            await stream.writeSSE({ data: JSON.stringify(result) })
        } catch {
          if (!stream.aborted)
            await stream.writeSSE({
              event: 'unavailable',
              data: 'Log access ended or host unavailable',
            })
          break
        }
        await stream.sleep(1500)
      }
    })
  },
)
platform.get(
  '/projects/:project/containers/:connector/:container/permissions',
  async (c) => {
    const connector = uuid.parse(c.req.param('connector')),
      container = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(c.req.param('container'))
    await projectAccess(c.get('user'), c.req.param('project'))
    const host = (
      await pool.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [connector],
      )
    ).rows[0]
    const permissions: Record<string, boolean> = {
      available: !!host?.capabilities.includes('runtime'),
    }
    for (const capability of [
      'logs',
      'lifecycle',
      'terminal',
      'configuration',
    ]) {
      try {
        await containerPermission(
          c.get('user'),
          c.req.param('project'),
          connector,
          container,
          capability,
        )
        permissions[capability] = permissions.available!
      } catch {
        permissions[capability] = false
      }
    }
    return c.json(permissions)
  },
)
platform.post(
  '/projects/:project/containers/:connector/:container/operation',
  async (c) => {
    const body = runtimeRequestSchema.parse(await c.req.json())
    const capability = body.action.startsWith('terminal-')
      ? 'terminal'
      : body.action === 'logs'
        ? 'logs'
        : body.action === 'inspect'
          ? 'configuration'
          : 'lifecycle'
    const connector = uuid.parse(c.req.param('connector')),
      container = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(c.req.param('container'))
    const row = await containerPermission(
      c.get('user'),
      c.req.param('project'),
      connector,
      container,
      capability,
    )
    const host = (
      await pool.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [connector],
      )
    ).rows[0]
    if (!host?.capabilities.includes('runtime'))
      throw new HTTPException(409, {
        message: 'Runtime operations are not enabled on this host',
      })
    const result = await connectorRpc(connector, {
      kind: 'runtime',
      ...body,
      container,
      project: row.project,
      application: row.application,
      owner: c.get('user').id,
    })
    // Recheck grants after waiting for a host, before returning logs or terminal output.
    await containerPermission(
      c.get('user'),
      c.req.param('project'),
      connector,
      container,
      capability,
    )
    return c.json(result)
  },
)
platform.get(`${base}/domains`, async (c) => {
  await demandService(
    c.get('user'),
    c.req.param('project'),
    'read',
    c.req.param('service'),
  )
  return c.json(
    (
      await pool.query(
        "SELECT d.*,s.desired,s.applied,s.error FROM service_domains d LEFT JOIN proxy_status s USING(connector_id) WHERE d.project=$1 AND d.service=$2 ORDER BY d.config->>'hostname'",
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows,
  )
})
platform.post(`${base}/domains`, async (c) => {
  const body = z
    .object({ connector_id: uuid, config: domainSchema })
    .strict()
    .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    const host = (
      await db.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [body.connector_id],
      )
    ).rows[0]
    if (!host?.capabilities.includes('proxy'))
      throw new HTTPException(409, {
        message: 'Managed NGINX is not enabled on this host',
      })
    const peers = (
      await db.query(
        "SELECT connector_id,config FROM service_domains WHERE config->>'hostname'=$1",
        [body.config.hostname],
      )
    ).rows
    if (
      peers.some(
        (peer) =>
          peer.connector_id !== body.connector_id ||
          peer.config.https !== body.config.https ||
          peer.config.redirect !== body.config.redirect,
      )
    )
      throw new HTTPException(409, {
        message: 'Routes for a hostname must share one host and HTTPS policy',
      })
    const target = (
      await db.query(
        `SELECT 1 FROM (${inventoryQuery}) inventory WHERE project=$1 AND application=$2 AND connector_id=$3 AND data->>'name'=$4`,
        [
          c.req.param('project'),
          c.req.param('service'),
          body.connector_id,
          body.config.container,
        ],
      )
    ).rowCount
    if (!target)
      throw new HTTPException(400, {
        message: 'Choose a running container assigned to this service',
      })
    await db.query(
      'INSERT INTO service_domains(id,project,service,connector_id,config) VALUES($1,$2,$3,$4,$5)',
      [
        randomUUID(),
        c.req.param('project'),
        c.req.param('service'),
        body.connector_id,
        body.config,
      ],
    )
  })
  return c.json({ saved: true }, 201)
})
platform.delete(`${base}/domains/:id`, async (c) => {
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    await db.query(
      'DELETE FROM service_domains WHERE id=$1 AND project=$2 AND service=$3',
      [
        uuid.parse(c.req.param('id')),
        c.req.param('project'),
        c.req.param('service'),
      ],
    )
  })
  return c.json({ removed: true })
})

export const platformWorker = new Hono<{ Variables: { connector: string } }>()
platformWorker.use('/connectors/platform/*', async (c, next) => {
  const value = c.req
    .header('authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
  const row = value
    ? (
        await pool.query(
          'SELECT id FROM connectors WHERE token=$1 AND NOT revoked',
          [digest(value)],
        )
      ).rows[0]
    : null
  if (!row) throw new HTTPException(401)
  c.set('connector', row.id)
  await next()
})
platformWorker.post('/connectors/platform/claim', async (c) => {
  const connector = c.get('connector')
  const job = await transaction(async (db) => {
    if (
      !(
        await db.query(
          'SELECT id FROM connectors WHERE id=$1 AND NOT revoked FOR UPDATE',
          [connector],
        )
      ).rowCount
    )
      throw new HTTPException(401)
    await db.query(
      "UPDATE service_runs SET status='failed',finished=now(),log='Worker disconnected; inspect host before retrying' WHERE connector_id=$1 AND status='running' AND started < now()-interval '40 minutes'",
      [connector],
    )
    if (
      (
        await db.query(
          "SELECT 1 FROM service_runs WHERE connector_id=$1 AND status='running' UNION ALL SELECT 1 FROM deployment_builds b JOIN deployments d ON d.id=b.deployment_id WHERE d.connector_id=$1 AND b.status='running'",
          [connector],
        )
      ).rowCount
    )
      return null
    const row = (
      await db.query(
        "SELECT r.*,v.project,v.service,v.encrypted_config FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE r.connector_id=$1 AND r.status='queued' ORDER BY r.created,r.id LIMIT 1 FOR UPDATE OF r,v",
        [connector],
      )
    ).rows[0]
    if (!row) return null
    await db.query(
      "UPDATE service_runs SET status='running',started=now() WHERE id=$1",
      [row.id],
    )
    const { encrypted_config, ...rest } = row
    return { ...rest, config: unseal(encrypted_config) }
  })
  return c.json({ job })
})
platformWorker.post('/connectors/platform/:id/result', async (c) => {
  const result = z
    .object({
      status: z.enum(['succeeded', 'failed']),
      log: z.string().max(48000),
      artifacts: z.record(z.string(), z.string().max(500)).nullable(),
    })
    .strict()
    .parse(await c.req.json())
  const connector = c.get('connector')
  const row = (
    await pool.query(
      'SELECT v.encrypted_config FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE r.id=$1 AND r.connector_id=$2',
      [uuid.parse(c.req.param('id')), connector],
    )
  ).rows[0]
  if (!row) throw new HTTPException(404)
  await pool.query(
    "UPDATE service_runs SET status=$1,log=$2,artifacts=$3,finished=now() WHERE id=$4 AND connector_id=$5 AND status='running'",
    [
      result.status,
      redact(result.log, unseal(row.encrypted_config)),
      result.artifacts,
      c.req.param('id'),
      connector,
    ],
  )
  return c.json({ ok: true })
})
platformWorker.post('/connectors/platform/proxy', async (c) => {
  const connector = c.get('connector')
  const report = z
    .object({
      applied: z.string().max(64).nullable(),
      error: z.string().max(500).nullable(),
    })
    .strict()
    .parse(await c.req.json())
  const routes = (
    await pool.query(
      'SELECT project,service,config FROM service_domains WHERE connector_id=$1 ORDER BY id',
      [connector],
    )
  ).rows
  const desired = createHash('sha256')
    .update(JSON.stringify(routes))
    .digest('hex')
  await pool.query(
    'INSERT INTO proxy_status(connector_id,desired,applied,error) VALUES($1,$2,$3,$4) ON CONFLICT(connector_id) DO UPDATE SET desired=$2,applied=$3,error=$4,updated=now()',
    [connector, desired, report.applied, report.error],
  )
  return c.json({ routes, desired })
})
