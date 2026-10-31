import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { slug } from '@dedi-dash/protocol'
import type { Env } from './auth.js'
import { pool } from './db.js'
import { permissionTransaction } from './permissions.js'
import { serviceAccess, demandService } from './service-permissions.js'

export const serviceBody = z
  .object({
    slug,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(''),
    type: z.enum(['application', 'compose']),
  })
  .strict()
export const serviceUpdateBody = serviceBody.omit({ slug: true, type: true })
export const services = new Hono<Env>()
const base = '/projects/:project/services'

services.get(base, async (c) => {
  const access = await serviceAccess(c.get('user'), c.req.param('project'))
  const rows = (
    await pool.query(
      `SELECT s.*,d.config->>'repository' AS repository,d.config->>'branch' AS branch,
        COALESCE(platform_run.status,latest.status) AS deployment_status,COALESCE(platform_run.created,latest.created) AS last_deployment,
        revision.source_label
        FROM services s LEFT JOIN deployments d ON d.project=s.project_slug AND d.application=s.slug
        LEFT JOIN LATERAL (SELECT status,created FROM deployment_builds WHERE deployment_id=d.id ORDER BY created DESC,id DESC LIMIT 1) latest ON true
        LEFT JOIN LATERAL (SELECT source_label FROM service_revisions WHERE project=s.project_slug AND service=s.slug ORDER BY created DESC,id DESC LIMIT 1) revision ON true
        LEFT JOIN LATERAL (SELECT r.status,r.created FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE v.project=s.project_slug AND v.service=s.slug ORDER BY r.created DESC,r.id DESC LIMIT 1) platform_run ON true
        WHERE s.project_slug=$1 ORDER BY s.name,s.slug`,
      [c.req.param('project')],
    )
  ).rows
  return c.json({
    can_create: access.allows('create'),
    can_deploy_all: access.allows('deploy'),
    services: rows
      .filter((row) => access.allows('read', row.slug))
      .map((row) => ({
        ...row,
        can_update: access.allows('update', row.slug),
        can_delete: access.allows('delete', row.slug),
        can_deploy: access.allows('deploy', row.slug),
      })),
  })
})
services.post(base, async (c) => {
  const body = serviceBody.parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(actor, c.req.param('project'), 'create', null, db)
    await db.query(
      'INSERT INTO services(project_slug,slug,name,description,type) VALUES($1,$2,$3,$4,$5)',
      [
        c.req.param('project'),
        body.slug,
        body.name,
        body.description,
        body.type,
      ],
    )
    // Creators can manage their own service, without gaining project-wide access.
    for (const capability of ['read', 'update', 'delete'])
      await db.query(
        'INSERT INTO service_grants(user_id,project_slug,capability,service) SELECT user_id,project_slug,$3,$4 FROM memberships WHERE user_id=$1 AND project_slug=$2 ON CONFLICT DO NOTHING',
        [actor.id, c.req.param('project'), capability, body.slug],
      )
  })
  return c.json({ ok: true }, 201)
})
services.get(`${base}/:service/connectors`, async (c) => {
  await demandService(
    c.get('user'),
    c.req.param('project'),
    'deploy',
    c.req.param('service'),
  )
  return c.json(
    (
      await pool.query(
        'SELECT id,name FROM connectors WHERE NOT revoked ORDER BY name',
      )
    ).rows,
  )
})
services.put(`${base}/:service`, async (c) => {
  const body = serviceUpdateBody.parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'update',
      c.req.param('service'),
      db,
    )
    if (
      !(
        await db.query(
          'UPDATE services SET name=$3,description=$4 WHERE project_slug=$1 AND slug=$2 RETURNING slug',
          [
            c.req.param('project'),
            c.req.param('service'),
            body.name,
            body.description,
          ],
        )
      ).rowCount
    )
      throw new HTTPException(404, { message: 'Service not found' })
  })
  return c.json({ ok: true })
})
services.delete(`${base}/:service`, async (c) => {
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'delete',
      c.req.param('service'),
      db,
    )
    const deployment = (
      await db.query(
        'SELECT id FROM deployments WHERE project=$1 AND application=$2 FOR UPDATE',
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    const revisions = await db.query(
      'SELECT id FROM service_revisions WHERE project=$1 AND service=$2 FOR UPDATE',
      [c.req.param('project'), c.req.param('service')],
    )
    if (
      (
        await db.query(
          "SELECT 1 FROM service_runs WHERE revision=ANY($1::uuid[]) AND status='running'",
          [revisions.rows.map((r) => r.id)],
        )
      ).rowCount
    )
      throw new HTTPException(409, {
        message: 'Wait for the running deployment before removing this service',
      })
    if (
      deployment &&
      (
        await db.query(
          "SELECT 1 FROM deployment_builds WHERE deployment_id=$1 AND status='running'",
          [deployment.id],
        )
      ).rowCount
    )
      throw new HTTPException(409, {
        message: 'Wait for the running deployment before removing this service',
      })
    if (
      !(
        await db.query(
          'DELETE FROM services WHERE project_slug=$1 AND slug=$2 RETURNING slug',
          [c.req.param('project'), c.req.param('service')],
        )
      ).rowCount
    )
      throw new HTTPException(404, { message: 'Service not found' })
    await db.query(
      'DELETE FROM service_grants WHERE project_slug=$1 AND service=$2',
      [c.req.param('project'), c.req.param('service')],
    )
    if (deployment)
      await db.query('DELETE FROM deployments WHERE id=$1', [deployment.id])
  })
  return c.json({ ok: true })
})
