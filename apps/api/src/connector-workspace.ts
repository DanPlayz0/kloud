import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { runtimeRequestSchema } from '@kloud/protocol/platform'
import {
  pm2OperationSchema,
  pm2LogQuerySchema,
  pm2LogsSchema,
  pm2ResultSchema,
} from '@kloud/protocol/pm2'
import { requireUser, currentUser, type Env, type User } from './auth.js'
import { hasServer, demandServer } from './permissions.js'
import { pool } from './db.js'
import { inventoryQuery } from './dashboard.js'
import { pm2InventoryQuery } from './pm2-inventory.js'
import { connectorRpc } from './connector-rpc.js'

export const connectorWorkspace = new Hono<Env>()
connectorWorkspace.use('*', requireUser)
const uuid = z.string().uuid()
const containerId = z.string().regex(/^[a-f0-9]{64}$/)
const metadataQuery = `SELECT id,name,host,seen,discovery,revoked,capabilities,
  (seen IS NULL OR seen<now()-interval '20 seconds' OR revoked) AS stale
  FROM connectors`
export function canBrowseConnector(user: User) {
  return hasServer(user, 'connectors.manage') || canBrowseResources(user)
}
export function canBrowseResources(user: User) {
  return (
    hasServer(user, 'inventory.manage') || hasServer(user, 'connectors.operate')
  )
}
function demandBrowse(user: User, resources = false) {
  if (!(resources ? canBrowseResources(user) : canBrowseConnector(user)))
    throw new HTTPException(403, { message: 'Server permission required' })
}
async function host(id: string) {
  const row = (
    await pool.query(metadataQuery + ' WHERE id=$1 AND NOT revoked', [id])
  ).rows[0]
  if (!row) throw new HTTPException(404, { message: 'Connector not found' })
  return row
}
async function actor(c: Context<Env>) {
  const user = await currentUser(c)
  if (!user) throw new HTTPException(401)
  return user
}
connectorWorkspace.get('/connectors', async (c) => {
  demandBrowse(c.get('user'))
  return c.json(
    (await pool.query(metadataQuery + ' WHERE NOT revoked ORDER BY name,id'))
      .rows,
  )
})
connectorWorkspace.get('/connectors/:connector', async (c) => {
  demandBrowse(c.get('user'))
  return c.json(await host(uuid.parse(c.req.param('connector'))))
})

// Connector scope is always enforced in SQL, including for globally unique PM2 IDs.
async function resource(
  user: User,
  connector: string,
  id: string,
  pm2: boolean,
  fresh: boolean,
) {
  demandServer(user, 'connectors.operate')
  const connectorRow = await host(connector)
  const row = (
    await pool.query(
      pm2
        ? `SELECT * FROM (${pm2InventoryQuery}) r WHERE connector_id=$1 AND id=$2 AND (project_slug IS NOT NULL OR $3::boolean)`
        : `SELECT * FROM (${inventoryQuery}) r WHERE connector_id=$1 AND container_id=$2 AND (assignment IS NOT NULL OR $3::boolean)`,
      [connector, id, connectorRow.discovery],
    )
  ).rows[0]
  if (!row) throw new HTTPException(404, { message: 'Resource not found' })
  const available =
    !row.stale &&
    (!pm2 || row.present) &&
    connectorRow.capabilities.includes(pm2 ? 'pm2' : 'runtime')
  if (fresh && !available)
    throw new HTTPException(409, {
      message: 'Host inventory is stale or runtime unavailable',
    })
  return { row, available }
}

for (const isPm2 of [false, true]) {
  const collection = isPm2 ? 'pm2' : 'containers'
  const base = '/connectors/:connector/' + collection
  const target = base + '/:resource'
  const ids = (c: Context<Env>) => ({
    connector: uuid.parse(c.req.param('connector')),
    id: (isPm2 ? uuid : containerId).parse(c.req.param('resource')),
  })
  connectorWorkspace.get(base, async (c) => {
    demandBrowse(c.get('user'), true)
    const connector = uuid.parse(c.req.param('connector'))
    const h = await host(connector)
    return c.json(
      (
        await pool.query(
          isPm2
            ? `SELECT * FROM (${pm2InventoryQuery}) r WHERE connector_id=$1 AND (project_slug IS NOT NULL OR $2::boolean) ORDER BY namespace,name`
            : `SELECT * FROM (${inventoryQuery}) r WHERE connector_id=$1 AND (assignment IS NOT NULL OR $2::boolean) ORDER BY data->>'name'`,
          [connector, h.discovery],
        )
      ).rows,
    )
  })
  connectorWorkspace.get(target + '/permissions', async (c) => {
    const { connector, id } = ids(c)
    // Browsers without operation permission can still open resource details.
    demandBrowse(c.get('user'), true)
    const h = await host(connector)
    if (!hasServer(c.get('user'), 'connectors.operate')) {
      const found = (
        await pool.query(
          isPm2
            ? `SELECT id FROM (${pm2InventoryQuery}) r WHERE connector_id=$1 AND id=$2 AND (project_slug IS NOT NULL OR $3::boolean)`
            : `SELECT container_id FROM (${inventoryQuery}) r WHERE connector_id=$1 AND container_id=$2 AND (assignment IS NOT NULL OR $3::boolean)`,
          [connector, id, h.discovery],
        )
      ).rows[0]
      if (!found) throw new HTTPException(404)
      return c.json(
        isPm2
          ? {
              available: false,
              view: true,
              logs: false,
              manage: false,
              delete: false,
            }
          : {
              available: false,
              logs: false,
              lifecycle: false,
              terminal: false,
              configuration: false,
            },
      )
    }
    const { available } = await resource(
      c.get('user'),
      connector,
      id,
      isPm2,
      false,
    )
    return c.json(
      isPm2
        ? { available, view: true, logs: true, manage: true, delete: true }
        : {
            available,
            logs: available,
            lifecycle: available,
            terminal: available,
            configuration: available,
          },
    )
  })
  connectorWorkspace.post(target + '/operation', async (c) => {
    const { connector, id } = ids(c)
    const body = isPm2
      ? pm2OperationSchema.parse(await c.req.json())
      : runtimeRequestSchema.parse(await c.req.json())
    const user = await actor(c)
    const { row } = await resource(user, connector, id, isPm2, true)
    const operation = isPm2
      ? { kind: 'pm2', name: row.name, namespace: row.namespace, ...body }
      : {
          kind: 'runtime',
          ...body,
          container: id,
          project: row.project,
          application: row.application,
          owner: user.id,
        }
    const result = await connectorRpc(connector, operation)
    try {
      await resource(await actor(c), connector, id, isPm2, true)
    } catch (error) {
      if (!isPm2 && body.action === 'terminal-open' && result.session)
        void connectorRpc(connector, {
          kind: 'runtime',
          action: 'terminal-close',
          container: id,
          owner: user.id,
          session: result.session,
        }).catch(() => {})
      throw error
    }
    return c.json(isPm2 ? pm2ResultSchema.parse(result) : result)
  })
  connectorWorkspace.get(target + '/logs', async (c) => {
    const { connector, id } = ids(c)
    const query = isPm2 ? pm2LogQuerySchema.parse(c.req.query()) : {}
    await resource(await actor(c), connector, id, isPm2, true)
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        try {
          const user = await actor(c)
          const { row } = await resource(user, connector, id, isPm2, true)
          const result = await connectorRpc(
            connector,
            isPm2
              ? {
                  kind: 'pm2',
                  action: 'logs',
                  name: row.name,
                  namespace: row.namespace,
                  ...query,
                }
              : {
                  kind: 'runtime',
                  action: 'logs',
                  container: id,
                  owner: user.id,
                  project: row.project,
                  application: row.application,
                },
          )
          await resource(await actor(c), connector, id, isPm2, true)
          if (!stream.aborted)
            await stream.writeSSE({
              data: JSON.stringify(
                isPm2 ? pm2LogsSchema.parse(result) : result,
              ),
            })
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
  })
}
