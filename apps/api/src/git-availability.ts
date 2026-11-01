import { HTTPException } from 'hono/http-exception'
import type { PoolClient } from 'pg'
import type { User } from './auth.js'
import { demandGitSharing } from './git-permissions.js'

export interface GitAvailability {
  all_projects: boolean
  available_projects: string[]
}
type Database = Pick<PoolClient, 'query'>
export async function validateGitAvailability(
  db: Database,
  actor: User,
  scope: string,
  project: string,
  projectAccess: boolean,
  availableProjects?: string[],
  allProjects = false,
): Promise<GitAvailability> {
  demandGitSharing(
    actor,
    scope,
    projectAccess || allProjects || !!availableProjects?.length,
  )
  const projects = [
    ...new Set(availableProjects ?? (projectAccess ? [project] : [])),
  ].sort()
  if (projects.length) {
    const rows = await db.query(
      'SELECT slug FROM projects WHERE slug=ANY($1::text[])',
      [projects],
    )
    if (rows.rowCount !== projects.length)
      throw new HTTPException(400, {
        message: 'One or more selected projects no longer exist.',
      })
  }
  return { all_projects: allProjects, available_projects: projects }
}
export async function saveGitAvailability(
  db: Database,
  id: string,
  availability: GitAvailability,
) {
  await db.query(
    'UPDATE git_connections SET all_projects=$2,project_access=($2 OR COALESCE(project=ANY($3::text[]),false)) WHERE id=$1',
    [id, availability.all_projects, availability.available_projects],
  )
  await db.query('DELETE FROM git_connection_projects WHERE connection=$1', [
    id,
  ])
  if (availability.available_projects.length)
    await db.query(
      'INSERT INTO git_connection_projects(connection,project) SELECT $1,unnest($2::text[])',
      [id, availability.available_projects],
    )
}
