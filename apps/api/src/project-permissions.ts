import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { Env } from './auth.js'
import { pool } from './db.js'
import { dnsGrantsSchema } from '@dedi-dash/protocol/dns'
import { saveDnsGrants } from './dns.js'
import {
  serviceGrantsSchema,
  normalizeServiceGrants,
} from './service-permissions.js'
import { digest, token, publicOrigin } from './security.js'
import {
  administratorState,
  demandProjectAdmin,
  demandServer,
  grantSchema,
  normalizeGrants,
  permissionTransaction,
  protectAdministrators,
} from './permissions.js'

export const projectPermissions = new Hono<Env>()
export const memberBody = z
  .object({
    role: z.enum(['member', 'admin']),
    service_grants: serviceGrantsSchema.optional(),
    dns_grants: dnsGrantsSchema.optional(),
    grants: z
      .array(grantSchema)
      .max(200)
      .refine(
        (grants) => normalizeGrants(grants).length <= 200,
        'At most 200 grants including implied View grants',
      ),
  })
  .strict()
export const projectInviteBody = memberBody.extend({
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_.@-]{1,100}$/)
    .transform((s) => s.toLowerCase()),
})
export const settingsBody = z
  .object({ grant_mode: z.enum(['id', 'name']) })
  .strict()
const memberId = z.string().uuid()

async function saveGrants(
  db: PoolClient,
  user: string,
  project: string,
  grants: z.infer<typeof grantSchema>[],
) {
  await db.query(
    'DELETE FROM container_grants WHERE user_id=$1 AND project_slug=$2',
    [user, project],
  )
  for (const g of normalizeGrants(grants))
    await db.query(
      `INSERT INTO container_grants(id,user_id,project_slug,capability,kind,connector_id,target)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        user,
        project,
        g.capability,
        g.kind,
        g.connector_id,
        g.target,
      ],
    )
}

async function saveServiceGrants(
  db: PoolClient,
  user: string,
  project: string,
  grants: z.infer<typeof serviceGrantsSchema> | undefined,
) {
  if (grants === undefined) return
  for (const g of grants) {
    if (
      g.service !== null &&
      !(
        await db.query(
          'SELECT 1 FROM services WHERE project_slug=$1 AND slug=$2',
          [project, g.service],
        )
      ).rowCount
    )
      throw new HTTPException(400, {
        message: 'Service does not belong to this project',
      })
  }
  await db.query(
    'DELETE FROM service_grants WHERE user_id=$1 AND project_slug=$2',
    [user, project],
  )
  for (const g of normalizeServiceGrants(grants))
    await db.query(
      'INSERT INTO service_grants(user_id,project_slug,capability,service) VALUES($1,$2,$3,$4)',
      [user, project, g.capability, g.service],
    )
}

projectPermissions.get('/projects/:project/access', async (c) => {
  const project = c.req.param('project')
  const settings = await demandProjectAdmin(c.get('user'), project)
  const members = (
    await pool.query(
      `SELECT u.id,u.username,u.disabled,m.role,
    COALESCE((SELECT json_agg(dg.rule) FROM dns_member_grants dg WHERE dg.user_id=u.id AND dg.project_slug=m.project_slug),'[]') AS dns_grants,
    COALESCE((SELECT json_agg(json_build_object('capability',sg.capability,'service',sg.service) ORDER BY sg.capability,sg.service) FROM service_grants sg WHERE sg.user_id=u.id AND sg.project_slug=m.project_slug),'[]') AS service_grants,
    COALESCE((SELECT json_agg(json_build_object('capability',g.capability,'kind',g.kind,'connector_id',g.connector_id,'target',g.target) ORDER BY g.capability,g.kind,g.target)
      FROM container_grants g WHERE g.user_id=u.id AND g.project_slug=m.project_slug),'[]') AS grants
    FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_slug=$1 ORDER BY u.username`,
      [project],
    )
  ).rows
  return c.json({ grant_mode: settings.grant_mode, members })
})

projectPermissions.put('/projects/:project/access/settings', async (c) => {
  const project = c.req.param('project'),
    body = settingsBody.parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandProjectAdmin(actor, project, db)
    await db.query('UPDATE projects SET grant_mode=$2 WHERE slug=$1', [
      project,
      body.grant_mode,
    ])
  })
  return c.json({ ok: true })
})

projectPermissions.post('/projects/:project/access/members', async (c) => {
  const project = c.req.param('project'),
    body = projectInviteBody.parse(await c.req.json())
  const result = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      await demandProjectAdmin(actor, project, db)
      // Match bootstrap's table locking: invitations must not race first-account setup.
      await db.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
      let user = (
        await db.query('SELECT id,disabled FROM users WHERE username=$1', [
          body.username,
        ])
      ).rows[0]
      let enrollmentUrl: string | undefined
      if (!user) {
        user = { id: randomUUID(), disabled: false }
        await db.query('INSERT INTO users(id,username) VALUES($1,$2)', [
          user.id,
          body.username,
        ])
        const invitation = token()
        await db.query(
          `INSERT INTO invitations(token,user_id,expires) VALUES($1,$2,now()+interval '24 hours')`,
          [digest(invitation), user.id],
        )
        enrollmentUrl = `${publicOrigin}/enroll#${invitation}`
      }
      if (user.disabled)
        throw new HTTPException(409, {
          message: 'Account unavailable; contact a Server Administrator',
        })
      if (
        (
          await db.query(
            'SELECT 1 FROM memberships WHERE user_id=$1 AND project_slug=$2',
            [user.id, project],
          )
        ).rowCount
      )
        throw new HTTPException(409, {
          message: 'User is already a project member',
        })
      await db.query(
        'INSERT INTO memberships(user_id,project_slug,role) VALUES($1,$2,$3)',
        [user.id, project, body.role],
      )
      await saveGrants(db, user.id, project, body.grants)
      await saveServiceGrants(db, user.id, project, body.service_grants)
      await saveDnsGrants(db, actor, user.id, project, body.dns_grants)
      return { ok: true, ...(enrollmentUrl ? { enrollmentUrl } : {}) }
    },
  )
  return c.json(result, 201)
})

projectPermissions.put('/projects/:project/access/members/:id', async (c) => {
  const project = c.req.param('project'),
    id = memberId.parse(c.req.param('id')),
    body = memberBody.parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandProjectAdmin(actor, project, db)
    const before = await administratorState(db)
    const updated = await db.query(
      'UPDATE memberships SET role=$3 WHERE user_id=$1 AND project_slug=$2 RETURNING user_id',
      [id, project, body.role],
    )
    if (!updated.rowCount)
      throw new HTTPException(404, { message: 'Member not found' })
    await saveGrants(db, id, project, body.grants)
    await saveServiceGrants(db, id, project, body.service_grants)
    await saveDnsGrants(db, actor, id, project, body.dns_grants)
    await protectAdministrators(db, before)
  })
  return c.json({ ok: true })
})

projectPermissions.delete(
  '/projects/:project/access/members/:id',
  async (c) => {
    const project = c.req.param('project'),
      id = memberId.parse(c.req.param('id'))
    await permissionTransaction(c.get('user'), async (db, actor) => {
      await demandProjectAdmin(actor, project, db)
      const before = await administratorState(db)
      if (
        !(
          await db.query(
            'DELETE FROM memberships WHERE user_id=$1 AND project_slug=$2 RETURNING user_id',
            [id, project],
          )
        ).rowCount
      )
        throw new HTTPException(404, { message: 'Member not found' })
      await protectAdministrators(db, before)
    })
    return c.json({ ok: true })
  },
)

projectPermissions.put('/admin/projects/:project', async (c) => {
  const body = z
    .object({ name: z.string().min(1).max(100) })
    .strict()
    .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'projects.manage')
    if (
      !(
        await db.query(
          'UPDATE projects SET name=$2 WHERE slug=$1 RETURNING slug',
          [c.req.param('project'), body.name],
        )
      ).rowCount
    )
      throw new HTTPException(404, { message: 'Project not found' })
  })
  return c.json({ ok: true })
})

projectPermissions.delete('/admin/projects/:project', async (c) => {
  await permissionTransaction(c.get('user'), async (db, actor) => {
    demandServer(actor, 'projects.manage')
    if (
      !(
        await db.query('DELETE FROM projects WHERE slug=$1 RETURNING slug', [
          c.req.param('project'),
        ])
      ).rowCount
    )
      throw new HTTPException(404, { message: 'Project not found' })
  })
  return c.json({ ok: true })
})
