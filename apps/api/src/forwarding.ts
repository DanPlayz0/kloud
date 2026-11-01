import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { listenerSchema } from '@kloud/protocol/forwarding'
import { pool } from './db.js'
import { requireUser, type Env } from './auth.js'
import { permissionTransaction } from './permissions.js'
import { demandService } from './service-permissions.js'
import { inventoryQuery } from './dashboard.js'
import { digest } from './security.js'
const uuid = z.string().uuid()
const base = '/projects/:project/services/:service/listeners'
const actorAuthorized = `EXISTS(SELECT 1 FROM users u WHERE u.id=l.actor AND NOT u.disabled AND (u.admin OR 'projects.manage'=ANY(u.capabilities) OR EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.project_slug=l.project AND (m.role='admin' OR EXISTS(SELECT 1 FROM service_grants g WHERE g.user_id=u.id AND g.project_slug=l.project AND g.capability='deploy' AND (g.service IS NULL OR g.service=l.service))))))`
export const forwarding = new Hono<Env>()
forwarding.use('/projects/:project/services/:service/listeners*', requireUser)
forwarding.get(base, async (c) => {
  await demandService(
    c.get('user'),
    c.req.param('project'),
    'read',
    c.req.param('service'),
  )
  return c.json(
    (
      await pool.query(
        `SELECT l.*, (l.applied AND l.reported > now()-interval '20 seconds' AND NOT h.revoked AND 'forwarding'=ANY(h.capabilities) AND ${actorAuthorized}) AS applied, (l.reported IS NULL OR l.reported < now()-interval '20 seconds') AS stale FROM service_listeners l JOIN connectors h ON h.id=l.connector_id WHERE l.project=$1 AND l.service=$2 ORDER BY l.created,l.id`,
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows,
  )
})
forwarding.put(`${base}/:id`, async (c) => {
  const body = z
    .object({ connector_id: uuid, config: listenerSchema })
    .strict()
    .parse(await c.req.json())
  const id = uuid.parse(c.req.param('id'))
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    const service = (
      await db.query(
        'SELECT type FROM services WHERE project_slug=$1 AND slug=$2',
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    if (service?.type === 'compose' && !body.config.compose_service)
      throw new HTTPException(400, {
        message:
          'Specify the Compose service key so forwarding can follow its active release.',
      })
    const host = (
      await db.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [body.connector_id],
      )
    ).rows[0]
    if (!host?.capabilities.includes('forwarding'))
      throw new HTTPException(409, {
        message: 'This server has not enabled host-local forwarding.',
      })
    const existing = (
      await db.query(
        'SELECT project,service FROM service_listeners WHERE id=$1',
        [id],
      )
    ).rows[0]
    if (
      existing &&
      (existing.project !== c.req.param('project') ||
        existing.service !== c.req.param('service'))
    )
      throw new HTTPException(404)
    if (
      !(
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
    )
      throw new HTTPException(400, {
        message: 'Choose a container assigned to this service.',
      })
    if (body.config.enabled) {
      const peers = (
        await db.query(
          "SELECT id,config FROM service_listeners WHERE connector_id=$1 AND id<>$2 AND (config->>'enabled')::boolean",
          [body.connector_id, id],
        )
      ).rows
      const ipv6 = body.config.bind_address.includes(':')
      if (
        peers.some(
          (peer) =>
            peer.config.protocol === body.config.protocol &&
            peer.config.port === body.config.port &&
            peer.config.bind_address.includes(':') === ipv6 &&
            (peer.config.bind_address === body.config.bind_address ||
              ['0.0.0.0', '::'].includes(peer.config.bind_address) ||
              ['0.0.0.0', '::'].includes(body.config.bind_address)),
        )
      )
        throw new HTTPException(409, {
          message: 'Another listener already owns this address/protocol/port.',
        })
    }
    await db.query(
      `INSERT INTO service_listeners(id,project,service,connector_id,config,actor) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET connector_id=$4,config=$5,actor=$6,generation=gen_random_uuid(),applied=false,error=NULL,updated=now()`,
      [
        id,
        c.req.param('project'),
        c.req.param('service'),
        body.connector_id,
        body.config,
        actor.id,
      ],
    )
  })
  return c.json({ id, desired: body.config.enabled, applied: false })
})
forwarding.delete(`${base}/:id`, async (c) => {
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    await db.query(
      'DELETE FROM service_listeners WHERE id=$1 AND project=$2 AND service=$3',
      [
        uuid.parse(c.req.param('id')),
        c.req.param('project'),
        c.req.param('service'),
      ],
    )
  })
  return c.json({ removed: true })
})
export const forwardingWorker = new Hono<{ Variables: { connector: string } }>()
forwardingWorker.use('/connectors/forwarding/*', async (c, next) => {
  const credential = c.req
    .header('authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
  const row = credential
    ? (
        await pool.query(
          "SELECT id FROM connectors WHERE token=$1 AND NOT revoked AND 'forwarding'=ANY(capabilities)",
          [digest(credential)],
        )
      ).rows[0]
    : null
  if (!row) throw new HTTPException(401)
  c.set('connector', row.id)
  await next()
})
forwardingWorker.post('/connectors/forwarding/sync', async (c) => {
  const report = z
    .object({
      listeners: z
        .array(
          z
            .object({
              id: uuid,
              generation: uuid,
              applied: z.boolean(),
              error: z.string().max(256).nullable(),
            })
            .strict(),
        )
        .max(500),
    })
    .strict()
    .parse(await c.req.json())
  const connector = c.get('connector')
  for (const status of report.listeners)
    await pool.query(
      'UPDATE service_listeners SET applied=$2,error=$3,reported=now() WHERE id=$1 AND connector_id=$4 AND generation=$5',
      [status.id, status.applied, status.error, connector, status.generation],
    )
  await pool.query(
    `UPDATE service_listeners l SET applied=false,error='Listener authority revoked; waiting for host reconciliation' WHERE l.connector_id=$1 AND (l.config->>'enabled')::boolean AND NOT ${actorAuthorized}`,
    [connector],
  )
  const listeners = (
    await pool.query(
      `SELECT l.*,CASE WHEN l.config ? 'compose_service' THEN COALESCE(s.compose_state->'targets'->>(l.config->>'compose_service'),l.config->>'container') ELSE COALESCE(s.serving,l.config->>'container') END AS target FROM service_listeners l LEFT JOIN service_release_state s ON s.project=l.project AND s.service=l.service AND s.connector_id=l.connector_id WHERE l.connector_id=$1 AND (l.config->>'enabled')::boolean AND ${actorAuthorized} ORDER BY l.created,l.id`,
      [connector],
    )
  ).rows
  return c.json({ listeners })
})
export async function migrateForwarding(db: import('pg').PoolClient) {
  if ((await db.query('SELECT 1 FROM migrations WHERE version=23')).rowCount)
    return
  await db.query(
    `CREATE TABLE service_listeners(id uuid PRIMARY KEY,actor uuid REFERENCES users ON DELETE SET NULL,generation uuid NOT NULL DEFAULT gen_random_uuid(),project text NOT NULL,service text NOT NULL,connector_id uuid NOT NULL REFERENCES connectors ON DELETE CASCADE,config jsonb NOT NULL,applied boolean NOT NULL DEFAULT false,error text,reported timestamptz,created timestamptz NOT NULL DEFAULT now(),updated timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(project,service) REFERENCES services(project_slug,slug) ON DELETE CASCADE); INSERT INTO migrations(version) VALUES(23);`,
  )
}
