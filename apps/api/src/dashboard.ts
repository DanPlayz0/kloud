import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { slug } from '@dedi-dash/protocol'
import { pool } from './db.js'
import { requireUser, type Env } from './auth.js'
import { digest, token, publicOrigin } from './security.js'
import {
  hasServer,
  demandServer,
  projectAccess,
  visibleContainer,
  capabilitySchema,
  permissionTransaction,
  administratorState,
  protectAdministrators,
} from './permissions.js'
import { projectPermissions } from './project-permissions.js'
import { services } from './services.js'
import { serviceAccess } from './service-permissions.js'
import { dns } from './dns.js'

export const dashboard = new Hono<Env>()
dashboard.use('*', requireUser)
dashboard.route('/', dns)
dashboard.use('/admin/*', async (c, next) => {
  const section = c.req.path.split('/')[2]
  const capability = {
    users: 'users.manage',
    projects: 'projects.manage',
    connectors: 'connectors.manage',
    containers: 'inventory.manage',
  } as const
  const required =
    c.req.method === 'POST' && c.req.path === '/admin/projects'
      ? 'projects.create'
      : capability[section as keyof typeof capability]
  if (required) demandServer(c.get('user'), required)
  await next()
})
const uuid = z.string().uuid()
const username = z
  .string()
  .regex(/^[a-zA-Z0-9_.@-]{1,100}$/)
  .transform((s) => s.toLowerCase())
const projectBody = z.object({ slug, name: z.string().min(1).max(100) })

// Only effective assignments leave the API; all unlabeled inventory remains admin-only.
export const inventoryQuery = `SELECT c.id AS connector_id,c.name AS connector_name,c.host,c.docker_seen AS seen,
  (c.docker_seen IS NULL OR c.docker_seen < now()-interval '20 seconds' OR c.revoked) AS stale,
  i.container_id,i.data,
  COALESCE(p.slug, a.project_slug) AS project,
  CASE WHEN p.slug IS NOT NULL THEN i.data->>'application' ELSE a.application END AS application,
  CASE WHEN p.slug IS NOT NULL THEN 'label' WHEN a.project_slug IS NOT NULL THEN 'manual' ELSE NULL END AS assignment
  FROM inventory i JOIN connectors c ON c.id=i.connector_id
  LEFT JOIN projects p ON p.slug=i.data->>'project' AND i.data->>'application' IS NOT NULL
  LEFT JOIN assignments a ON a.connector_id=i.connector_id AND a.container_id=i.container_id`

dashboard.get('/projects', async (c) => {
  const u = c.get('user')
  return c.json(
    (
      await pool.query(
        `SELECT p.*,m.role,($1::boolean OR m.role='admin') IS TRUE AS can_manage_access FROM projects p
         LEFT JOIN memberships m ON m.project_slug=p.slug AND m.user_id=$2
         WHERE $1::boolean OR m.user_id IS NOT NULL ORDER BY p.name`,
        [hasServer(u, 'projects.manage'), u.id],
      )
    ).rows,
  )
})
dashboard.use('/projects/:project/*', async (c, next) => {
  const u = c.get('user')
  await projectAccess(u, c.req.param('project')!)
  await next()
})
dashboard.get('/projects/:project/containers', async (c) => {
  const result = await pool.query(
    `SELECT * FROM (${inventoryQuery}) inventory WHERE project=$1 AND ${visibleContainer} ORDER BY data->>'name',connector_name`,
    [
      c.req.param('project'),
      hasServer(c.get('user'), 'projects.manage'),
      c.get('user').id,
    ],
  )
  return c.json(result.rows)
})
dashboard.get('/projects/:project/applications/:application', async (c) => {
  const service = (
    await pool.query(
      'SELECT slug,name,type FROM services WHERE project_slug=$1 AND slug=$2',
      [c.req.param('project'), c.req.param('application')],
    )
  ).rows[0]
  const access = await serviceAccess(c.get('user'), c.req.param('project'))
  if (service && access.allows('read', service.slug))
    return c.json({
      ...service,
      can_update: access.allows('update', service.slug),
      can_deploy: access.allows('deploy', service.slug),
    })
  const found = (
    await pool.query(
      `SELECT 1 FROM (${inventoryQuery}) inventory WHERE project=$1 AND ${visibleContainer} AND application=$4 LIMIT 1`,
      [
        c.req.param('project'),
        hasServer(c.get('user'), 'projects.manage'),
        c.get('user').id,
        c.req.param('application'),
      ],
    )
  ).rowCount
  return found
    ? c.json({ slug: c.req.param('application') })
    : c.json({ error: 'Application not found' }, 404)
})

dashboard.route('/', projectPermissions)
dashboard.route('/', services)
dashboard.get('/admin/projects', async (c) =>
  c.json((await pool.query('SELECT * FROM projects ORDER BY name')).rows),
)
dashboard.post('/admin/projects', async (c) => {
  const body = projectBody.parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'projects.create')
    const created = await db.query(
      'INSERT INTO projects(slug,name) VALUES($1,$2) ON CONFLICT (slug) DO NOTHING RETURNING slug',
      [body.slug, body.name],
    )
    if (!created.rowCount)
      throw new HTTPException(409, {
        message:
          'A project with this slug already exists. Choose a different slug.',
      })
    await db.query(
      "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,$2,'admin')",
      [actor.id, body.slug],
    )
  })
  return c.json({ ok: true }, 201)
})
dashboard.get('/admin/users', async (c) =>
  c.json(
    (
      await pool.query(
        `SELECT u.id,u.username,u.admin,u.capabilities,u.disabled, EXISTS(SELECT 1 FROM passkeys WHERE user_id=u.id) AS enrolled, COALESCE((SELECT json_agg(project_slug ORDER BY project_slug) FROM memberships WHERE user_id=u.id),'[]') AS projects FROM users u ORDER BY username`,
      )
    ).rows,
  ),
)
dashboard.post('/admin/users', async (c) => {
  const body = z
    .object({
      username,
      admin: z.boolean().default(false),
      capabilities: capabilitySchema.default([]),
    })
    .strict()
    .parse(await c.req.json())
  const invitation = token()
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'users.manage')
    if (!actor.admin && (body.admin || body.capabilities.length))
      throw new HTTPException(403, {
        message: 'Only Server Administrators can grant server permissions',
      })
    const id = randomUUID()
    await db.query(
      'INSERT INTO users(id,username,admin,capabilities) VALUES($1,$2,$3,$4)',
      [id, body.username, body.admin, body.capabilities],
    )
    await db.query(
      `INSERT INTO invitations(token,user_id,expires) VALUES($1,$2,now()+interval '24 hours')`,
      [digest(invitation), id],
    )
  })
  return c.json({ enrollmentUrl: `${publicOrigin}/enroll#${invitation}` }, 201)
})
dashboard.put('/admin/users/:id', async (c) => {
  const id = uuid.parse(c.req.param('id'))
  const body = z
    .object({
      disabled: z.boolean(),
      projects: z.array(slug).max(100).optional(),
      admin: z.boolean().optional(),
      capabilities: capabilitySchema.optional(),
    })
    .strict()
    .parse(await c.req.json())
  if (id === c.get('user').id && body.disabled)
    return c.json({ error: 'You cannot disable your own account' }, 400)
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'users.manage')
    const target = (
      await db.query(
        'SELECT admin,capabilities FROM users WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0]
    if (!target) throw new HTTPException(404, { message: 'User not found' })
    if (
      !actor.admin &&
      (target.admin ||
        target.capabilities.length ||
        body.admin !== undefined ||
        body.capabilities !== undefined)
    )
      throw new HTTPException(403, {
        message:
          'Only Server Administrators can modify server privileges or privileged accounts',
      })
    if (body.projects !== undefined) demandServer(actor, 'projects.manage')
    const before = await administratorState(db)
    if (
      !(
        await db.query(
          'UPDATE users SET disabled=$1,admin=COALESCE($3,admin),capabilities=COALESCE($4,capabilities) WHERE id=$2 RETURNING id',
          [body.disabled, id, body.admin ?? null, body.capabilities ?? null],
        )
      ).rowCount
    )
      throw new HTTPException(404, { message: 'User not found' })
    if (body.projects !== undefined) {
      await db.query(
        'DELETE FROM memberships WHERE user_id=$1 AND NOT(project_slug=ANY($2::text[]))',
        [id, body.projects],
      )
      for (const project of new Set(body.projects))
        await db.query(
          'INSERT INTO memberships(user_id,project_slug) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [id, project],
        )
    }
    await protectAdministrators(db, before)
    if (body.disabled) {
      await db.query('DELETE FROM sessions WHERE user_id=$1', [id])
      await db.query('DELETE FROM challenges WHERE user_id=$1', [id])
      await db.query('DELETE FROM invitations WHERE user_id=$1', [id])
    }
  })
  return c.json({ ok: true })
})
dashboard.post('/admin/users/:id/enrollment', async (c) => {
  const id = uuid.parse(c.req.param('id')),
    invitation = token()
  if (id === c.get('user').id)
    return c.json(
      { error: 'Use the recovery CLI to reset your own enrollment' },
      400,
    )
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'users.manage')
    const user = (
      await db.query(
        'SELECT id,admin,capabilities FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
        [id],
      )
    ).rows[0]
    if (!user)
      throw new HTTPException(404, { message: 'Active user not found' })
    if (!actor.admin && (user.admin || user.capabilities.length))
      throw new HTTPException(403, {
        message: 'Cannot reset a privileged account',
      })
    await db.query('UPDATE users SET password_hash=NULL WHERE id=$1', [id])
    for (const table of ['sessions', 'passkeys', 'challenges', 'invitations'])
      await db.query(`DELETE FROM ${table} WHERE user_id=$1`, [id])
    await db.query(
      `INSERT INTO invitations(token,user_id,expires) VALUES($1,$2,now()+interval '24 hours')`,
      [digest(invitation), id],
    )
  })
  return c.json({ enrollmentUrl: `${publicOrigin}/enroll#${invitation}` })
})
dashboard.get('/admin/connectors', async (c) =>
  c.json(
    (
      await pool.query(
        `SELECT id,name,discovery,revoked,host,seen,(seen IS NULL OR seen<now()-interval '20 seconds' OR revoked) AS stale FROM connectors ORDER BY name`,
      )
    ).rows,
  ),
)
dashboard.post('/admin/connectors', async (c) => {
  const body = z
    .object({ name: z.string().min(1).max(100) })
    .parse(await c.req.json())
  const secret = token(),
    id = randomUUID()
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'connectors.manage')
    await db.query('INSERT INTO connectors(id,name,token) VALUES($1,$2,$3)', [
      id,
      body.name,
      digest(secret),
    ])
  })
  return c.json({ id, token: secret }, 201)
})
dashboard.put('/admin/connectors/:id', async (c) => {
  const id = uuid.parse(c.req.param('id'))
  const body = z
    .object({ discovery: z.boolean(), revoked: z.boolean() })
    .parse(await c.req.json())
  const updated = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      demandServer(actor, 'connectors.manage')
      return db.query(
        'UPDATE connectors SET discovery=$1,revoked=revoked OR $2 WHERE id=$3 RETURNING id',
        [body.discovery, body.revoked, id],
      )
    },
  )
  if (!updated.rowCount) return c.json({ error: 'Connector not found' }, 404)
  return c.json({ ok: true })
})
dashboard.get('/admin/containers', async (c) =>
  c.json(
    (
      await pool.query(
        `SELECT * FROM (${inventoryQuery}) inventory WHERE assignment IS NOT NULL OR connector_id IN (SELECT id FROM connectors WHERE discovery) ORDER BY connector_name,data->>'name'`,
      )
    ).rows,
  ),
)

dashboard.get('/admin/containers/projects', async (c) =>
  c.json(
    (await pool.query('SELECT slug,name FROM projects ORDER BY name')).rows,
  ),
)
dashboard.put('/admin/containers/:connector/:container', async (c) => {
  const connector = uuid.parse(c.req.param('connector')),
    container = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(c.req.param('container'))
  const body = z
    .object({ project: slug, application: slug })
    .nullable()
    .parse(await c.req.json())
  const result = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      demandServer(actor, 'inventory.manage')
      // Lock the connector before reading inventory, matching snapshot replacement.
      const enabled = (
        await db.query(
          'SELECT discovery FROM connectors WHERE id=$1 AND NOT revoked FOR UPDATE',
          [connector],
        )
      ).rows[0]
      const current = (
        await db.query(
          `SELECT * FROM (${inventoryQuery}) inventory WHERE connector_id=$1 AND container_id=$2`,
          [connector, container],
        )
      ).rows[0]
      if (!enabled?.discovery || !current || current.assignment === 'label')
        return false
      if (body)
        await db.query(
          'INSERT INTO assignments(connector_id,container_id,project_slug,application) VALUES($1,$2,$3,$4) ON CONFLICT(connector_id,container_id) DO UPDATE SET project_slug=$3,application=$4',
          [connector, container, body.project, body.application],
        )
      else
        await db.query(
          'DELETE FROM assignments WHERE connector_id=$1 AND container_id=$2',
          [connector, container],
        )
      return true
    },
  )
  return result
    ? c.json({ ok: true })
    : c.json({ error: 'Manual assignment unavailable for this container' }, 409)
})
