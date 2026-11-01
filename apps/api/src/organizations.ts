import { randomUUID } from 'node:crypto'
import { Hono, type MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { rawPool, pool } from './db.js'
import { requireUser, requireAdmin, type Env } from './auth.js'
import { hashPassword, publicOrigin } from './security.js'
import {
  currentOrganization,
  runWithOrganization,
  type OrganizationContext,
} from './organization-context.js'

const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(63)
let registryReady: Promise<void> | undefined
export async function ensureOrganizationRegistry() {
  if (!registryReady)
    registryReady = (async () => {
      await rawPool.query(`CREATE TABLE IF NOT EXISTS kloud_organizations (
      slug text PRIMARY KEY, name text NOT NULL, schema_name text UNIQUE NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`)
      await rawPool.query(`INSERT INTO kloud_organizations(slug,name,schema_name)
      VALUES('default','Default organization',current_schema()) ON CONFLICT(slug) DO NOTHING`)
    })().catch((error) => {
      registryReady = undefined
      throw error
    })
  await registryReady
}
export async function findOrganization(
  slug: string,
): Promise<OrganizationContext & { name: string }> {
  if (!slugSchema.safeParse(slug).success)
    throw new HTTPException(400, { message: 'Invalid organization' })
  await ensureOrganizationRegistry()
  const row = (
    await rawPool.query(
      'SELECT slug,name,schema_name AS schema FROM kloud_organizations WHERE slug=$1',
      [slug],
    )
  ).rows[0]
  if (!row) throw new HTTPException(404, { message: 'Organization not found' })
  return row
}
export function organizationApiPrefix() {
  const slug = currentOrganization()?.slug
  return slug && slug !== 'default' ? `/organizations/${slug}` : ''
}
export function organizationApiUrl(path: string) {
  return `${publicOrigin}/api${organizationApiPrefix()}${path}`
}
export function organizationBrowserQuery() {
  const slug = currentOrganization()?.slug
  return slug && slug !== 'default'
    ? `?organization=${encodeURIComponent(slug)}`
    : ''
}
export const organizationMiddleware =
  (
    forward: (request: Request) => Promise<Response> | Response,
  ): MiddlewareHandler<Env> =>
  async (c, next) => {
    const match = c.req.path.startsWith('/organizations/lookup/')
      ? null
      : c.req.path.match(/^\/organizations\/([^/]+)(\/.*)$/)
    const header = c.req.header('x-kloud-organization')
    const slug = match?.[1] ?? header ?? c.req.query('organization')
    if (match && header && header !== match[1])
      throw new HTTPException(400, { message: 'Conflicting organization' })
    if (!slug || slug === 'default') {
      if (match) {
        const url = new URL(c.req.url)
        url.pathname = match[2]!
        return forward(new Request(url, c.req.raw))
      }
      return next()
    }
    const organization = await findOrganization(slug)
    return runWithOrganization(organization, async () => {
      if (match) {
        const url = new URL(c.req.url)
        url.pathname = match[2]!
        return forward(new Request(url, c.req.raw))
      }
      await next()
    })
  }
export const organizations = new Hono<Env>()
organizations.get('/organizations/current', async (c) => {
  const current = currentOrganization()
  const slug = current?.slug ?? 'default'
  const organization = await findOrganization(slug)
  return c.json({
    slug,
    name: organization.name,
    api_url: organizationApiUrl(''),
  })
})
organizations.get('/organizations/lookup/:slug', async (c) => {
  const organization = await findOrganization(c.req.param('slug'))
  return c.json({ slug: organization.slug, name: organization.name })
})
organizations.post('/organizations', requireUser, requireAdmin, async (c) => {
  const body = z
    .object({
      slug: slugSchema.refine((s) => !['default', 'lookup'].includes(s)),
      name: z.string().trim().min(1).max(100),
      username: z.string().regex(/^[a-zA-Z0-9_.@-]{1,100}$/),
      password: z.string().min(12).max(256),
    })
    .strict()
    .parse(await c.req.json())
  const password = await hashPassword(body.password)
  await ensureOrganizationRegistry()
  const client = await rawPool.connect()
  const schema = `kloud_org_${randomUUID().replaceAll('-', '')}`
  try {
    await client.query('BEGIN')
    const registrySchema = (
      await client.query('SELECT current_schema() AS schema')
    ).rows[0].schema as string
    // Generated/registered identifiers are quoted; user-provided slugs are values.
    const registry = `"${registrySchema.replaceAll('"', '""')}".kloud_organizations`
    await client.query(
      `INSERT INTO ${registry}(slug,name,schema_name) VALUES($1,$2,$3)`,
      [body.slug, body.name, schema],
    )
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query("SELECT set_config('search_path',$1,true)", [schema])
    const { migrateDatabase } = await import('./migrate.js')
    await migrateDatabase(client)
    await client.query(
      'INSERT INTO users(id,username,password_hash,admin) VALUES($1,$2,$3,true)',
      [randomUUID(), body.username.toLowerCase(), password],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return c.json({ slug: body.slug, name: body.name }, 201)
})
export async function migrateAllOrganizations(
  runMigration?: () => Promise<void>,
) {
  const execute = runMigration ?? (await import('./migrate.js')).migrate
  await execute()
  await ensureOrganizationRegistry()
  const rows = (
    await rawPool.query(
      "SELECT slug,schema_name AS schema FROM kloud_organizations WHERE slug<>'default'",
    )
  ).rows
  for (const organization of rows)
    await runWithOrganization(organization, () => execute())
}
export async function cleanOrganizationExpirations() {
  await ensureOrganizationRegistry()
  const rows = (
    await rawPool.query(
      'SELECT slug,schema_name AS schema FROM kloud_organizations',
    )
  ).rows
  for (const organization of rows)
    await runWithOrganization(organization, () =>
      pool.query(
        `WITH a AS (DELETE FROM challenges WHERE expires<now()), b AS (DELETE FROM sessions WHERE expires<now()), c AS (DELETE FROM invitations WHERE expires<now()), d AS (DELETE FROM setup_challenges WHERE expires<now()) DELETE FROM login_attempts WHERE expires<now()`,
      ),
    )
}
