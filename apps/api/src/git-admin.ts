import { Hono } from 'hono'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import { requireUser, type Env } from './auth.js'
import { pool } from './db.js'
import { demandServer, permissionTransaction } from './permissions.js'

export const gitAdmin = new Hono<Env>()
const path = '/admin/git-connections'
gitAdmin.use(`${path}*`, requireUser)
gitAdmin.use(`${path}*`, async (c, next) => {
  demandServer(c.get('user'), 'git.manage')
  await next()
})
gitAdmin.get(`${path}/projects`, async (c) =>
  c.json(
    (await pool.query('SELECT slug,name FROM projects ORDER BY name,slug'))
      .rows,
  ),
)
gitAdmin.get(path, async (c) =>
  c.json(
    (
      await pool.query(`
  SELECT c.id,c.project,p.name AS project_name,c.name,c.provider,c.origin,c.owner,u.username AS owner_name,c.identity,c.created,c.revoked,c.project_access,
    (SELECT count(*)::int FROM git_repository_bindings b WHERE b.connection=c.id) AS bindings
  FROM git_connections c JOIN projects p ON p.slug=c.project LEFT JOIN users u ON u.id=c.owner ORDER BY c.created DESC,c.id
`)
    ).rows,
  ),
)
gitAdmin.put(`${path}/:id`, async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'))
  const body = z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      project_access: z.boolean().optional(),
      revoked: z.literal(true).optional(),
    })
    .strict()
    .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'git.manage')
    const row = (
      await db.query(
        'SELECT owner FROM git_connections WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0]
    if (!row) throw new HTTPException(404)
    if (body.project_access && row.owner)
      throw new HTTPException(400, {
        message:
          'Only shared connections can be available to project deployers.',
      })
    await db.query(
      'UPDATE git_connections SET name=COALESCE($2,name),project_access=COALESCE($3,project_access),revoked=COALESCE($4,revoked) WHERE id=$1',
      [
        id,
        body.name ?? null,
        body.project_access ?? null,
        body.revoked ?? null,
      ],
    )
  })
  return c.json({ saved: true })
})
