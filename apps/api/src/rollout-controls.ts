import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { requireUser, type Env } from './auth.js'
import { pool } from './db.js'
import { permissionTransaction } from './permissions.js'
import { demandService } from './service-permissions.js'
export const rolloutControls = new Hono<Env>()
rolloutControls.use('*', requireUser)
const base = '/projects/:project/services/:service'
rolloutControls.get(`${base}/queue`, async (c) => {
  await demandService(
    c.get('user'),
    c.req.param('project'),
    'read',
    c.req.param('service'),
  )
  const args = [c.req.param('project'), c.req.param('service')]
  return c.json({
    release:
      (
        await pool.query(
          'SELECT serving,paused,reason,updated FROM service_release_state WHERE project=$1 AND service=$2',
          args,
        )
      ).rows[0] ?? null,
    runs: (
      await pool.query(
        `SELECT r.id,r.revision,r.commit,r.receipt_order,r.status,r.created,x.stage,x.candidate,x.previous FROM service_runs r JOIN service_revisions v ON v.id=r.revision LEFT JOIN service_rollouts x ON x.run=r.id WHERE v.project=$1 AND v.service=$2 ORDER BY r.receipt_order DESC LIMIT 50`,
        args,
      )
    ).rows,
  })
})
rolloutControls.post(`${base}/runs/:id/cancel`, async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'))
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    const cancelled = await db.query(
      `UPDATE service_runs r SET status='failed',finished=now(),log='Cancelled explicitly before execution' FROM service_revisions v WHERE r.id=$1 AND r.revision=v.id AND v.project=$2 AND v.service=$3 AND r.status='queued' RETURNING r.id`,
      [id, c.req.param('project'), c.req.param('service')],
    )
    if (!cancelled.rowCount)
      throw new HTTPException(409, {
        message: 'Only a queued run can be cancelled',
      })
  })
  return c.json({ cancelled: true })
})
