import { scopedApiUrl } from './organization-context.js'
import {
  validateGitAvailability,
  saveGitAvailability,
} from './git-availability.js'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { DeploymentConfig } from '@kloud/protocol'
import { requireUser, type Env, type User } from './auth.js'
import { pool } from './db.js'
import {
  permissionTransaction,
  projectAccess,
  hasServer,
} from './permissions.js'
import { demandGitCreation, demandGitSharing } from './git-permissions.js'
import { demandService } from './service-permissions.js'
import { publicOrigin } from './security.js'
import { seal, unseal } from './platform-secrets.js'
import {
  providerSchema,
  providerOrigin,
  repositoryFromUrl,
  repositoryName,
  providerRequest,
  accessToken,
  appJwt,
  getRepository,
  canonicalRepository,
  repositoryFile,
  type GitConnection,
  type Credentials,
  type Repository,
} from './git-provider.js'
import { suggestDockerfile } from './repository-suggestions.js'

type Database = Pick<PoolClient, 'query'>
const uuid = z.string().uuid()
const path = '/projects/:project/git-connections'
export const gitConnections = new Hono<Env>()
gitConnections.use('/projects/:project/git-connections*', requireUser)
async function connection(db: Database, project: string, id: string) {
  const row = (
    await db.query<GitConnection>(
      `SELECT c.*, (c.all_projects OR EXISTS(SELECT 1 FROM git_connection_projects g WHERE g.connection=c.id AND g.project=$2)) AS project_access FROM git_connections c WHERE c.id=$1 AND NOT c.revoked`,
      [id, project],
    )
  ).rows[0]
  if (!row)
    throw new HTTPException(404, {
      message: 'Git connection is missing or revoked.',
    })
  providerOrigin(row.provider, row.origin)
  if (
    row.owner &&
    !(
      await db.query(
        'SELECT 1 FROM users u WHERE u.id=$1 AND NOT u.disabled AND (u.admin OR EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.project_slug=$2))',
        [row.owner, project],
      )
    ).rowCount
  )
    throw new HTTPException(403, {
      message:
        'The personal connection owner is disabled or no longer a project member. Select another authorized connection.',
    })
  return row
}
async function usable(
  db: Database,
  user: User,
  project: string,
  service: string,
  id: string,
) {
  await demandService(user, project, 'deploy', service, db)
  const row = await connection(db, project, id)
  const broad =
    row.owner === user.id ||
    (!row.owner && (hasServer(user, 'git.manage') || row.project_access))
  const bindings = (
    await db.query<{ repository_id: string; repository: string }>(
      'SELECT repository_id,repository FROM git_repository_bindings WHERE connection=$1 AND project=$2 AND service=$3',
      [id, project, service],
    )
  ).rows
  if (!broad && !bindings.length)
    throw new HTTPException(403, {
      message: 'This connection has not been delegated to this app.',
    })
  return { row, broad, bindings }
}
function allowed(
  access: Awaited<ReturnType<typeof usable>>,
  repository: Repository,
) {
  if (
    !access.broad &&
    !access.bindings.some((binding) => binding.repository_id === repository.id)
  )
    throw new HTTPException(403, {
      message: 'This repository has not been delegated to this app.',
    })
}
async function legacySourceAllowed(
  db: Database,
  project: string,
  service: string,
  config: DeploymentConfig,
) {
  return !!(
    await db.query(
      'SELECT 1 FROM legacy_source_grants WHERE project=$1 AND service=$2 AND repository=$3 AND connector_id=$4',
      [project, service, config.repository, config.connector_id],
    )
  ).rowCount
}
export async function validateGitSource(
  db: Database,
  user: User,
  project: string,
  service: string,
  config: DeploymentConfig,
) {
  if (!config.connection_id) {
    if (user.admin) {
      await db.query(
        'INSERT INTO legacy_source_grants(project,service,repository,connector_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [project, service, config.repository, config.connector_id],
      )
      return
    }
    if (!(await legacySourceAllowed(db, project, service, config)))
      throw new HTTPException(403, {
        message:
          'New or changed legacy connector credentials require an administrator. Select an authorized repository connection instead.',
      })
    return
  }
  const access = await usable(db, user, project, service, config.connection_id)
  const token = await accessToken(
    access.row,
    unseal(access.row.encrypted_credentials),
  )
  const repository = await getRepository(access.row, token, config.repository)
  allowed(access, repository)
  if (
    config.repository_id !== repository.id ||
    (config.provider_url && config.provider_url !== access.row.origin)
  )
    throw new HTTPException(409, {
      message:
        'Repository identity changed. Validate and select the repository again.',
    })
  // Selecting a scoped credential explicitly retires the old broad connector-token authorization.
  await db.query(
    'DELETE FROM legacy_source_grants WHERE project=$1 AND service=$2',
    [project, service],
  )
  config.repository = repository.name
  config.provider_url = access.row.origin
  if (access.broad)
    await db.query(
      'INSERT INTO git_repository_bindings(connection,project,service,repository_id,repository) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [access.row.id, project, service, repository.id, repository.name],
    )
}
export async function autoDeployAvailable(
  db: Database,
  project: string,
  service: string,
  config: DeploymentConfig,
) {
  if (!config.enabled) return false
  if (!config.connection_id) return true
  const row = (
    await db.query(
      'SELECT webhook_mode,config FROM deployments WHERE project=$1 AND application=$2',
      [project, service],
    )
  ).rows[0]
  return (
    !!row &&
    row.config.connection_id === config.connection_id &&
    row.config.repository_id === config.repository_id &&
    ['automatic', 'manual', 'manual-verified'].includes(row.webhook_mode)
  )
}
export async function resolveGitSource(
  db: Database,
  project: string,
  service: string,
  config: DeploymentConfig,
) {
  if (!config.connection_id) {
    if (!(await legacySourceAllowed(db, project, service, config)))
      throw new HTTPException(403, {
        message:
          'Legacy source authorization was removed. Select an authorized repository connection.',
      })
    return undefined
  }
  const row = await connection(db, project, config.connection_id)
  if (
    !(
      await db.query(
        'SELECT 1 FROM git_repository_bindings WHERE connection=$1 AND project=$2 AND service=$3 AND repository_id=$4',
        [row.id, project, service, config.repository_id],
      )
    ).rowCount
  )
    throw new HTTPException(403, {
      message:
        'Repository delegation was revoked. Select an authorized connection before deployment.',
    })
  const credentials = unseal(row.encrypted_credentials) as Credentials
  const token = await accessToken(row, credentials)
  const repository = await getRepository(row, token, config.repository)
  if (
    repository.id !== config.repository_id ||
    (config.provider_url && config.provider_url !== row.origin)
  )
    throw new HTTPException(409, {
      message: 'Repository identity no longer matches the saved deployment.',
    })
  return { token, url: `${repository.url}.git`, username: credentials.username }
}

gitConnections.get(path, async (c) => {
  const project = c.req.param('project')
  const service = z.string().min(1).parse(c.req.query('service'))
  await demandService(c.get('user'), project, 'deploy', service)
  const rows = (
    await pool.query(
      `SELECT c.id,c.name,c.provider,c.origin,c.owner,c.identity,c.created FROM git_connections c
    WHERE NOT c.revoked AND (c.owner=$2 OR (c.owner IS NULL AND ($3 OR c.all_projects OR EXISTS(SELECT 1 FROM git_connection_projects g WHERE g.connection=c.id AND g.project=$1))) OR EXISTS(SELECT 1 FROM git_repository_bindings b WHERE b.connection=c.id AND b.project=$1 AND b.service=$4))
    AND (c.owner IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=c.owner AND NOT u.disabled AND (u.admin OR EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.project_slug=$1)))) ORDER BY c.name,c.id`,
      [
        project,
        c.get('user').id,
        hasServer(c.get('user'), 'git.manage'),
        service,
      ],
    )
  ).rows
  return c.json(rows)
})
gitConnections.post(path, async (c) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(100),
      provider: providerSchema,
      origin: z.string().optional(),
      scope: z.enum(['personal', 'shared']).default('personal'),
      service: z.string().min(1).optional(),
      project_access: z.boolean().default(false),
      all_projects: z.boolean().default(false),
      available_projects: z
        .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
        .max(1000)
        .optional(),
      token: z.string().min(1).max(4096).optional(),
      username: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+$/)
        .max(100)
        .optional(),
      app_id: z.string().regex(/^\d+$/).optional(),
      private_key: z.string().max(16000).optional(),
      installation_id: z.number().int().positive().optional(),
    })
    .strict()
    .parse(await c.req.json())
  const id = await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandGitCreation(db, actor, c.req.param('project'), body.service)
    const availability = await validateGitAvailability(
      db,
      actor,
      body.scope,
      c.req.param('project'),
      body.project_access,
      body.available_projects,
      body.all_projects,
    )
    const origin = providerOrigin(body.provider, body.origin)
    const credentials: Credentials =
      body.provider === 'github_app'
        ? {
            app_id: body.app_id,
            private_key: body.private_key,
            installation_id: body.installation_id,
          }
        : { token: body.token, username: body.username }
    if (
      body.provider === 'github_app'
        ? !credentials.app_id ||
          !credentials.private_key ||
          !credentials.installation_id
        : !credentials.token
    )
      throw new HTTPException(400, {
        message: 'Supply the selected provider’s required credentials.',
      })
    if (!body.provider.startsWith('github') && !body.username)
      throw new HTTPException(400, {
        message:
          'Provide the token owner’s username for HTTPS Git authentication.',
      })
    const row: GitConnection = {
      id: randomUUID(),
      provider: body.provider,
      origin,
      owner: body.scope === 'personal' ? actor.id : null,
      encrypted_credentials: seal(credentials),
    }
    let identity: unknown = {}
    // PAT direct URL flow deliberately does not call /user or repository listing.
    if (body.provider === 'github_app') {
      const installation = await providerRequest(
        row,
        appJwt(credentials),
        `/app/installations/${credentials.installation_id}`,
      )
      identity = {
        installation_id: installation.id,
        account: installation.account?.login,
        account_id: installation.account?.id,
        app_id: credentials.app_id,
      }
      await accessToken(row, credentials)
    }
    await db.query(
      'INSERT INTO git_connections(id,project,name,provider,origin,owner,encrypted_credentials,identity,project_access) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        row.id,
        c.req.param('project'),
        body.name,
        row.provider,
        row.origin,
        row.owner,
        row.encrypted_credentials,
        identity,
        false,
      ],
    )
    await saveGitAvailability(db, row.id, availability)
    return row.id
  })
  return c.json({ id }, 201)
})
gitConnections.delete(`${path}/:id`, async (c) => {
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await projectAccess(actor, c.req.param('project'), db)
    const row = await connection(
      db,
      c.req.param('project'),
      uuid.parse(c.req.param('id')),
    )
    if (row.owner ? row.owner !== actor.id : !hasServer(actor, 'git.manage'))
      throw new HTTPException(403)
    await db.query('UPDATE git_connections SET revoked=true WHERE id=$1', [
      row.id,
    ])
  })
  return c.json({ revoked: true })
})
gitConnections.post(`${path}/:id/repository`, async (c) => {
  const body = z
    .object({ service: z.string().min(1), url: z.string().max(500) })
    .strict()
    .parse(await c.req.json())
  const result = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      const access = await usable(
        db,
        actor,
        c.req.param('project'),
        body.service,
        uuid.parse(c.req.param('id')),
      )
      const token = await accessToken(
        access.row,
        unseal(access.row.encrypted_credentials),
      )
      const repository = await getRepository(
        access.row,
        token,
        repositoryFromUrl(body.url, access.row.origin),
      )
      allowed(access, repository)
      return repository
    },
  )
  return c.json(result)
})
gitConnections.get(`${path}/:id/repositories`, async (c) => {
  const service = z.string().min(1).parse(c.req.query('service'))
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(c.req.query('page') ?? 1)
  const search = (c.req.query('q') ?? '').slice(0, 200).toLowerCase()
  const result = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      const access = await usable(
        db,
        actor,
        c.req.param('project'),
        service,
        uuid.parse(c.req.param('id')),
      )
      const token = await accessToken(
        access.row,
        unseal(access.row.encrypted_credentials),
      )
      const endpoint =
        access.row.provider === 'github_app'
          ? `/installation/repositories?per_page=100&page=${page}`
          : `/user/repos?${access.row.provider === 'github' ? 'per_page' : 'limit'}=100&page=${page}`
      const data = await providerRequest(access.row, token, endpoint)
      const raw =
        access.row.provider === 'github_app' ? data.repositories : data
      if (!Array.isArray(raw))
        throw new HTTPException(502, {
          message: 'Unexpected repository listing response.',
        })
      const repositories = raw
        .map((repo) => canonicalRepository(repo, access.row.origin))
        .filter(
          (repo) =>
            (access.broad ||
              access.bindings.some(
                (binding) => binding.repository_id === repo.id,
              )) &&
            repo.name.toLowerCase().includes(search),
        )
      return { repositories, next_page: raw.length === 100 ? page + 1 : null }
    },
  )
  return c.json(result)
})
gitConnections.get(`${path}/:id/branches`, async (c) => {
  const service = z.string().min(1).parse(c.req.query('service'))
  const name = repositoryName.parse(c.req.query('repository'))
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(c.req.query('page') ?? 1)
  return c.json(
    await permissionTransaction(c.get('user'), async (db, actor) => {
      const access = await usable(
        db,
        actor,
        c.req.param('project'),
        service,
        uuid.parse(c.req.param('id')),
      )
      const token = await accessToken(
        access.row,
        unseal(access.row.encrypted_credentials),
      )
      allowed(access, await getRepository(access.row, token, name))
      const branches = await providerRequest(
        access.row,
        token,
        `/repos/${name}/branches?${access.row.provider.startsWith('github') ? 'per_page' : 'limit'}=100&page=${page}`,
      )
      return {
        branches: z
          .array(
            z
              .object({
                name: z.string(),
                commit: z
                  .object({
                    sha: z.string().optional(),
                    id: z.string().optional(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          )
          .parse(branches)
          .map((branch) => ({
            name: branch.name,
            commit: z.string().parse(branch.commit.sha ?? branch.commit.id),
          })),
        next_page: branches.length === 100 ? page + 1 : null,
      }
    }),
  )
})
gitConnections.put(`${path}/:id/delegations`, async (c) => {
  const body = z
    .object({
      service: z.string().min(1),
      repositories: z.array(repositoryName).max(100),
    })
    .strict()
    .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    const access = await usable(
      db,
      actor,
      c.req.param('project'),
      body.service,
      uuid.parse(c.req.param('id')),
    )
    if (
      access.row.owner
        ? access.row.owner !== actor.id
        : !hasServer(actor, 'git.manage')
    )
      throw new HTTPException(403, {
        message:
          'Only the connection owner or shared-connection administrator can change delegation.',
      })
    const token = await accessToken(
      access.row,
      unseal(access.row.encrypted_credentials),
    )
    const repositories = await Promise.all(
      body.repositories.map((name) => getRepository(access.row, token, name)),
    )
    await db.query(
      'DELETE FROM git_repository_bindings WHERE connection=$1 AND project=$2 AND service=$3',
      [access.row.id, c.req.param('project'), body.service],
    )
    for (const repo of repositories)
      await db.query(
        'INSERT INTO git_repository_bindings(connection,project,service,repository_id,repository) VALUES($1,$2,$3,$4,$5)',
        [
          access.row.id,
          c.req.param('project'),
          body.service,
          repo.id,
          repo.name,
        ],
      )
  })
  return c.json({ saved: true })
})
gitConnections.post(`${path}/:id/inspect`, async (c) => {
  const relative = z
    .string()
    .max(256)
    .refine(
      (value) =>
        value === '.' ||
        (/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
          !value.split('/').some((part) => part === '..' || part === '.')),
    )
  const body = z
    .object({
      service: z.string().min(1),
      repository: repositoryName,
      ref: z.string().min(1).max(200),
      app_root: relative.default('.'),
      context: relative.default('.'),
      build_file: relative.default('Dockerfile'),
    })
    .strict()
    .parse(await c.req.json())
  return c.json(
    await permissionTransaction(c.get('user'), async (db, actor) => {
      const access = await usable(
        db,
        actor,
        c.req.param('project'),
        body.service,
        uuid.parse(c.req.param('id')),
      )
      const token = await accessToken(
        access.row,
        unseal(access.row.encrypted_credentials),
      )
      allowed(access, await getRepository(access.row, token, body.repository))
      const prefix = body.app_root === '.' ? '' : `${body.app_root}/`
      const paths = [
        ...new Set([
          'package.json',
          'pnpm-workspace.yaml',
          'pnpm-lock.yaml',
          'package-lock.json',
          `${prefix}package.json`,
          `${prefix}pnpm-lock.yaml`,
          `${prefix}package-lock.json`,
          body.build_file,
        ]),
      ]
      const files = Object.fromEntries(
        await Promise.all(
          paths.map(async (path) => [
            path,
            await repositoryFile(
              access.row,
              token,
              body.repository,
              path,
              body.ref,
            ),
          ]),
        ),
      )
      return {
        ...suggestDockerfile(files, body.app_root, body.context),
        build_file: body.build_file,
        committed: files[body.build_file] !== null,
        app_root: body.app_root,
        context: body.context,
        message:
          files[body.build_file] === null
            ? `Commit ${body.build_file} to the repository before deployment. Suggestions never modify your repository.`
            : 'The selected ref contains the configured build file.',
      }
    }),
  )
})

gitConnections.post(`${path}/:id/webhook`, async (c) => {
  const body = z
    .object({
      service: z.string().min(1),
      repository: repositoryName,
      mode: z.enum(['automatic', 'manual', 'unavailable']).default('automatic'),
    })
    .strict()
    .parse(await c.req.json())
  return c.json(
    await permissionTransaction(c.get('user'), async (db, actor) => {
      const access = await usable(
        db,
        actor,
        c.req.param('project'),
        body.service,
        uuid.parse(c.req.param('id')),
      )
      const token = await accessToken(
        access.row,
        unseal(access.row.encrypted_credentials),
      )
      const repository = await getRepository(access.row, token, body.repository)
      allowed(access, repository)
      const deployment = (
        await db.query(
          'SELECT id,config,webhook_secret,service_revision FROM deployments WHERE project=$1 AND application=$2 FOR UPDATE',
          [c.req.param('project'), body.service],
        )
      ).rows[0]
      if (
        !deployment ||
        deployment.config.repository !== repository.name ||
        deployment.config.connection_id !== access.row.id
      )
        throw new HTTPException(409, {
          message:
            'Save this repository as the app source before configuring its webhook.',
        })
      const url = scopedApiUrl(publicOrigin, `/hooks/github/${deployment.id}`)
      let mode: 'automatic' | 'manual' | 'unavailable' = body.mode
      let message: string | null = null
      if (mode === 'automatic') {
        try {
          const github = access.row.provider.startsWith('github')
          // Reuse only this exact app callback; never create duplicates or alter unrelated hooks.
          let hook: { id: number } | undefined
          for (let page = 1; page <= 10; page++) {
            const hooks = await providerRequest(
              access.row,
              token,
              `/repos/${repository.name}/hooks?${github ? 'per_page' : 'limit'}=100&page=${page}`,
            )
            if (!Array.isArray(hooks))
              throw new HTTPException(502, {
                message: 'Unexpected webhook listing response.',
              })
            hook = hooks.find((item: any) => item.config?.url === url)
            if (hook || hooks.length < 100) break
            if (page === 10)
              throw new HTTPException(409, {
                message:
                  'Review repository hooks manually before provisioning another callback.',
              })
          }
          await providerRequest(
            access.row,
            token,
            `/repos/${repository.name}/hooks${hook ? `/${hook.id}` : ''}`,
            {
              method: hook ? 'PATCH' : 'POST',
              body: {
                type: github ? undefined : 'gitea',
                name: github ? 'web' : undefined,
                active: true,
                events: ['push'],
                config: {
                  url,
                  content_type: 'json',
                  secret: deployment.webhook_secret,
                  ...(github ? { insecure_ssl: '0' } : {}),
                },
              },
            },
          )
        } catch (error) {
          if (
            !(error instanceof HTTPException) ||
            ![401, 403, 404, 422].includes(error.status)
          )
            throw error
          mode = 'manual'
          message = `Webhook provisioning was not permitted (${error.status}). Configure a signed push webhook manually if you have repository administration access. Manual deployments remain available.`
        }
      }
      let requested = false
      if (deployment.service_revision && mode !== 'unavailable') {
        const revision = (
          await db.query(
            'SELECT encrypted_config FROM service_revisions WHERE id=$1',
            [deployment.service_revision],
          )
        ).rows[0]
        const desired = revision ? unseal(revision.encrypted_config) : null
        requested =
          desired?.source?.type === 'github' &&
          desired.source.config.connection_id === access.row.id &&
          desired.source.config.repository_id === repository.id &&
          desired.source.config.enabled
      }
      await db.query(
        "UPDATE deployments SET webhook_mode=$1,webhook_error=$2,config=jsonb_set(config,'{enabled}',$4::jsonb) WHERE id=$3",
        [mode, message, deployment.id, JSON.stringify(Boolean(requested))],
      )
      return {
        mode,
        url,
        message,
        instructions:
          mode === 'manual'
            ? 'In the repository webhook settings, add this URL, JSON content type, push events, and a signing secret generated in the app webhook panel. Keep TLS verification enabled. If neither you nor the token can configure hooks, select manual deployments only.'
            : mode === 'unavailable'
              ? 'Automatic deployment is unavailable; use manual deployment. Kloud does not poll the repository.'
              : 'The provider webhook was created. Signed pushes to the configured branch can deploy after deployment setup is completed.',
      }
    }),
  )
})

gitConnections.get(`${path}/legacy/authorizations`, async (c) => {
  const service = z.string().min(1).max(100).parse(c.req.query('service'))
  if (!c.get('user').admin)
    throw new HTTPException(403, {
      message: 'Server administrator permission required.',
    })
  await projectAccess(c.get('user'), c.req.param('project'))
  return c.json(
    (
      await pool.query(
        'SELECT repository,connector_id FROM legacy_source_grants WHERE project=$1 AND service=$2 ORDER BY repository,connector_id',
        [c.req.param('project'), service],
      )
    ).rows,
  )
})
gitConnections.delete(`${path}/legacy/authorization`, async (c) => {
  const body = z
    .object({
      service: z.string().min(1).max(100),
      repository: repositoryName,
      connector_id: uuid,
    })
    .strict()
    .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    if (!actor.admin)
      throw new HTTPException(403, {
        message:
          'Only server administrators revoke legacy connector-source authorization.',
      })
    await projectAccess(actor, c.req.param('project'), db)
    await db.query(
      'DELETE FROM legacy_source_grants WHERE project=$1 AND service=$2 AND repository=$3 AND connector_id=$4',
      [
        c.req.param('project'),
        body.service,
        body.repository,
        body.connector_id,
      ],
    )
  })
  return c.json({ revoked: true })
})
