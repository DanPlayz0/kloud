import {
  accountsEnabled,
  withAccounts,
  linkOrganizationAccount,
} from './global-accounts.js'
import { inviteAccount } from './account-invitations.js'
import {
  capabilitySchema,
  permissionTransaction,
  demandServer,
} from './permissions.js'
import { randomUUID } from 'node:crypto'
import { Hono, type MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { rawPool, pool } from './db.js'
import {
  requireUser,
  requireAdmin,
  requireIdentity,
  currentIdentity,
  type Env,
} from './auth.js'
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
      await rawPool.query(
        `ALTER TABLE kloud_organizations ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT ''; ALTER TABLE kloud_organizations ADD COLUMN IF NOT EXISTS website text NOT NULL DEFAULT ''`,
      )
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
): Promise<
  OrganizationContext & { name: string; description: string; website: string }
> {
  if (!slugSchema.safeParse(slug).success)
    throw new HTTPException(400, { message: 'Invalid organization' })
  await ensureOrganizationRegistry()
  const row = (
    await rawPool.query(
      'SELECT slug,name,description,website,schema_name AS schema FROM kloud_organizations WHERE slug=$1',
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
    description: organization.description,
    website: organization.website,
    api_url: organizationApiUrl(''),
  })
})
organizations.get('/organizations/lookup/:slug', async (c) => {
  const organization = await findOrganization(c.req.param('slug'))
  return c.json({ slug: organization.slug, name: organization.name })
})
const metadataSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).default(''),
  website: z
    .union([
      z.literal(''),
      z
        .url()
        .max(500)
        .refine((value) =>
          ['https:', 'http:'].includes(new URL(value).protocol),
        ),
    ])
    .default(''),
})
organizations.get('/organizations', requireIdentity, async (c) => {
  await ensureOrganizationRegistry()
  const identity = c.get('user')
  const rows = (
    await rawPool.query(
      'SELECT slug,name,description,website,schema_name AS schema FROM kloud_organizations ORDER BY name,slug',
    )
  ).rows
  const memberships = []
  for (const org of rows) {
    const member = await runWithOrganization(org, () =>
      pool.query(
        accountsEnabled()
          ? 'SELECT admin FROM users WHERE id=$1 AND NOT disabled AND NOT invitation_pending'
          : 'SELECT admin FROM users WHERE id=$1 AND NOT disabled',
        [identity.id],
      ),
    )
    if (member.rows[0])
      memberships.push({
        slug: org.slug,
        name: org.name,
        description: org.description,
        website: org.website,
        admin: member.rows[0].admin,
      })
  }
  return c.json(memberships)
})
organizations.patch(
  '/organizations/current',
  requireUser,
  requireAdmin,
  async (c) => {
    const body = metadataSchema
      .partial()
      .strict()
      .parse(await c.req.json())
    await permissionTransaction(c.get('user'), async (_db, actor) => {
      if (!actor.admin) throw new HTTPException(403)
      await ensureOrganizationRegistry()
      await rawPool.query(
        'UPDATE kloud_organizations SET name=COALESCE($2,name),description=COALESCE($3,description),website=COALESCE($4,website) WHERE slug=$1',
        [
          currentOrganization()?.slug ?? 'default',
          body.name ?? null,
          body.description ?? null,
          body.website ?? null,
        ],
      )
    })
    const organization = await findOrganization(
      currentOrganization()?.slug ?? 'default',
    )
    return c.json({
      slug: organization.slug,
      name: organization.name,
      description: organization.description,
      website: organization.website,
    })
  },
)
organizations.post('/organizations/invitations', requireUser, async (c) => {
  const body = z
    .object({ email: z.email().max(254), admin: z.boolean().default(false) })
    .strict()
    .parse(await c.req.json())
  const invite = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      demandServer(actor, 'users.manage')
      if (body.admin && !actor.admin) throw new HTTPException(403)
      return inviteAccount(
        db,
        actor,
        currentOrganization()?.slug ?? 'default',
        body,
      )
    },
  )
  const { sendInvitation } = await import('./invitation-email.js')
  const sent = await sendInvitation(invite.email, invite.invitationUrl)
  return c.json(
    { email: invite.email, invitationUrl: invite.invitationUrl, sent },
    201,
  )
})
organizations.post('/organizations', requireUser, requireAdmin, async (c) => {
  const body = metadataSchema
    .extend({
      slug: slugSchema
        .refine((s) => !['default', 'lookup'].includes(s))
        .optional(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .strict()
    .parse(await c.req.json())
  const identity = await currentIdentity(c)
  if (!identity) throw new HTTPException(401)
  await ensureOrganizationRegistry()
  const client = await rawPool.connect()
  const schema = `kloud_org_${randomUUID().replaceAll('-', '')}`
  let slug =
    body.slug ??
    body.name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 55)
      .replace(/-$/, '')
  if (!slug || ['default', 'lookup'].includes(slug)) slug = 'organization'
  const base = slug
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(842196)')
    const registrySchema = (
      await client.query('SELECT current_schema() AS schema')
    ).rows[0].schema as string
    const registry = `"${registrySchema.replaceAll('"', '""')}".kloud_organizations`
    if (!body.slug) {
      let suffix = 2
      while (
        (await client.query(`SELECT 1 FROM ${registry} WHERE slug=$1`, [slug]))
          .rowCount
      )
        slug = base + '-' + suffix++
    }
    await client.query(
      `INSERT INTO ${registry}(slug,name,schema_name,description,website) VALUES($1,$2,$3,$4,$5)`,
      [slug, body.name, schema, body.description, body.website],
    )
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query("SELECT set_config('search_path',$1,true)", [schema])
    const { migrateDatabase } = await import('./migrate.js')
    await migrateDatabase(client)
    if (accountsEnabled())
      await linkOrganizationAccount(client, identity, {
        admin: true,
        capabilities: [],
      })
    else {
      if (!body.username || !body.password)
        throw new HTTPException(400, {
          message: 'Run account migrations before creating organizations',
        })
      await client.query(
        'INSERT INTO users(id,username,password_hash,admin) VALUES($1,$2,$3,true)',
        [
          randomUUID(),
          body.username.toLowerCase(),
          await hashPassword(body.password),
        ],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return c.json(
    {
      slug,
      name: body.name,
      description: body.description,
      website: body.website,
    },
    201,
  )
})
export async function migrateAllOrganizations(
  runMigration?: () => Promise<void>,
  runMigrationDatabase?: (db: import('pg').PoolClient) => Promise<void>,
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
  const { initializeGlobalAccounts } = await import('./global-accounts.js')
  const migrateDatabase =
    runMigrationDatabase ?? (await import('./migrate.js')).migrateDatabase
  await initializeGlobalAccounts(migrateDatabase)
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
  if (accountsEnabled())
    await withAccounts(() =>
      pool.query(
        `WITH a AS (DELETE FROM challenges WHERE expires<now()),b AS (DELETE FROM sessions WHERE expires<now()),c AS (DELETE FROM invitations WHERE expires<now()),d AS (DELETE FROM auth_pending WHERE expires<now()),e AS (DELETE FROM login_attempts WHERE expires<now()) DELETE FROM organization_invitations WHERE expires<now()`,
      ),
    )
}
