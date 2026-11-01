import { scopedApiUrl } from './organization-context.js'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  createHmac,
  createHash,
  timingSafeEqual,
  randomUUID,
} from 'node:crypto'
import { z } from 'zod'
import { deploymentSchema } from '@kloud/protocol'
import { pool, transaction } from './db.js'
import { requireUser, type Env } from './auth.js'
import { permissionTransaction, projectAccess } from './permissions.js'
import { token, digest, publicOrigin } from './security.js'
import { seal, unseal } from './platform-secrets.js'
import { resolveGitSource, validateGitSource } from './git-connections.js'
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
  const selfHosted =
    !!deployment?.config?.provider_url &&
    deployment.config.provider_url !== 'https://github.com'
  const signature = selfHosted
    ? `sha256=${c.req.header('x-forgejo-signature') ?? c.req.header('x-gitea-signature') ?? ''}`
    : c.req.header('x-hub-signature-256')
  if (
    !deployment ||
    !verifySignature(raw, deployment.webhook_secret, signature)
  )
    return c.json({ error: 'Invalid webhook signature' }, 401)
  const event = selfHosted
    ? (c.req.header('x-forgejo-event') ?? c.req.header('x-gitea-event'))
    : c.req.header('x-github-event')
  if (event !== 'push') return c.json({ ignored: true })
  const payload = z
    .object({
      ref: z.string(),
      after: z.string().regex(/^[a-f0-9]{40}$/),
      deleted: z.boolean().optional(),
      repository: z.object({
        full_name: z.string(),
        id: z.union([z.string(), z.number()]).optional(),
      }),
    })
    .parse(JSON.parse(new TextDecoder().decode(raw)))
  const delivery = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9-]+$/)
    .parse(
      selfHosted
        ? (c.req.header('x-forgejo-delivery') ??
            c.req.header('x-gitea-delivery'))
        : c.req.header('x-github-delivery'),
    )
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
      (config.connection_id &&
        !['automatic', 'manual', 'manual-verified'].includes(
          current.webhook_mode,
        )) ||
      (config.repository_id !== undefined &&
        String(payload.repository.id) !== String(config.repository_id)) ||
      payload.deleted ||
      payload.after === '0'.repeat(40) ||
      payload.ref !== `refs/heads/${config.branch}` ||
      payload.repository.full_name.toLowerCase() !==
        config.repository.toLowerCase()
    )
      return false
    if (current.webhook_mode === 'manual')
      await db.query(
        "UPDATE deployments SET webhook_mode='manual-verified',webhook_error=NULL WHERE id=$1",
        [id],
      )
    if (current.service_revision) {
      await db.query(
        `INSERT INTO service_runs(id,revision,connector_id,request_key,commit,requested_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_key) DO NOTHING`,
        [
          randomUUID(),
          current.service_revision,
          current.connector_id,
          deliveryKey(id, delivery),
          payload.after,
          current.configured_by,
        ],
      )
      return true
    }
    await db.query(
      `INSERT INTO deployment_builds(id,deployment_id,delivery,commit,config,requested_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(deployment_id,delivery) DO NOTHING`,
      [
        randomUUID(),
        id,
        delivery,
        payload.after,
        config,
        current.configured_by,
      ],
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
      const host = (
        await db.query('SELECT capabilities FROM connectors WHERE id=$1', [
          connector,
        ])
      ).rows[0]
      if (!host?.capabilities.includes('rollout-v1')) return null
      // Never retry an ambiguous execution automatically. The worker has a 30 minute deadline.
      await db.query(
        `INSERT INTO deployment_pauses(deployment,reason) SELECT deployment_id,'Worker disconnected; serving state requires explicit reconciliation' FROM deployment_builds WHERE config->>'connector_id'=$1::text AND status='running' AND started<now()-interval '40 minutes' ON CONFLICT(deployment) DO UPDATE SET reason=EXCLUDED.reason,updated=now()`,
        [connector],
      )
      await db.query(
        `INSERT INTO service_release_state(project,service,connector_id,paused,reason)
        SELECT d.project,d.application,$1::uuid,true,'Legacy worker disconnected; inspect serving state before further deployment'
        FROM deployment_builds b JOIN deployments d ON d.id=b.deployment_id JOIN services s ON s.project_slug=d.project AND s.slug=d.application
        WHERE b.config->>'connector_id'=$1::text AND b.status='running' AND b.started<now()-interval '40 minutes'
        ON CONFLICT(project,service) DO UPDATE SET paused=true,reason=EXCLUDED.reason,updated=now()`,
        [connector],
      )

      await db.query(
        `UPDATE deployment_builds b SET status='failed',finished=now(),log=log || E'\nWorker disconnected or exceeded deadline.'
      FROM deployments d WHERE b.deployment_id=d.id AND b.config->>'connector_id'=$1::text AND b.status='running' AND b.started < now()-interval '40 minutes'`,
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
            `SELECT 1 FROM deployment_builds b JOIN deployments d ON d.id=b.deployment_id WHERE b.config->>'connector_id'=$1::text AND b.status='running'`,
            [connector],
          )
        ).rowCount
      )
        return null
      const row = (
        await db.query(
          `SELECT b.id,b.deployment_id,b.commit,b.config,b.requested_by,d.project,d.application
      FROM deployment_builds b JOIN deployments d ON d.id=b.deployment_id
      WHERE b.config->>'connector_id'=$1::text AND b.status='queued' AND NOT EXISTS (SELECT 1 FROM deployment_pauses paused WHERE paused.deployment=d.id) AND NOT EXISTS (SELECT 1 FROM deployment_builds older JOIN deployments od ON od.id=older.deployment_id WHERE od.project=d.project AND od.application=d.application AND older.status IN ('queued','running') AND older.receipt_order<b.receipt_order) AND NOT EXISTS (SELECT 1 FROM service_release_state state WHERE state.project=d.project AND state.service=d.application AND state.paused) AND NOT EXISTS (SELECT 1 FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE v.project=d.project AND v.service=d.application AND r.status IN ('queued','running') AND r.receipt_order<b.receipt_order)
      ORDER BY b.receipt_order LIMIT 1 FOR UPDATE OF d,b`,
          [connector],
        )
      ).rows[0]
      if (!row) return null
      await db.query(
        "UPDATE deployment_builds SET status='running',started=now() WHERE id=$1",
        [row.id],
      )
      try {
        const actor = (
          await db.query(
            'SELECT id,username,admin,capabilities FROM users WHERE id=$1 AND NOT disabled',
            [row.requested_by],
          )
        ).rows[0]
        if (!actor) throw new Error('Deployment actor unavailable')
        if (!actor.admin)
          await demandService(actor, row.project, 'deploy', row.application, db)
        const source_auth = await resolveGitSource(
          db,
          row.project,
          row.application,
          row.config,
        )
        if (source_auth)
          await db.query(
            'UPDATE deployment_builds SET encrypted_dispatch_secrets=$2 WHERE id=$1',
            [
              row.id,
              seal([
                source_auth.token,
                Buffer.from(
                  `${source_auth.username ?? 'x-access-token'}:${source_auth.token}`,
                ).toString('base64'),
              ]),
            ],
          )
        return { ...row, source_auth }
      } catch {
        await db.query(
          "UPDATE deployment_builds SET status='failed',finished=now(),log='Source connection authorization is no longer available; select an authorized connection before deploying again' WHERE id=$1",
          [row.id],
        )
        return null
      }
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
    async (db, connector) => {
      const row = (
        await db.query(
          "SELECT encrypted_dispatch_secrets FROM deployment_builds WHERE id=$1 AND config->>'connector_id'=$2::text",
          [id, connector],
        )
      ).rows[0]
      const secrets = row?.encrypted_dispatch_secrets
        ? (unseal(row.encrypted_dispatch_secrets) as string[])
        : []
      const log = secrets
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .reduce(
          (text, secret) => text.split(secret).join('[redacted]'),
          result.log,
        )
      return db.query(
        `UPDATE deployment_builds b SET status=$1,log=$2,finished=now() FROM deployments d
      WHERE b.id=$3 AND b.deployment_id=d.id AND b.config->>'connector_id'=$4::text AND b.status='running' RETURNING b.id`,
        [result.status, log, id, connector],
      )
    },
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
      'SELECT id,config,webhook_mode,webhook_error FROM deployments WHERE project=$1 AND application=$2',
      [c.req.param('project'), c.req.param('application')],
    )
  ).rows[0]
  return c.json(
    row
      ? {
          ...row,
          webhook_url: scopedApiUrl(publicOrigin, `/hooks/github/${row.id}`),
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
      await validateGitSource(
        db,
        actor,
        c.req.param('project'),
        c.req.param('application'),
        deployment.config,
      )
      if (deployment.service_revision) {
        await db.query(
          'INSERT INTO service_runs(id,revision,connector_id,request_key,commit,requested_by,manual) VALUES($1,$2,$3,$4,$5,$6,true)',
          [
            randomUUID(),
            deployment.service_revision,
            deployment.connector_id,
            randomUUID(),
            body.commit,
            actor.id,
          ],
        )
        return
      }
      await db.query(
        'INSERT INTO deployment_builds(id,deployment_id,delivery,commit,config,requested_by) VALUES($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          deployment.id,
          `manual-${randomUUID()}`,
          body.commit,
          deployment.config,
          actor.id,
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
      await validateGitSource(
        db,
        actor,
        c.req.param('project'),
        c.req.param('application'),
        config,
      )
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
            `kloud-${c.req.param('project')}-${c.req.param('application')}`)
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
      return (
        await db.query(
          `INSERT INTO deployments(id,project,application,connector_id,config,webhook_secret,configured_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(project,application) DO UPDATE SET connector_id=$4,config=$5,service_revision=NULL,configured_by=$7 RETURNING id`,
          [
            randomUUID(),
            c.req.param('project'),
            c.req.param('application'),
            config.connector_id,
            config,
            secret,
            actor.id,
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
    webhook_url: scopedApiUrl(publicOrigin, `/hooks/github/${result.id}`),
    ...(stored?.fresh ? { webhook_secret: secret } : {}),
  })
})
