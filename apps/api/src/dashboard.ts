import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { slug } from '@dedi-dash/protocol'
import { pool, transaction } from './db.js'
import { requireUser, requireAdmin, type Env } from './auth.js'
import { digest, token, publicOrigin } from './security.js'

export const dashboard = new Hono<Env>()
dashboard.use('*', requireUser)
dashboard.use('/admin/*', requireAdmin)
const uuid = z.string().uuid()
const username = z
  .string()
  .regex(/^[a-zA-Z0-9_.@-]{1,100}$/)
  .transform((s) => s.toLowerCase())
const projectBody = z.object({ slug, name: z.string().min(1).max(100) })
const canAccess = async (id: string, admin: boolean, project: string) =>
  (
    await pool.query(
      `SELECT p.* FROM projects p WHERE slug=$1 AND ($2::boolean OR EXISTS(SELECT 1 FROM memberships WHERE user_id=$3 AND project_slug=p.slug))`,
      [project, admin, id],
    )
  ).rows[0]

// Only effective assignments leave the API; all unlabeled inventory remains admin-only.
export const inventoryQuery = `SELECT c.id AS connector_id,c.name AS connector_name,c.host,c.seen,
  (c.seen IS NULL OR c.seen < now()-interval '20 seconds' OR c.revoked) AS stale,
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
        'SELECT p.* FROM projects p WHERE $1::boolean OR EXISTS(SELECT 1 FROM memberships WHERE user_id=$2 AND project_slug=p.slug) ORDER BY p.name',
        [u.admin, u.id],
      )
    ).rows,
  )
})
dashboard.use('/projects/:project/*', async (c, next) => {
  const u = c.get('user')
  if (!(await canAccess(u.id, u.admin, c.req.param('project')!)))
    return c.json({ error: 'Project not found' }, 404)
  await next()
})
dashboard.get('/projects/:project/containers', async (c) => {
  const result = await pool.query(
    `SELECT * FROM (${inventoryQuery}) inventory WHERE project=$1 ORDER BY data->>'name',connector_name`,
    [c.req.param('project')],
  )
  return c.json(result.rows)
})
dashboard.get('/projects/:project/applications/:application', async (c) => {
  const found = (
    await pool.query(
      `SELECT 1 FROM (${inventoryQuery}) inventory WHERE project=$1 AND application=$2 LIMIT 1`,
      [c.req.param('project'), c.req.param('application')],
    )
  ).rowCount
  return found
    ? c.json({ slug: c.req.param('application') })
    : c.json({ error: 'Application not found' }, 404)
})
dashboard.get('/admin/projects', async (c) =>
  c.json((await pool.query('SELECT * FROM projects ORDER BY name')).rows),
)
dashboard.post('/admin/projects', async (c) => {
  const body = projectBody.parse(await c.req.json())
  await pool.query('INSERT INTO projects(slug,name) VALUES($1,$2)', [
    body.slug,
    body.name,
  ])
  return c.json({ ok: true }, 201)
})
dashboard.get('/admin/users', async (c) =>
  c.json(
    (
      await pool.query(
        `SELECT u.id,u.username,u.admin,u.disabled, EXISTS(SELECT 1 FROM passkeys WHERE user_id=u.id) AS enrolled, COALESCE((SELECT json_agg(project_slug ORDER BY project_slug) FROM memberships WHERE user_id=u.id),'[]') AS projects FROM users u ORDER BY username`,
      )
    ).rows,
  ),
)
dashboard.post('/admin/users', async (c) => {
  const body = z
    .object({ username, admin: z.boolean().default(false) })
    .parse(await c.req.json())
  const invitation = token()
  await transaction(async (db) => {
    const id = randomUUID()
    await db.query('INSERT INTO users(id,username,admin) VALUES($1,$2,$3)', [
      id,
      body.username,
      body.admin,
    ])
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
    .object({ disabled: z.boolean(), projects: z.array(slug).max(100) })
    .parse(await c.req.json())
  if (id === c.get('user').id && body.disabled)
    return c.json({ error: 'You cannot disable your own account' }, 400)
  await transaction(async (db) => {
    if (
      !(
        await db.query(
          'UPDATE users SET disabled=$1 WHERE id=$2 RETURNING id',
          [body.disabled, id],
        )
      ).rowCount
    )
      throw new HTTPException(404, { message: 'User not found' })
    await db.query('DELETE FROM memberships WHERE user_id=$1', [id])
    for (const project of new Set(body.projects))
      await db.query(
        'INSERT INTO memberships(user_id,project_slug) VALUES($1,$2)',
        [id, project],
      )
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
  await transaction(async (db) => {
    const user = (
      await db.query(
        'SELECT id FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
        [id],
      )
    ).rows[0]
    if (!user)
      throw new HTTPException(404, { message: 'Active user not found' })
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
  await pool.query('INSERT INTO connectors(id,name,token) VALUES($1,$2,$3)', [
    id,
    body.name,
    digest(secret),
  ])
  return c.json({ id, token: secret }, 201)
})
dashboard.put('/admin/connectors/:id', async (c) => {
  const id = uuid.parse(c.req.param('id'))
  const body = z
    .object({ discovery: z.boolean(), revoked: z.boolean() })
    .parse(await c.req.json())
  if (
    !(
      await pool.query(
        'UPDATE connectors SET discovery=$1,revoked=revoked OR $2 WHERE id=$3 RETURNING id',
        [body.discovery, body.revoked, id],
      )
    ).rowCount
  )
    return c.json({ error: 'Connector not found' }, 404)
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
  const result = await transaction(async (db) => {
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
  })
  return result
    ? c.json({ ok: true })
    : c.json({ error: 'Manual assignment unavailable for this container' }, 409)
})
