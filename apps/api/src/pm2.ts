import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import {
  pm2LogQuerySchema,
  pm2LogsSchema,
  pm2OperationSchema,
  pm2ResultSchema,
  type Pm2Grant,
} from '@kloud/protocol/pm2'
import { requireUser, currentUser, type Env, type User } from './auth.js'
import { pool } from './db.js'
import {
  demandServer,
  permissionTransaction,
  projectAccess,
} from './permissions.js'
import { connectorRpc } from './connector-rpc.js'
import { pm2InventoryQuery } from './pm2-inventory.js'

export const pm2 = new Hono<Env>()
pm2.use('*', requireUser)
const uuid = z.string().uuid()
const base = '/projects/:project/pm2/:app'
export const pm2AssignmentSchema = z
  .object({
    project: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(100)
      .nullable(),
  })
  .strict()

async function permission(
  user: User,
  project: string,
  id: string,
  capability: Pm2Grant['capability'],
  fresh = true,
) {
  const access = await projectAccess(user, project)
  const row = (
    await pool.query(
      `SELECT * FROM (${pm2InventoryQuery}) p WHERE id=$1 AND project_slug=$2`,
      [id, project],
    )
  ).rows[0]
  if (!row) throw new HTTPException(404, { message: 'PM2 app not found' })
  if (
    !access.can_manage_access &&
    !(
      await pool.query(
        `SELECT 1 FROM pm2_grants WHERE user_id=$1 AND project_slug=$2 AND capability=$3 AND (app IS NULL OR app=$4)`,
        [user.id, project, capability, id],
      )
    ).rowCount
  )
    throw new HTTPException(403, {
      message: `PM2 ${capability} permission required`,
    })
  if (fresh && (row.stale || !row.present))
    throw new HTTPException(409, {
      message: 'PM2 inventory is stale or app unavailable',
    })
  return row
}

pm2.get('/admin/pm2', async (c) => {
  demandServer(c.get('user'), 'inventory.manage')
  return c.json(
    (
      await pool.query(
        `SELECT * FROM (${pm2InventoryQuery}) p WHERE project_slug IS NOT NULL OR connector_id IN (SELECT id FROM connectors WHERE discovery) ORDER BY connector_name,namespace,name`,
      )
    ).rows,
  )
})
pm2.put('/admin/pm2/:app', async (c) => {
  const id = uuid.parse(c.req.param('app')),
    body = pm2AssignmentSchema.parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'inventory.manage')
    // Lock the connector before its inventory, in the same order as collection.
    const host = (
      await db.query('SELECT connector_id FROM pm2_apps WHERE id=$1', [id])
    ).rows[0]
    if (!host) throw new HTTPException(404)
    const connector = (
      await db.query(
        'SELECT discovery,revoked FROM connectors WHERE id=$1 FOR UPDATE',
        [host.connector_id],
      )
    ).rows[0]
    const row = (
      await db.query(
        'SELECT project_slug,present FROM pm2_apps WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0]
    if (
      !connector ||
      connector.revoked ||
      !row ||
      (body.project !== null && (!connector.discovery || !row.present))
    )
      throw new HTTPException(409, {
        message:
          'PM2 assignment unavailable; enable discovery on an active host',
      })
    if (row.project_slug !== body.project) {
      await db.query('DELETE FROM pm2_grants WHERE app=$1', [id])
      await db.query('UPDATE pm2_apps SET project_slug=$2 WHERE id=$1', [
        id,
        body.project,
      ])
    }
  })
  return c.json({ ok: true })
})
pm2.get('/projects/:project/pm2', async (c) => {
  const project = c.req.param('project'),
    user = c.get('user')
  const access = await projectAccess(user, project)
  return c.json(
    (
      await pool.query(
        `SELECT * FROM (${pm2InventoryQuery}) p WHERE project_slug=$1 AND ($2::boolean OR EXISTS (
    SELECT 1 FROM pm2_grants g WHERE g.user_id=$3 AND g.project_slug=$1 AND g.capability='view' AND (g.app IS NULL OR g.app=p.id))) ORDER BY connector_name,namespace,name`,
        [project, access.can_manage_access, user.id],
      )
    ).rows,
  )
})
pm2.get(`${base}/permissions`, async (c) => {
  const project = c.req.param('project'),
    id = uuid.parse(c.req.param('app')),
    user = c.get('user')
  const row = await permission(user, project, id, 'view', false)
  const result = {
    available: !row.stale && row.present,
    view: true,
    logs: false,
    manage: false,
    delete: false,
  }
  for (const capability of ['logs', 'manage', 'delete'] as const) {
    try {
      await permission(user, project, id, capability, false)
      result[capability] = true
    } catch (error) {
      if (!(error instanceof HTTPException) || error.status !== 403) throw error
    }
  }
  return c.json(result)
})
pm2.post(`${base}/operation`, async (c) => {
  const project = c.req.param('project'),
    id = uuid.parse(c.req.param('app'))
  const { action } = pm2OperationSchema.parse(await c.req.json())
  const user = await currentUser(c)
  if (!user) throw new HTTPException(401)
  const row = await permission(
    user,
    project,
    id,
    action === 'delete' ? 'delete' : 'manage',
  )
  const result = pm2ResultSchema.parse(
    await connectorRpc(row.connector_id, {
      kind: 'pm2',
      name: row.name,
      namespace: row.namespace,
      action,
    }),
  )
  return c.json(result)
})
pm2.get(`${base}/logs`, async (c) => {
  const project = c.req.param('project'),
    id = uuid.parse(c.req.param('app'))
  const query = pm2LogQuerySchema.parse(c.req.query())
  await permission(c.get('user'), project, id, 'logs')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    while (!stream.aborted) {
      try {
        const user = await currentUser(c)
        if (!user) throw new HTTPException(401)
        const row = await permission(user, project, id, 'logs')
        const result = pm2LogsSchema.parse(
          await connectorRpc(row.connector_id, {
            kind: 'pm2',
            action: 'logs',
            name: row.name,
            namespace: row.namespace,
            ...query,
          }),
        )
        const current = await currentUser(c)
        if (!current) throw new HTTPException(401)
        await permission(current, project, id, 'logs')
        if (!stream.aborted)
          await stream.writeSSE({ data: JSON.stringify(result) })
      } catch {
        if (!stream.aborted)
          await stream.writeSSE({
            event: 'unavailable',
            data: 'PM2 log access ended or host unavailable',
          })
        break
      }
      await stream.sleep(1500)
    }
  })
})
