import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BuildInputs } from '@kloud/protocol/platform'
import { requireUser, type Env, type User } from './auth.js'
import { pool } from './db.js'
import { permissionTransaction, projectAccess } from './permissions.js'
import { demandService } from './service-permissions.js'
import { seal, unseal } from './platform-secrets.js'

type Database = Pick<PoolClient, 'query'>
interface Connection {
  id: string
  server: string
  owner: string | null
  encrypted_credentials: string
}
const base = '/projects/:project/registry-connections'
const uuid = z.string().uuid()
async function connection(
  db: Database,
  project: string,
  service: string,
  id: string,
) {
  const row = (
    await db.query<Connection>(
      'SELECT * FROM registry_connections WHERE id=$1 AND NOT revoked',
      [id],
    )
  ).rows[0]
  if (!row)
    throw new HTTPException(403, {
      message: 'Registry connection is missing or revoked.',
    })
  if (
    row.owner &&
    !(
      await db.query(
        'SELECT 1 FROM users u WHERE u.id=$1 AND NOT disabled AND (u.admin OR EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.project_slug=$2))',
        [row.owner, project],
      )
    ).rowCount
  )
    throw new HTTPException(403, {
      message:
        'Registry credential owner is disabled or no longer a project member.',
    })
  return row
}
export async function validateRegistryInputs(
  db: Database,
  actor: User,
  project: string,
  service: string,
  inputs?: BuildInputs,
) {
  if (inputs?.registry_connection_ids?.length)
    await demandService(actor, project, 'deploy', service, db)
  for (const id of inputs?.registry_connection_ids ?? []) {
    const row = await connection(db, project, service, id)
    const broad = row.owner === actor.id || (!row.owner && actor.admin)
    if (
      !broad &&
      !(
        await db.query(
          'SELECT 1 FROM registry_bindings WHERE connection=$1 AND project=$2 AND service=$3',
          [id, project, service],
        )
      ).rowCount
    )
      throw new HTTPException(403, {
        message: 'Registry connection has not been delegated to this app.',
      })
    if (broad)
      await db.query(
        'INSERT INTO registry_bindings(connection,project,service) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [id, project, service],
      )
  }
}
export async function resolveRegistryInputs(
  db: Database,
  project: string,
  service: string,
  inputs?: BuildInputs,
) {
  if (!inputs) return undefined
  const result: BuildInputs = {
    ...inputs,
    secrets: { ...inputs.secrets },
    registries: [...inputs.registries],
  }
  for (const id of inputs.registry_connection_ids ?? []) {
    const row = await connection(db, project, service, id)
    if (
      !(
        await db.query(
          'SELECT 1 FROM registry_bindings WHERE connection=$1 AND project=$2 AND service=$3',
          [id, project, service],
        )
      ).rowCount
    )
      throw new HTTPException(403, {
        message:
          'Registry delegation was revoked. Select an authorized registry connection.',
      })
    if (
      result.registries.some(
        (registry) =>
          registry.server.toLowerCase() === row.server.toLowerCase(),
      )
    )
      throw new HTTPException(409, {
        message: `Choose one credential source for registry ${row.server}.`,
      })
    result.registries.push({
      server: row.server,
      ...unseal(row.encrypted_credentials),
    })
  }
  return result
}
export const registryConnections = new Hono<Env>()
registryConnections.use('/projects/:project/registry-connections*', requireUser)
registryConnections.get(base, async (c) => {
  const service = z.string().min(1).parse(c.req.query('service'))
  await demandService(c.get('user'), c.req.param('project'), 'deploy', service)
  return c.json(
    (
      await pool.query(
        `SELECT c.id,c.name,c.server,c.owner,c.created FROM registry_connections c WHERE NOT c.revoked
    AND (c.owner=$2 OR (c.owner IS NULL AND $3) OR EXISTS(SELECT 1 FROM registry_bindings b WHERE b.connection=c.id AND b.project=$1 AND b.service=$4))
    AND (c.owner IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=c.owner AND NOT disabled AND (u.admin OR EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.project_slug=$1)))) ORDER BY c.name`,
        [
          c.req.param('project'),
          c.get('user').id,
          c.get('user').admin,
          service,
        ],
      )
    ).rows,
  )
})
registryConnections.post(base, async (c) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(100),
      server: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/)
        .max(256),
      username: z.string().min(1).max(256),
      password: z.string().min(1).max(4096),
      scope: z.enum(['personal', 'shared']).default('personal'),
      service: z.string().min(1),
    })
    .strict()
    .parse(await c.req.json())
  const id = await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      body.service,
      db,
    )
    if (body.scope === 'shared' && !actor.admin)
      throw new HTTPException(403, {
        message: 'Only server administrators manage shared registries.',
      })
    const id = randomUUID()
    await db.query(
      'INSERT INTO registry_connections(id,project,name,server,owner,encrypted_credentials) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        c.req.param('project'),
        body.name,
        body.server.toLowerCase(),
        body.scope === 'personal' ? actor.id : null,
        seal({ username: body.username, password: body.password }),
      ],
    )
    await db.query(
      'INSERT INTO registry_bindings(connection,project,service) VALUES($1,$2,$3)',
      [id, c.req.param('project'), body.service],
    )
    return id
  })
  return c.json({ id }, 201)
})
registryConnections.put(`${base}/:id/delegation`, async (c) => {
  const body = z
    .object({ service: z.string().min(1), enabled: z.boolean() })
    .strict()
    .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      body.service,
      db,
    )
    const row = await connection(
      db,
      c.req.param('project'),
      body.service,
      uuid.parse(c.req.param('id')),
    )
    if (row.owner ? row.owner !== actor.id : !actor.admin)
      throw new HTTPException(403)
    if (body.enabled)
      await db.query(
        'INSERT INTO registry_bindings(connection,project,service) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [row.id, c.req.param('project'), body.service],
      )
    else
      await db.query(
        'DELETE FROM registry_bindings WHERE connection=$1 AND project=$2 AND service=$3',
        [row.id, c.req.param('project'), body.service],
      )
  })
  return c.json({ saved: true })
})
registryConnections.delete(`${base}/:id`, async (c) => {
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await projectAccess(actor, c.req.param('project'), db)
    const row = (
      await db.query<Connection>(
        'SELECT * FROM registry_connections WHERE id=$1',
        [uuid.parse(c.req.param('id'))],
      )
    ).rows[0]
    if (!row) throw new HTTPException(404)
    if (row.owner ? row.owner !== actor.id : !actor.admin)
      throw new HTTPException(403)
    await db.query('UPDATE registry_connections SET revoked=true WHERE id=$1', [
      row.id,
    ])
  })
  return c.json({ revoked: true })
})
