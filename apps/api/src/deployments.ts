import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  createHmac,
  createHash,
  timingSafeEqual,
  randomUUID,
} from 'node:crypto'
import { z } from 'zod'
import { deploymentSchema } from '@dedi-dash/protocol'
import { pool, transaction } from './db.js'
import { requireUser, type Env } from './auth.js'
import { permissionTransaction, projectAccess } from './permissions.js'
import { token, digest, publicOrigin } from './security.js'
import { demandService } from './service-permissions.js'
function deliveryKey(deployment: string, delivery: string) {
  const hash = createHash('sha256')
    .update(`${deployment}:${delivery}`)
    .digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export function verifySignature(
  body: Uint8Array,
  secret: string,
  signature = '',
) {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false
  return timingSafeEqual(
    createHmac('sha256', secret).update(body).digest(),
    Buffer.from(signature.slice(7), 'hex'),
  )
}

export const deploymentHooks = new Hono()
deploymentHooks.post('/hooks/github/:id', async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'))
  const deployment = (
    await pool.query('SELECT * FROM deployments WHERE id=$1', [id])
  ).rows[0]
  const raw = new Uint8Array(await c.req.arrayBuffer())
  if (
    !deployment ||
    !verifySignature(
      raw,
      deployment.webhook_secret,
      c.req.header('x-hub-signature-256'),
    )
  )
    return c.json({ error: 'Invalid webhook signature' }, 401)
  const event = c.req.header('x-github-event')
  if (event !== 'push') return c.json({ ignored: true })
  const payload = z
    .object({
      ref: z.string(),
      after: z.string().regex(/^[a-f0-9]{40}$/),
      deleted: z.boolean().optional(),
      repository: z.object({ full_name: z.string() }),
    })
    .parse(JSON.parse(new TextDecoder().decode(raw)))
  const delivery = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9-]+$/)
    .parse(c.req.header('x-github-delivery'))
  const queued = await transaction(async (db) => {
    // Serialize webhook delivery with configuration changes and job claims.
    const current = (
      await db.query('SELECT * FROM deployments WHERE id=$1 FOR UPDATE', [id])
    ).rows[0]
    if (!current || current.webhook_secret !== deployment.webhook_secret)
      return false
    const config = deploymentSchema.parse(current.config)
    if (
      !config.enabled ||
      payload.deleted ||
      payload.after === '0'.repeat(40) ||
      payload.ref !== `refs/heads/${config.branch}` ||
      payload.repository.full_name.toLowerCase() !==
        config.repository.toLowerCase()
    )
      return false
    if (current.service_revision) {
      await db.query(
        `INSERT INTO service_runs(id,revision,connector_id,request_key,commit) VALUES($1,$2,$3,$4,$5) ON CONFLICT(request_key) DO NOTHING`,
        [
          randomUUID(),
          current.service_revision,
          current.connector_id,
          deliveryKey(id, delivery),
          payload.after,
        ],
      )
      return true
    }
    await db.query(
      `INSERT INTO deployment_builds(id,deployment_id,delivery,commit,config)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(deployment_id,delivery) DO NOTHING`,
      [randomUUID(), id, delivery, payload.after, config],
    )
    return true
  })
  return c.json({ queued }, 202)
})

// These endpoints authenticate exclusively with connector credentials, never cookies.
deploymentHooks.use('/connectors/deployments/*', async (c, next) => {
  const credential = c.req
    .header('authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
  if (!credential)
    return c.json({ error: 'Connector credential required' }, 401)
  await next()
})
async function withConnector<T>(
  authorization: string | undefined,
  fn: (db: import('pg').PoolClient, id: string) => Promise<T>,
) {
  return transaction(async (db) => {
    const credential = authorization?.slice(7) ?? ''
    const connector = (
      await db.query(
        'SELECT id FROM connectors WHERE token=$1 AND NOT revoked FOR UPDATE',
        [digest(credential)],
      )
    ).rows[0]
    if (!connector)
      throw new HTTPException(401, { message: 'Connector credential revoked' })
    return fn(db, connector.id)
  })
}
deploymentHooks.post('/connectors/deployments/claim', async (c) => {
  const job = await withConnector(
    c.req.header('authorization'),
    async (db, connector) => {
      // Never retry an ambiguous execution automatically. The worker has a 30 minute deadline.
      await db.query(
        `UPDATE deployment_builds b SET status='failed',finished=now(),log=log || E'\nWorker disconnected or exceeded deadline.'
      FROM deployments d WHERE b.deployment_id=d.id AND d.connector_id=$1 AND b.status='running' AND b.started < now()-interval '40 minutes'`,
        [connector],
      )
      if (
        (
          await db.query(
            "SELECT 1 FROM service_runs WHERE connector_id=$1 AND status='running'",
            [connector],
          )
        ).rowCount ||
        (
          await db.query(
            `SELECT 1 FROM deployment_builds b JOIN deployments d ON d.id=b.deployment_id WHERE d.connector_id=$1 AND b.status='running'`,
            [connector],
          )
        ).rowCount
      )
        return null
      const row = (
        await db.query(
          `SELECT b.id,b.deployment_id,b.commit,b.config,d.project,d.application
      FROM deployment_builds b JOIN deployments d ON d.id=b.deployment_id
      WHERE d.connector_id=$1 AND b.status='queued' AND (d.config->>'enabled')::boolean
      ORDER BY b.created,b.id LIMIT 1 FOR UPDATE OF d,b`,
          [connector],
        )
      ).rows[0]
      if (!row) return null
      await db.query(
        "UPDATE deployment_builds SET status='running',started=now() WHERE id=$1",
        [row.id],
      )
      return row
    },
  )
  return c.json({ job })
})
deploymentHooks.post('/connectors/deployments/:id/result', async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'))
  const result = z
    .object({
      status: z.enum(['succeeded', 'failed']),
      log: z.string().max(48000),
    })
    .strict()
    .parse(await c.req.json())
  const updated = await withConnector(
    c.req.header('authorization'),
    async (db, connector) =>
      db.query(
        `UPDATE deployment_builds b SET status=$1,log=$2,finished=now() FROM deployments d
      WHERE b.id=$3 AND b.deployment_id=d.id AND d.connector_id=$4 AND b.status='running' RETURNING b.id`,
        [result.status, result.log, id, connector],
      ),
  )
  return c.json({ ok: !!updated.rowCount })
})

export const deployments = new Hono<Env>()
const base = '/projects/:project/applications/:application/deployment'
deployments.use(base, requireUser)
deployments.use(base, async (c, next) => {
  if (!c.get('user').admin)
    await demandService(
      c.get('user'),
      c.req.param('project')!,
      c.req.method === 'GET' ? 'read' : 'deploy',
      c.req.param('application')!,
    )
  await projectAccess(c.get('user'), c.req.param('project')!)
  await next()
})
deployments.get(base, async (c) => {
  const row = (
    await pool.query(
      'SELECT id,config FROM deployments WHERE project=$1 AND application=$2',
      [c.req.param('project'), c.req.param('application')],
    )
  ).rows[0]
  return c.json(
    row
      ? {
          ...row,
          webhook_url: `${publicOrigin}/api/hooks/github/${row.id}`,
          builds: (
            await pool.query(
              'SELECT id,commit,status,created,started,finished,log FROM deployment_builds WHERE deployment_id=$1 ORDER BY created DESC,id DESC LIMIT 30',
              [row.id],
            )
          ).rows,
        }
      : null,
  )
})
deployments.post(base, async (c) => {
  const raw = await c.req.text()
  const body = raw.trim()
    ? z
        .object({ commit: z.string().regex(/^[a-f0-9]{40}$/) })
        .strict()
        .parse(JSON.parse(raw))
    : null
  const secret = token()
  await permissionTransaction(c.get('user'), async (db, actor) => {
    if (!actor.admin)
      await demandService(
        actor,
        c.req.param('project'),
        'deploy',
        c.req.param('application'),
        db,
      )
    if (body) {
      const deployment = (
        await db.query(
          'SELECT id,config,connector_id,service_revision FROM deployments WHERE project=$1 AND application=$2 FOR UPDATE',
          [c.req.param('project'), c.req.param('application')],
        )
      ).rows[0]
      if (!deployment)
        throw new HTTPException(404, { message: 'Deployment not found' })
      if (!deployment.config.enabled)
        throw new HTTPException(409, {
          message: 'Enable deployments before queuing a build',
        })
      if (deployment.service_revision) {
        await db.query(
          'INSERT INTO service_runs(id,revision,connector_id,request_key,commit) VALUES($1,$2,$3,$4,$5)',
          [
            randomUUID(),
            deployment.service_revision,
            deployment.connector_id,
            randomUUID(),
            body.commit,
          ],
        )
        return
      }
      await db.query(
        'INSERT INTO deployment_builds(id,deployment_id,delivery,commit,config) VALUES($1,$2,$3,$4,$5)',
        [
          randomUUID(),
          deployment.id,
          `manual-${randomUUID()}`,
          body.commit,
          deployment.config,
        ],
      )
      return
    }
    const updated = await db.query(
      'UPDATE deployments SET webhook_secret=$1 WHERE project=$2 AND application=$3 RETURNING id',
      [secret, c.req.param('project'), c.req.param('application')],
    )
    if (!updated.rowCount)
      throw new HTTPException(404, { message: 'Deployment not found' })
  })
  return c.json(body ? { queued: true } : { webhook_secret: secret })
})
deployments.put(base, async (c) => {
  const config = deploymentSchema.parse(await c.req.json())
  const secret = token()
  const result = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      if (!actor.admin)
        await demandService(
          actor,
          c.req.param('project'),
          'deploy',
          c.req.param('application'),
          db,
        )
      await projectAccess(actor, c.req.param('project')!, db)
      const service = (
        await db.query(
          'SELECT type FROM services WHERE project_slug=$1 AND slug=$2',
          [c.req.param('project'), c.req.param('application')],
        )
      ).rows[0]
      if (
        service &&
        (service.type === 'compose' ? 'compose' : 'dockerfile') !== config.kind
      )
        throw new HTTPException(400, {
          message: 'Build type must match the service type',
        })
      if (
        config.managed &&
        (!service ||
          config.container_name !==
            `dedi-${c.req.param('project')}-${c.req.param('application')}`)
      )
        throw new HTTPException(400, {
          message:
            'Managed deployments require a service and its reserved container name',
        })
      const connector = (
        await db.query('SELECT 1 FROM connectors WHERE id=$1 AND NOT revoked', [
          config.connector_id,
        ])
      ).rowCount
      if (!connector)
        throw new HTTPException(400, { message: 'Active connector required' })
      const existing = (
        await db.query(
          'SELECT id FROM deployments WHERE project=$1 AND application=$2 FOR UPDATE',
          [c.req.param('project'), c.req.param('application')],
        )
      ).rows[0]
      if (
        existing &&
        (
          await db.query(
            "SELECT 1 FROM deployment_builds WHERE deployment_id=$1 AND status='running'",
            [existing.id],
          )
        ).rowCount
      )
        throw new HTTPException(409, {
          message:
            'Wait for the running deployment before changing configuration',
        })
      // Bind to an existing, assigned container. Labels on its replacement preserve membership.
      const target = (
        await db.query(
          `SELECT 1 FROM inventory i LEFT JOIN assignments a ON a.connector_id=i.connector_id AND a.container_id=i.container_id
      WHERE i.connector_id=$1 AND i.data->>'name'=$2 AND
      ((i.data->>'project'=$3 AND i.data->>'application'=$4) OR (a.project_slug=$3 AND a.application=$4))`,
          [
            config.connector_id,
            config.container_name,
            c.req.param('project'),
            c.req.param('application'),
          ],
        )
      ).rowCount
      if (!target && !config.managed)
        throw new HTTPException(400, {
          message: 'Choose an existing container assigned to this application',
        })
      if (existing)
        await db.query(
          "UPDATE deployment_builds SET status='failed',finished=now(),log='Cancelled by configuration change' WHERE deployment_id=$1 AND status='queued'",
          [existing.id],
        )
      return (
        await db.query(
          `INSERT INTO deployments(id,project,application,connector_id,config,webhook_secret) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(project,application) DO UPDATE SET connector_id=$4,config=$5,service_revision=NULL RETURNING id`,
          [
            randomUUID(),
            c.req.param('project'),
            c.req.param('application'),
            config.connector_id,
            config,
            secret,
          ],
        )
      ).rows[0]
    },
  )
  // Existing secrets are only exposed by the explicit rotation action.
  const stored = (
    await pool.query(
      'SELECT webhook_secret=$2 AS fresh FROM deployments WHERE id=$1',
      [result.id, secret],
    )
  ).rows[0]
  return c.json({
    id: result.id,
    webhook_url: `${publicOrigin}/api/hooks/github/${result.id}`,
    ...(stored?.fresh ? { webhook_secret: secret } : {}),
  })
})
