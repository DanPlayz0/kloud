import { HTTPException } from 'hono/http-exception'
import type { PoolClient } from 'pg'
import type { User } from './auth.js'
import { demandServer } from './permissions.js'
import { demandService } from './service-permissions.js'

export async function demandGitCreation(
  db: Pick<PoolClient, 'query'>,
  actor: User,
  project: string,
  service?: string,
) {
  demandServer(actor, 'git.create')
  if (service) await demandService(actor, project, 'deploy', service, db)
  else {
    demandServer(actor, 'git.manage')
    if (
      !(await db.query('SELECT 1 FROM projects WHERE slug=$1', [project]))
        .rowCount
    )
      throw new HTTPException(404, { message: 'Project not found' })
  }
}
export function demandGitSharing(
  actor: User,
  scope: string,
  projectAccess: boolean,
) {
  if (scope === 'shared' || projectAccess) demandServer(actor, 'git.manage')
  if (projectAccess && scope !== 'shared')
    throw new HTTPException(400, {
      message: 'Only shared connections can be available to project deployers.',
    })
}
