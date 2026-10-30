import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import type { PoolClient } from 'pg'
import { pool, transaction } from './db.js'
import type { User } from './auth.js'

export const serverCapabilities = [
  'dns.manage',
  'users.manage',
  'projects.create',
  'projects.manage',
  'connectors.manage',
  'inventory.manage',
] as const
export type ServerCapability = (typeof serverCapabilities)[number]
export const containerCapabilities = [
  'view',
  'logs',
  'lifecycle',
  'terminal',
  'configuration',
] as const
export const capabilitySchema = z
  .array(z.enum(serverCapabilities))
  .max(serverCapabilities.length)
  .transform((v) => [...new Set(v)])
export const grantSchema = z
  .object({
    capability: z.enum(containerCapabilities),
    kind: z.enum(['all', 'id', 'name']),
    connector_id: z.string().uuid().nullable().default(null),
    target: z.string().min(1).max(256).nullable().default(null),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (
      g.kind === 'all'
        ? g.connector_id !== null || g.target !== null
        : !g.connector_id || !g.target
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid grant target' })
    if (g.kind === 'id' && !/^[a-f0-9]{64}$/.test(g.target ?? ''))
      ctx.addIssue({ code: 'custom', message: 'Invalid container ID' })
  })
export type Grant = z.infer<typeof grantSchema>
export function normalizeGrants(grants: Grant[]): Grant[] {
  const result = new Map<string, Grant>()
  for (const grant of grants) {
    result.set(JSON.stringify(grant), grant)
    if (grant.capability !== 'view') {
      const view = { ...grant, capability: 'view' as const }
      result.set(JSON.stringify(view), view)
    }
  }
  return [...result.values()]
}
export const hasServer = (u: User, capability: ServerCapability) =>
  u.admin || u.capabilities.includes(capability)
export function demandServer(u: User, capability: ServerCapability) {
  if (!hasServer(u, capability))
    throw new HTTPException(403, { message: 'Server permission required' })
}
export async function projectAccess(
  user: User,
  project: string,
  db: Pick<PoolClient, 'query'> = pool,
) {
  const row = (
    await db.query(
      `SELECT p.*,m.role FROM projects p LEFT JOIN memberships m
    ON m.project_slug=p.slug AND m.user_id=$2 WHERE p.slug=$1`,
      [project, user.id],
    )
  ).rows[0]
  if (!row || (!hasServer(user, 'projects.manage') && !row.role))
    throw new HTTPException(404, { message: 'Project not found' })
  return {
    ...row,
    can_manage_access:
      hasServer(user, 'projects.manage') || row.role === 'admin',
  }
}
export async function demandProjectAdmin(
  user: User,
  project: string,
  db: Pick<PoolClient, 'query'> = pool,
) {
  const access = await projectAccess(user, project, db)
  if (!access.can_manage_access)
    throw new HTTPException(403, {
      message: 'Project Administrator permission required',
    })
  return access
}
// The outer query must use the effective inventory alias, never raw Docker labels.
export const visibleContainer = `($2::boolean OR EXISTS (
  SELECT 1 FROM memberships m WHERE m.user_id=$3 AND m.project_slug=inventory.project AND m.role='admin'
  ) OR EXISTS (SELECT 1 FROM container_grants g
    WHERE g.user_id=$3 AND g.project_slug=inventory.project AND g.capability='view' AND
    (g.kind='all' OR (g.connector_id=inventory.connector_id AND
      ((g.kind='id' AND g.target=inventory.container_id) OR (g.kind='name' AND g.target=inventory.data->>'name')))))
    OR EXISTS (SELECT 1 FROM service_grants sg JOIN services s ON s.project_slug=sg.project_slug AND s.slug=inventory.application
      WHERE sg.user_id=$3 AND sg.project_slug=inventory.project AND sg.capability='read' AND (sg.service IS NULL OR sg.service=s.slug)))`

// All permission/account mutations share this lock. Re-read the actor after locking,
// so a request waiting behind a revocation cannot use stale authority.
export async function permissionTransaction<T>(
  actor: User,
  fn: (db: PoolClient, current: User) => Promise<T>,
) {
  return transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(842193)')
    const current = (
      await db.query<User>(
        'SELECT id,username,admin,capabilities FROM users WHERE id=$1 AND NOT disabled',
        [actor.id],
      )
    ).rows[0]
    if (!current)
      throw new HTTPException(401, { message: 'Authentication required' })
    return fn(db, current)
  })
}
export async function protectAdministrators(
  db: PoolClient,
  before: { server: number; projects: string[] },
) {
  if (
    before.server &&
    !(
      await db.query('SELECT 1 FROM users WHERE admin AND NOT disabled LIMIT 1')
    ).rowCount
  )
    throw new HTTPException(409, {
      message: 'Cannot remove the last active Server Administrator',
    })
  for (const project of before.projects) {
    if (
      !(
        await db.query(
          `SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.project_slug=$1 AND m.role='admin' AND NOT u.disabled LIMIT 1`,
          [project],
        )
      ).rowCount
    )
      throw new HTTPException(409, {
        message: 'Cannot remove the last active Project Administrator',
      })
  }
}
export async function administratorState(db: PoolClient) {
  return {
    server:
      (
        await db.query(
          'SELECT 1 FROM users WHERE admin AND NOT disabled LIMIT 1',
        )
      ).rowCount ?? 0,
    projects: (
      await db.query(
        `SELECT DISTINCT m.project_slug FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.role='admin' AND NOT u.disabled`,
      )
    ).rows.map((r) => r.project_slug as string),
  }
}
