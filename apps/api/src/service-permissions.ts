import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import type { PoolClient } from 'pg'
import type { User } from './auth.js'
import { pool } from './db.js'
import { projectAccess } from './permissions.js'
import { slug } from '@dedi-dash/protocol'

export const serviceCapabilities = [
  'read',
  'create',
  'update',
  'delete',
  'deploy',
] as const
export const serviceGrantSchema = z
  .object({
    capability: z.enum(serviceCapabilities),
    service: slug.nullable(),
  })
  .strict()
  .refine(
    (g) => g.capability !== 'create' || g.service === null,
    'Create permission must apply to the project',
  )
export const serviceGrantsSchema = z.array(serviceGrantSchema).max(200)

export function normalizeServiceGrants(
  grants: z.infer<typeof serviceGrantsSchema>,
) {
  const normalized = new Map<string, z.infer<typeof serviceGrantSchema>>()
  for (const g of grants) {
    normalized.set(JSON.stringify(g), g)
    if (
      g.capability === 'update' ||
      g.capability === 'delete' ||
      g.capability === 'deploy'
    ) {
      const read = { ...g, capability: 'read' as const }
      normalized.set(JSON.stringify(read), read)
    }
  }
  return [...normalized.values()]
}

export async function serviceAccess(
  user: User,
  project: string,
  db: Pick<PoolClient, 'query'> = pool,
) {
  const access = await projectAccess(user, project, db)
  const grants = (
    await db.query<{
      capability: (typeof serviceCapabilities)[number]
      service: string | null
    }>(
      'SELECT capability,service FROM service_grants WHERE user_id=$1 AND project_slug=$2',
      [user.id, project],
    )
  ).rows
  return {
    allows: (
      capability: (typeof serviceCapabilities)[number],
      service: string | null = null,
    ) =>
      access.can_manage_access ||
      grants.some(
        (g) =>
          g.capability === capability &&
          (g.service === null || g.service === service),
      ),
  }
}

export async function demandService(
  user: User,
  project: string,
  capability: (typeof serviceCapabilities)[number],
  service: string | null,
  db: Pick<PoolClient, 'query'> = pool,
) {
  if (!(await serviceAccess(user, project, db)).allows(capability, service))
    throw new HTTPException(capability === 'read' ? 404 : 403, {
      message:
        capability === 'read'
          ? 'Service not found'
          : 'Service permission required',
    })
  if (
    service !== null &&
    !(
      await db.query(
        'SELECT 1 FROM services WHERE project_slug=$1 AND slug=$2',
        [project, service],
      )
    ).rowCount
  )
    throw new HTTPException(404, { message: 'Service not found' })
}
