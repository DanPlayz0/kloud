import type { PoolClient } from 'pg'
import { HTTPException } from 'hono/http-exception'
import { normalizePm2Grants, type Pm2Grant } from '@dedi-dash/protocol/pm2'

export async function savePm2Grants(
  db: PoolClient,
  user: string,
  project: string,
  grants?: Pm2Grant[],
) {
  if (grants === undefined) return
  const normalized = normalizePm2Grants(grants)
  if (normalized.length > 200)
    throw new HTTPException(400, {
      message: 'At most 200 PM2 grants including implied View grants',
    })
  for (const grant of normalized) {
    if (
      grant.app !== null &&
      !(
        await db.query(
          'SELECT 1 FROM pm2_apps WHERE id=$1 AND project_slug=$2',
          [grant.app, project],
        )
      ).rowCount
    )
      throw new HTTPException(400, {
        message: 'PM2 app does not belong to this project',
      })
  }
  await db.query(
    'DELETE FROM pm2_grants WHERE user_id=$1 AND project_slug=$2',
    [user, project],
  )
  for (const g of normalized)
    await db.query(
      'INSERT INTO pm2_grants(user_id,project_slug,capability,app) VALUES($1,$2,$3,$4)',
      [user, project, g.capability, g.app],
    )
}
