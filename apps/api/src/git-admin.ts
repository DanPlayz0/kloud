import {
  validateGitAvailability,
  saveGitAvailability,
} from './git-availability.js'
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
  SELECT c.id,c.project,p.name AS project_name,c.name,c.provider,c.origin,c.owner,u.username AS owner_name,c.identity,c.created,c.revoked,c.project_access,c.all_projects,
    ARRAY(SELECT g.project FROM git_connection_projects g WHERE g.connection=c.id ORDER BY g.project) AS available_projects,
    (SELECT count(*)::int FROM git_repository_bindings b WHERE b.connection=c.id) AS bindings
  FROM git_connections c LEFT JOIN projects p ON p.slug=c.project LEFT JOIN users u ON u.id=c.owner ORDER BY c.created DESC,c.id
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
      all_projects: z.boolean().optional(),
      available_projects: z
        .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
        .max(1000)
        .optional(),
      revoked: z.literal(true).optional(),
    })
    .strict()
    .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'git.manage')
    const row = (
      await db.query(
        'SELECT owner,project,all_projects,ARRAY(SELECT project FROM git_connection_projects WHERE connection=$1 ORDER BY project) AS available_projects FROM git_connections WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0]
    if (!row) throw new HTTPException(404)
    if (
      body.available_projects !== undefined ||
      body.all_projects !== undefined ||
      body.project_access !== undefined
    ) {
      let projects: string[] = body.available_projects ?? row.available_projects
      if (
        body.available_projects === undefined &&
        body.project_access !== undefined
      ) {
        if (body.project_access && !row.project)
          throw new HTTPException(400, {
            message: 'Select the projects that may use this saved connection.',
          })
        projects = projects.filter((project) => project !== row.project)
        if (body.project_access) projects.push(row.project)
      }
      const availability = await validateGitAvailability(
        db,
        actor,
        row.owner ? 'personal' : 'shared',
        row.project ?? '',
        false,
        projects,
        body.all_projects ?? row.all_projects,
      )
      await saveGitAvailability(db, id, availability)
    }
    await db.query(
      'UPDATE git_connections SET name=COALESCE($2,name),revoked=COALESCE($3,revoked) WHERE id=$1',
      [id, body.name ?? null, body.revoked ?? null],
    )
  })
  return c.json({ saved: true })
})
