import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { currentUser, requireUser, type Env } from './auth.js'
import { demandServer, permissionTransaction } from './permissions.js'
import { connectorRpc } from './connector-rpc.js'
import { pool } from './db.js'

export const connectorUpdates = new Hono<Env>()
connectorUpdates.use('/connectors/:connector/updates', requireUser)
connectorUpdates.use('/connectors/:connector/updates/*', requireUser)
async function authorized(
  c: import('hono').Context<Env>,
  requireConfigured = true,
) {
  const actor = await currentUser(c)
  if (!actor) throw new HTTPException(401)
  demandServer(actor, 'connectors.manage')
  const id = z.uuid().parse(c.req.param('connector'))
  const host = (
    await pool.query(
      'SELECT agent_status,capabilities FROM connectors WHERE id=$1 AND NOT revoked',
      [id],
    )
  ).rows[0]
  if (!host) throw new HTTPException(404, { message: 'Connector not found' })
  if (
    requireConfigured &&
    (!host.capabilities.includes('connector-update-v1') ||
      !host.agent_status?.updater?.configured)
  )
    throw new HTTPException(409, {
      message: 'Configure a trusted updater on the connector host first.',
    })
  return id
}
connectorUpdates.post('/connectors/:connector/updates/check', async (c) => {
  z.object({})
    .strict()
    .parse(await c.req.json())
  const id = await authorized(c)
  return c.json(
    await connectorRpc(id, { kind: 'connector-update', action: 'check' }),
  )
})
connectorUpdates.put('/connectors/:connector/updates', async (c) => {
  const body = z
    .object({ enabled: z.boolean() })
    .strict()
    .parse(await c.req.json())
  const id = await authorized(c, body.enabled)
  // Persist first so a reconnect always restores the selected policy.
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'connectors.manage')
    const result = await db.query(
      'UPDATE connectors SET auto_update=$2 WHERE id=$1 AND NOT revoked RETURNING id',
      [id, body.enabled],
    )
    if (!result.rowCount) throw new HTTPException(404)
  })
  try {
    await connectorRpc(id, {
      kind: 'connector-update',
      action: 'configure',
      enabled: body.enabled,
    })
  } catch {
    // Offline connectors receive this setting on their next authenticated connection.
    return c.json({ saved: true, pending: true })
  }
  return c.json({ saved: true })
})
