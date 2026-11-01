import { dispatchSecrets } from './build-inputs.js'
import { validateRegistryInputs } from './registry-connections.js'
import { maskBuildInputs, preserveBuildInputs } from './build-inputs.js'
import { validateGitSource, autoDeployAvailable } from './git-connections.js'
import { ensureDomainDns } from './dns.js'
import { isPublicIPv4, isPublicIPv6 } from '@kloud/protocol/addresses'
import {
  parseEnvironment,
  formatEnvironment,
  environmentChanges,
} from '@kloud/protocol/environment'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import {
  platformConfigSchema,
  runtimeRequestSchema,
  domainSchema,
} from '@kloud/protocol/platform'
import { pool, transaction } from './db.js'
import { requireUser, currentUser, type Env, type User } from './auth.js'
import { streamSSE } from 'hono/streaming'
import { demandService, serviceAccess } from './service-permissions.js'
import { permissionTransaction, projectAccess } from './permissions.js'
import { inventoryQuery } from './dashboard.js'
import { connectorRpc } from './connector-rpc.js'
import { seal, unseal, redact } from './platform-secrets.js'
import { digest, token } from './security.js'
import { resolveRegistryInputs } from './registry-connections.js'
import { rolloutControls } from './rollout-controls.js'
import { registerRolloutRoutes } from './rollout-api.js'
import { resolveGitSource } from './git-connections.js'

async function requireSingleQueuedHost(
  db: Pick<import('pg').PoolClient, 'query'>,
  project: string,
  service: string,
  connector: string,
) {
  const other = await db.query(
    `SELECT 1 FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE v.project=$1 AND v.service=$2 AND r.status IN ('queued','running') AND r.connector_id<>$3
    UNION ALL SELECT 1 FROM deployment_builds b JOIN deployments d ON d.id=b.deployment_id WHERE d.project=$1 AND d.application=$2 AND b.status IN ('queued','running') AND b.config->>'connector_id'<>$3::text LIMIT 1`,
    [project, service, connector],
  )
  if (other.rowCount)
    throw new HTTPException(409, {
      message:
        'This app already has queued or active work on another server. Finish or explicitly cancel that work before changing its selected server.',
    })
}

export const platform = new Hono<Env>()
platform.use('*', requireUser)
const base = '/projects/:project/services/:service'
const uuid = z.string().uuid()
platform.get('/projects/:project/hosts', async (c) => {
  await projectAccess(c.get('user'), c.req.param('project'))
  // Host selection is only useful for users allowed to create or deploy services.
  const access = await serviceAccess(c.get('user'), c.req.param('project'))
  const grants = await pool.query(
    "SELECT 1 FROM service_grants WHERE user_id=$1 AND project_slug=$2 AND capability='deploy'",
    [c.get('user').id, c.req.param('project')],
  )
  if (!access.allows('create') && !access.allows('deploy') && !grants.rowCount)
    throw new HTTPException(403)
  return c.json(
    (
      await pool.query(
        'SELECT id,name,host,seen,capabilities,public_addresses,dns_targets,private_addresses FROM connectors WHERE NOT revoked ORDER BY name',
      )
    ).rows,
  )
})
platform.get(`${base}/configuration`, async (c) => {
  await demandService(
    c.get('user'),
    c.req.param('project'),
    'read',
    c.req.param('service'),
  )
  const rows = (
    await pool.query(
      'SELECT id,created FROM service_revisions WHERE project=$1 AND service=$2 ORDER BY revision_number DESC LIMIT 30',
      [c.req.param('project'), c.req.param('service')],
    )
  ).rows
  const runs = (
    await pool.query(
      `SELECT r.id,r.revision,r.status,r.created,r.finished,r.log,r.artifacts FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE v.project=$1 AND v.service=$2 ORDER BY r.receipt_order DESC LIMIT 30`,
      [c.req.param('project'), c.req.param('service')],
    )
  ).rows
  const access = await serviceAccess(c.get('user'), c.req.param('project'))
  return c.json({
    revisions: rows,
    runs,
    can_reveal: access.allows('reveal', c.req.param('service')),
    needs_deployment:
      !!rows[0] &&
      !runs.some(
        (run) => run.revision === rows[0].id && run.status === 'succeeded',
      ),
  })
})
platform.get(`${base}/configuration/:revision`, async (c) => {
  await demandService(
    c.get('user'),
    c.req.param('project'),
    'deploy',
    c.req.param('service'),
  )
  const row = (
    await pool.query(
      'SELECT encrypted_config FROM service_revisions WHERE id=$1 AND project=$2 AND service=$3',
      [
        uuid.parse(c.req.param('revision')),
        c.req.param('project'),
        c.req.param('service'),
      ],
    )
  ).rows[0]
  if (!row) throw new HTTPException(404)
  const config = unseal(row.encrypted_config)
  // Configuration is write-only for secrets. Editing preserves masked values server-side.
  for (const key of Object.keys(config.runtime.environment))
    config.runtime.environment[key] = '********'
  if (config.source.registry) config.source.registry.password = '********'
  if (config.source.type === 'compose') config.source.content = '********'
  maskBuildInputs(config)
  return c.json(config)
})
platform.put(`${base}/configuration`, async (c) => {
  const body = z
    .object({
      config: platformConfigSchema,
      previous: uuid.optional(),
      confirmed_removals: z.array(z.string()).default([]),
      plaintext_environment: z.boolean().default(false),
    })
    .strict()
    .parse(await c.req.json())
  const id = randomUUID()
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    if (body.plaintext_environment)
      await demandService(
        actor,
        c.req.param('project'),
        'reveal',
        c.req.param('service'),
        db,
      )
    // Serialize draft writers on the service, including initial draft creation.
    await db.query(
      'SELECT 1 FROM services WHERE project_slug=$1 AND slug=$2 FOR UPDATE',
      [c.req.param('project'), c.req.param('service')],
    )
    await requireSingleQueuedHost(
      db,
      c.req.param('project'),
      c.req.param('service'),
      body.config.connector_id,
    )
    const established = (
      await db.query(
        'SELECT connector_id FROM service_release_state WHERE project=$1 AND service=$2',
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    if (established && established.connector_id !== body.config.connector_id)
      throw new HTTPException(409, {
        message:
          'Moving an established service between servers requires a separate reviewed migration.',
      })
    const latest = (
      await db.query(
        'SELECT id FROM service_revisions WHERE project=$1 AND service=$2 ORDER BY revision_number DESC LIMIT 1',
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    if ((latest?.id ?? undefined) !== body.previous)
      throw new HTTPException(409, {
        message: 'This draft has changed. Reload before saving.',
      })
    const connector = (
      await db.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [body.config.connector_id],
      )
    ).rows[0]
    if (!connector?.capabilities.includes('deploy'))
      throw new HTTPException(409, {
        message: 'Choose a host with deployment support enabled',
      })
    const service = (
      await db.query(
        'SELECT type FROM services WHERE project_slug=$1 AND slug=$2',
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    const compose =
      body.config.source.type === 'compose' ||
      (body.config.source.type === 'github' &&
        body.config.source.config.kind === 'compose')
    if ((service.type === 'compose') !== compose)
      throw new HTTPException(400, {
        message: 'Source must match the service type',
      })
    if (body.previous) {
      const old = (
        await db.query(
          'SELECT encrypted_config FROM service_revisions WHERE id=$1 AND project=$2 AND service=$3',
          [body.previous, c.req.param('project'), c.req.param('service')],
        )
      ).rows[0]
      if (!old) throw new HTTPException(404)
      const config = unseal(old.encrypted_config)
      preserveBuildInputs(body.config, config)
      const removed = environmentChanges(
        config.runtime.environment,
        body.config.runtime.environment,
      ).removed
      if (
        JSON.stringify([...body.confirmed_removals].sort()) !==
        JSON.stringify(removed)
      )
        throw new HTTPException(409, {
          message: 'Review and confirm removed variable keys before saving.',
        })
      if (
        body.config.source.type === 'compose' &&
        body.config.source.content === '********'
      ) {
        if (config.source.type !== 'compose') throw new HTTPException(400)
        body.config.source.content = config.source.content
      }
      for (const [key, value] of Object.entries(
        body.config.runtime.environment,
      ))
        if (!body.plaintext_environment && value === '********') {
          if (!Object.hasOwn(config.runtime.environment, key))
            throw new HTTPException(400, {
              message: 'Masked variable has no previous value',
            })
          body.config.runtime.environment[key] = config.runtime.environment[key]
        }
      if (
        body.config.source.type === 'image' &&
        body.config.source.registry?.password === '********'
      ) {
        if (!config.source.registry) throw new HTTPException(400)
        body.config.source.registry.password = config.source.registry.password
      }
    }
    await validateRegistryInputs(
      db,
      actor,
      c.req.param('project'),
      c.req.param('service'),
      body.config.build_inputs,
    )
    if (!body.previous)
      preserveBuildInputs(body.config, {
        ...body.config,
        build_inputs: undefined,
      })
    if (body.config.source.type === 'github')
      await validateGitSource(
        db,
        actor,
        c.req.param('project'),
        c.req.param('service'),
        body.config.source.config,
      )
    await db.query(
      'INSERT INTO service_revisions(id,project,service,encrypted_config,source_label,connector_id) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        c.req.param('project'),
        c.req.param('service'),
        seal(body.config),
        body.config.source.type === 'image'
          ? body.config.source.image
          : body.config.source.type === 'compose'
            ? 'Pasted Compose'
            : body.config.source.config.repository,
        body.config.connector_id,
      ],
    )
    if (body.config.source.type === 'github') {
      const git = {
        ...body.config.source.config,
        managed: true,
        connector_id: body.config.connector_id,
        container_name: `kloud-${c.req.param('project')}-${c.req.param('service')}`,
      }
      await db.query(
        'INSERT INTO deployments(id,project,application,connector_id,config,webhook_secret,service_revision) VALUES($1,$2,$3,$4,$5,$6,NULL) ON CONFLICT(project,application) DO NOTHING',
        [
          randomUUID(),
          c.req.param('project'),
          c.req.param('service'),
          body.config.connector_id,
          { ...git, enabled: false },
          token(),
        ],
      )
    }
  })
  return c.json({ id }, 201)
})
platform.get(`${base}/variables/:revision`, async (c) => {
  const text = await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'reveal',
      c.req.param('service'),
      db,
    )
    const row = (
      await db.query(
        'SELECT encrypted_config FROM service_revisions WHERE id=$1 AND project=$2 AND service=$3',
        [
          uuid.parse(c.req.param('revision')),
          c.req.param('project'),
          c.req.param('service'),
        ],
      )
    ).rows[0]
    if (!row) throw new HTTPException(404)
    return formatEnvironment(unseal(row.encrypted_config).runtime.environment)
  })
  c.header('Cache-Control', 'no-store')
  return c.json({ text })
})
platform.put(`${base}/variables`, async (c) => {
  const body = z
    .object({
      previous: uuid,
      text: z.string().max(512000),
      confirmed_removals: z.array(z.string()),
    })
    .strict()
    .parse(await c.req.json())
  let environment: Record<string, string>
  try {
    environment = parseEnvironment(body.text)
  } catch (error) {
    throw new HTTPException(400, {
      message:
        error instanceof Error ? error.message : 'Invalid environment document',
    })
  }
  const id = await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    await demandService(
      actor,
      c.req.param('project'),
      'reveal',
      c.req.param('service'),
      db,
    )
    await db.query(
      'SELECT 1 FROM services WHERE project_slug=$1 AND slug=$2 FOR UPDATE',
      [c.req.param('project'), c.req.param('service')],
    )
    const row = (
      await db.query(
        'SELECT id,encrypted_config,source_label,connector_id FROM service_revisions WHERE project=$1 AND service=$2 ORDER BY revision_number DESC LIMIT 1',
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    if (!row || row.id !== body.previous)
      throw new HTTPException(409, {
        message: 'This draft has changed. Reload before saving.',
      })
    const config = unseal(row.encrypted_config)
    const removed = environmentChanges(
      config.runtime.environment,
      environment,
    ).removed
    if (
      JSON.stringify([...body.confirmed_removals].sort()) !==
      JSON.stringify(removed)
    )
      throw new HTTPException(409, {
        message: 'Review and confirm removed variable keys before saving.',
      })
    config.runtime.environment = environment
    platformConfigSchema.parse(config)
    const revision = randomUUID()
    await db.query(
      'INSERT INTO service_revisions(id,project,service,encrypted_config,source_label,connector_id) VALUES($1,$2,$3,$4,$5,$6)',
      [
        revision,
        c.req.param('project'),
        c.req.param('service'),
        seal(config),
        row.source_label,
        row.connector_id,
      ],
    )
    return revision
  })
  return c.json({ id }, 201)
})
platform.put(`${base}/automatic-deployment`, async (c) => {
  const body = z
    .object({ enabled: z.boolean() })
    .strict()
    .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    const row = (
      await db.query(
        'SELECT config,service_revision FROM deployments WHERE project=$1 AND application=$2 FOR UPDATE',
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    if (!row)
      throw new HTTPException(404, {
        message: 'Save the source and complete deployment setup first.',
      })
    if (body.enabled) {
      if (!row.service_revision)
        throw new HTTPException(409, {
          message:
            'Deploy a reviewed versioned draft before enabling push deployments.',
        })
      await validateGitSource(
        db,
        actor,
        c.req.param('project'),
        c.req.param('service'),
        row.config,
      )
      if (
        !(await autoDeployAvailable(
          db,
          c.req.param('project'),
          c.req.param('service'),
          { ...row.config, enabled: true },
        ))
      )
        throw new HTTPException(409, {
          message:
            'Configure a signed webhook first. Manual deployments remain available.',
        })
    }
    await db.query(
      "UPDATE deployments SET config=jsonb_set(config,'{enabled}',$3::jsonb),configured_by=$4 WHERE project=$1 AND application=$2",
      [
        c.req.param('project'),
        c.req.param('service'),
        JSON.stringify(body.enabled),
        actor.id,
      ],
    )
  })
  return c.json({ enabled: body.enabled })
})
platform.post(`${base}/deploy`, async (c) => {
  const body = z
    .object({
      revision: uuid,
      request_key: uuid,
      commit: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .optional(),
      rollback: uuid.optional(),
    })
    .strict()
    .parse(await c.req.json())
  const id = await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    const row = (
      await db.query(
        'SELECT * FROM service_revisions WHERE id=$1 AND project=$2 AND service=$3 FOR UPDATE',
        [body.revision, c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    if (!row) throw new HTTPException(404)
    const config = unseal(row.encrypted_config)
    await requireSingleQueuedHost(
      db,
      c.req.param('project'),
      c.req.param('service'),
      config.connector_id,
    )
    const established = (
      await db.query(
        'SELECT connector_id FROM service_release_state WHERE project=$1 AND service=$2',
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    if (established && established.connector_id !== config.connector_id)
      throw new HTTPException(409, {
        message:
          'This revision targets a different server. Moving an established service requires a reviewed migration.',
      })
    const activeHost = (
      await db.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [config.connector_id],
      )
    ).rows[0]
    if (!activeHost?.capabilities.includes('deploy'))
      throw new HTTPException(409, {
        message:
          'The deployment host is revoked or no longer supports deployments',
      })
    await validateRegistryInputs(
      db,
      actor,
      c.req.param('project'),
      c.req.param('service'),
      config.build_inputs,
    )
    if (config.source.type === 'github')
      await validateGitSource(
        db,
        actor,
        c.req.param('project'),
        c.req.param('service'),
        config.source.config,
      )
    if (config.source.type === 'github' && !body.commit && !body.rollback)
      throw new HTTPException(400, {
        message: 'Enter a full commit SHA for Git deployments',
      })
    if (body.rollback) {
      const old = (
        await db.query(
          "SELECT r.artifacts,r.revision FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE r.id=$1 AND v.project=$2 AND v.service=$3 AND r.status='succeeded'",
          [body.rollback, c.req.param('project'), c.req.param('service')],
        )
      ).rows[0]
      if (!old || old.revision !== body.revision || !old.artifacts)
        throw new HTTPException(400, {
          message:
            'Choose the revision of a successful deployment for rollback',
        })
    }
    const existing = (
      await db.query(
        'SELECT r.id FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE r.request_key=$1 AND v.project=$2 AND v.service=$3',
        [body.request_key, c.req.param('project'), c.req.param('service')],
      )
    ).rows[0]
    if (existing) return existing.id
    if (config.source.type === 'github') {
      const git = {
        ...config.source.config,
        enabled: await autoDeployAvailable(
          db,
          c.req.param('project'),
          c.req.param('service'),
          config.source.config,
        ),
        managed: true,
        connector_id: config.connector_id,
        container_name: `kloud-${c.req.param('project')}-${c.req.param('service')}`,
      }
      await db.query(
        'UPDATE deployments SET connector_id=$1,config=$2,service_revision=$3,configured_by=$6 WHERE project=$4 AND application=$5',
        [
          config.connector_id,
          git,
          row.id,
          c.req.param('project'),
          c.req.param('service'),
          actor.id,
        ],
      )
    } else {
      await db.query(
        "UPDATE deployments SET config=jsonb_set(config,'{enabled}','false'),service_revision=NULL WHERE project=$1 AND application=$2",
        [c.req.param('project'), c.req.param('service')],
      )
    }
    const run = randomUUID()
    const artifacts = body.rollback
      ? (
          await db.query('SELECT artifacts FROM service_runs WHERE id=$1', [
            body.rollback,
          ])
        ).rows[0].artifacts
      : null
    await db.query(
      'INSERT INTO service_runs(id,revision,connector_id,request_key,artifacts,commit,requested_by,manual) VALUES($1,$2,$3,$4,$5,$6,$7,true)',
      [
        run,
        row.id,
        config.connector_id,
        body.request_key,
        artifacts,
        body.commit ?? null,
        actor.id,
      ],
    )
    return run
  })
  return c.json({ id }, 202)
})

export async function containerPermission(
  user: User,
  project: string,
  connector: string,
  container: string,
  capability: string,
) {
  const access = await projectAccess(user, project)
  const row = (
    await pool.query(
      `SELECT * FROM (${inventoryQuery}) inventory WHERE project=$1 AND connector_id=$2 AND container_id=$3`,
      [project, connector, container],
    )
  ).rows[0]
  if (!row) throw new HTTPException(404, { message: 'Container not found' })
  if (!access.can_manage_access) {
    const allowed = await pool.query(
      `SELECT 1 FROM container_grants WHERE user_id=$1 AND project_slug=$2 AND capability=$3 AND (kind='all' OR (connector_id=$4 AND ((kind='id' AND target=$5) OR (kind='name' AND target=$6))))`,
      [user.id, project, capability, connector, container, row.data.name],
    )
    if (!allowed.rowCount)
      throw new HTTPException(403, {
        message: `${capability} permission required`,
      })
  }
  if (row.stale)
    throw new HTTPException(409, { message: 'Host inventory is stale' })
  return row
}
platform.get(
  '/projects/:project/containers/:connector/:container/logs',
  async (c) => {
    const connector = uuid.parse(c.req.param('connector')),
      container = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(c.req.param('container'))
    await containerPermission(
      c.get('user'),
      c.req.param('project'),
      connector,
      container,
      'logs',
    )
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        try {
          const user = await currentUser(c)
          if (!user) throw new HTTPException(401)
          const row = await containerPermission(
            user,
            c.req.param('project'),
            connector,
            container,
            'logs',
          )
          const host = (
            await pool.query(
              'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
              [connector],
            )
          ).rows[0]
          if (!host?.capabilities.includes('runtime'))
            throw new HTTPException(409)
          const result = await connectorRpc(connector, {
            kind: 'runtime',
            action: 'logs',
            container,
            owner: user.id,
            project: row.project,
            application: row.application,
          })
          const current = await currentUser(c)
          if (!current) throw new HTTPException(401)
          await containerPermission(
            current,
            c.req.param('project'),
            connector,
            container,
            'logs',
          )
          if (!stream.aborted)
            await stream.writeSSE({ data: JSON.stringify(result) })
        } catch {
          if (!stream.aborted)
            await stream.writeSSE({
              event: 'unavailable',
              data: 'Log access ended or host unavailable',
            })
          break
        }
        await stream.sleep(1500)
      }
    })
  },
)
platform.get(
  '/projects/:project/containers/:connector/:container/permissions',
  async (c) => {
    const connector = uuid.parse(c.req.param('connector')),
      container = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(c.req.param('container'))
    await projectAccess(c.get('user'), c.req.param('project'))
    const host = (
      await pool.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [connector],
      )
    ).rows[0]
    const permissions: Record<string, boolean> = {
      available: !!host?.capabilities.includes('runtime'),
    }
    for (const capability of [
      'logs',
      'lifecycle',
      'terminal',
      'configuration',
    ]) {
      try {
        await containerPermission(
          c.get('user'),
          c.req.param('project'),
          connector,
          container,
          capability,
        )
        permissions[capability] = permissions.available!
      } catch {
        permissions[capability] = false
      }
    }
    return c.json(permissions)
  },
)
platform.post(
  '/projects/:project/containers/:connector/:container/operation',
  async (c) => {
    const body = runtimeRequestSchema.parse(await c.req.json())
    const capability = body.action.startsWith('terminal-')
      ? 'terminal'
      : body.action === 'logs'
        ? 'logs'
        : body.action === 'inspect'
          ? 'configuration'
          : 'lifecycle'
    const connector = uuid.parse(c.req.param('connector')),
      container = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(c.req.param('container'))
    const row = await containerPermission(
      c.get('user'),
      c.req.param('project'),
      connector,
      container,
      capability,
    )
    const host = (
      await pool.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [connector],
      )
    ).rows[0]
    if (!host?.capabilities.includes('runtime'))
      throw new HTTPException(409, {
        message: 'Runtime operations are not enabled on this host',
      })
    const result = await connectorRpc(connector, {
      kind: 'runtime',
      ...body,
      container,
      project: row.project,
      application: row.application,
      owner: c.get('user').id,
    })
    // Recheck grants after waiting for a host, before returning logs or terminal output.
    await containerPermission(
      c.get('user'),
      c.req.param('project'),
      connector,
      container,
      capability,
    )
    return c.json(result)
  },
)
platform.get(`${base}/domains`, async (c) => {
  await demandService(
    c.get('user'),
    c.req.param('project'),
    'read',
    c.req.param('service'),
  )
  return c.json(
    (
      await pool.query(
        "SELECT d.*,s.desired,s.applied,s.error,s.certificates FROM service_domains d LEFT JOIN proxy_status s USING(connector_id) WHERE d.project=$1 AND d.service=$2 ORDER BY d.config->>'hostname'",
        [c.req.param('project'), c.req.param('service')],
      )
    ).rows,
  )
})
platform.post(`${base}/domains`, async (c) => {
  const body = z
    .object({ connector_id: uuid, config: domainSchema })
    .strict()
    .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    const host = (
      await db.query(
        'SELECT capabilities FROM connectors WHERE id=$1 AND NOT revoked',
        [body.connector_id],
      )
    ).rows[0]
    if (!host?.capabilities.includes('proxy'))
      throw new HTTPException(409, {
        message: 'Managed NGINX is not enabled on this host',
      })
    const peers = (
      await db.query(
        "SELECT connector_id,config FROM service_domains WHERE config->>'hostname'=$1",
        [body.config.hostname],
      )
    ).rows
    if (
      peers.some(
        (peer) =>
          peer.connector_id !== body.connector_id ||
          peer.config.https !== body.config.https ||
          peer.config.redirect !== body.config.redirect,
      )
    )
      throw new HTTPException(409, {
        message: 'Routes for a hostname must share one host and HTTPS policy',
      })
    const target = (
      await db.query(
        `SELECT 1 FROM (${inventoryQuery}) inventory WHERE project=$1 AND application=$2 AND connector_id=$3 AND data->>'name'=$4`,
        [
          c.req.param('project'),
          c.req.param('service'),
          body.connector_id,
          body.config.container,
        ],
      )
    ).rowCount
    if (!target)
      throw new HTTPException(400, {
        message: 'Choose a running container assigned to this service',
      })
    await db.query(
      'INSERT INTO service_domains(id,project,service,connector_id,config) VALUES($1,$2,$3,$4,$5)',
      [
        randomUUID(),
        c.req.param('project'),
        c.req.param('service'),
        body.connector_id,
        body.config,
      ],
    )
  })
  return c.json({ saved: true }, 201)
})
platform.post(`${base}/domains/:id/dns`, async (c) => {
  const body = z
    .object({ zone: uuid, type: z.enum(['A', 'AAAA']), address: z.string() })
    .strict()
    .parse(await c.req.json())
  if (
    !(body.type === 'A'
      ? isPublicIPv4(body.address)
      : isPublicIPv6(body.address))
  )
    throw new HTTPException(400, {
      message: 'Enter a valid public address for this record type.',
    })
  const result = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      await demandService(
        actor,
        c.req.param('project'),
        'deploy',
        c.req.param('service'),
        db,
      )
      const route = (
        await db.query(
          'SELECT config FROM service_domains WHERE id=$1 AND project=$2 AND service=$3 FOR UPDATE',
          [
            uuid.parse(c.req.param('id')),
            c.req.param('project'),
            c.req.param('service'),
          ],
        )
      ).rows[0]
      if (!route) throw new HTTPException(404)
      const result = await ensureDomainDns(
        db,
        actor,
        c.req.param('project'),
        body.zone,
        { type: body.type, name: route.config.hostname, content: body.address },
      )
      await db.query(
        'UPDATE service_domains SET dns_status=jsonb_set(dns_status,ARRAY[$2]::text[],$3::jsonb) WHERE id=$1',
        [
          c.req.param('id'),
          body.type,
          JSON.stringify({
            status: 'configured',
            address: body.address,
            at: new Date().toISOString(),
          }),
        ],
      )
      return result
    },
  )
  return c.json({ ...result, status: 'configured' })
})
platform.delete(`${base}/domains/:id`, async (c) => {
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandService(
      actor,
      c.req.param('project'),
      'deploy',
      c.req.param('service'),
      db,
    )
    await db.query(
      'DELETE FROM service_domains WHERE id=$1 AND project=$2 AND service=$3',
      [
        uuid.parse(c.req.param('id')),
        c.req.param('project'),
        c.req.param('service'),
      ],
    )
  })
  return c.json({ removed: true })
})

export const platformWorker = new Hono<{ Variables: { connector: string } }>()
platformWorker.use('/connectors/platform/*', async (c, next) => {
  const value = c.req
    .header('authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
  const row = value
    ? (
        await pool.query(
          'SELECT id FROM connectors WHERE token=$1 AND NOT revoked',
          [digest(value)],
        )
      ).rows[0]
    : null
  if (!row) throw new HTTPException(401)
  c.set('connector', row.id)
  await next()
})
platformWorker.post('/connectors/platform/claim', async (c) => {
  const connector = c.get('connector')
  const job = await transaction(async (db) => {
    if (
      !(
        await db.query(
          'SELECT id FROM connectors WHERE id=$1 AND NOT revoked FOR UPDATE',
          [connector],
        )
      ).rowCount
    )
      throw new HTTPException(401)
    const host = (
      await db.query('SELECT capabilities FROM connectors WHERE id=$1', [
        connector,
      ])
    ).rows[0]
    if (!host?.capabilities.includes('rollout-v1')) return null
    // An interrupted cutover is reconciled, never executed again as a new deployment.
    const interrupted = (
      await db.query(
        `SELECT r.*,v.project,v.service,v.encrypted_config,x.candidate,x.previous,x.stage,x.details
      FROM service_runs r JOIN service_revisions v ON v.id=r.revision JOIN service_rollouts x ON x.run=r.id
      WHERE r.connector_id=$1 AND r.status='running' AND x.updated < now()-interval '90 seconds'
      ORDER BY r.receipt_order LIMIT 1 FOR UPDATE OF r,x`,
        [connector],
      )
    ).rows[0]
    if (interrupted) {
      await db.query('UPDATE service_rollouts SET updated=now() WHERE run=$1', [
        interrupted.id,
      ])
      const { encrypted_config, candidate, previous, stage, details, ...rest } =
        interrupted
      return {
        ...rest,
        config: unseal(encrypted_config),
        reconcile: { candidate, previous, stage, details },
        serving: previous,
      }
    }
    await db.query(
      `INSERT INTO service_release_state(project,service,connector_id,paused,reason)
      SELECT v.project,v.service,r.connector_id,true,'Worker disconnected before a known serving state was established'
      FROM service_runs r JOIN service_revisions v ON v.id=r.revision
      WHERE r.connector_id=$1 AND r.status='running' AND r.started < now()-interval '40 minutes'
      ON CONFLICT(project,service) DO UPDATE SET paused=true,reason=EXCLUDED.reason,updated=now()`,
      [connector],
    )
    await db.query(
      "UPDATE service_runs SET status='failed',finished=now(),log='Worker disconnected; serving state must be reconciled before this app can dispatch again' WHERE connector_id=$1 AND status='running' AND started < now()-interval '40 minutes'",
      [connector],
    )
    if (
      (
        await db.query(
          "SELECT 1 FROM service_runs WHERE connector_id=$1 AND status='running' UNION ALL SELECT 1 FROM deployment_builds b JOIN deployments d ON d.id=b.deployment_id WHERE b.config->>'connector_id'=$1::text AND b.status='running'",
          [connector],
        )
      ).rowCount
    )
      return null
    const row = (
      await db.query(
        "SELECT r.*,v.project,v.service,v.encrypted_config FROM service_runs r JOIN service_revisions v ON v.id=r.revision LEFT JOIN service_release_state state ON state.project=v.project AND state.service=v.service WHERE r.connector_id=$1 AND r.status='queued' AND NOT COALESCE(state.paused,false) AND NOT EXISTS (SELECT 1 FROM deployment_pauses p JOIN deployments d ON d.id=p.deployment WHERE d.project=v.project AND d.application=v.service) AND NOT EXISTS (SELECT 1 FROM service_runs older JOIN service_revisions ov ON ov.id=older.revision WHERE ov.project=v.project AND ov.service=v.service AND older.status IN ('queued','running') AND older.receipt_order<r.receipt_order) AND NOT EXISTS (SELECT 1 FROM deployment_builds b JOIN deployments d ON d.id=b.deployment_id WHERE d.project=v.project AND d.application=v.service AND b.status IN ('queued','running') AND b.receipt_order<r.receipt_order) ORDER BY r.receipt_order LIMIT 1 FOR UPDATE OF r,v",
        [connector],
      )
    ).rows[0]
    if (!row) return null
    await db.query(
      "UPDATE service_runs SET status='running',started=now() WHERE id=$1",
      [row.id],
    )
    const { encrypted_config, encrypted_dispatch_secrets, ...rest } = row
    const desired = unseal(encrypted_config)
    let source_auth
    try {
      const actor = (
        await db.query(
          'SELECT id,username,admin,capabilities FROM users WHERE id=$1 AND NOT disabled',
          [row.requested_by],
        )
      ).rows[0]
      if (!actor) throw new Error('Deployment actor unavailable')
      await demandService(actor, row.project, 'deploy', row.service, db)
      const established = (
        await db.query(
          'SELECT connector_id FROM service_release_state WHERE project=$1 AND service=$2',
          [row.project, row.service],
        )
      ).rows[0]
      if (established && established.connector_id !== connector)
        throw new Error(
          'Application host migration requires a deliberate cutover',
        )
      source_auth =
        desired.source.type === 'github'
          ? await resolveGitSource(
              db,
              row.project,
              row.service,
              desired.source.config,
            )
          : undefined
      desired.build_inputs = await resolveRegistryInputs(
        db,
        row.project,
        row.service,
        desired.build_inputs,
      )
    } catch {
      await db.query(
        "UPDATE service_runs SET status='failed',finished=now(),log='Source connection authorization is no longer available; select an authorized connection before deploying again' WHERE id=$1",
        [row.id],
      )
      return null
    }
    await db.query(
      'UPDATE service_runs SET encrypted_dispatch_secrets=$2 WHERE id=$1',
      [row.id, seal(dispatchSecrets(desired, source_auth))],
    )
    const release = (
      await db.query(
        'SELECT serving,compose_state FROM service_release_state WHERE project=$1 AND service=$2',
        [row.project, row.service],
      )
    ).rows[0]
    return {
      ...rest,
      config: desired,
      source_auth,
      serving: release?.serving,
      compose_state: release?.compose_state,
    }
  })
  return c.json({ job })
})
platformWorker.post('/connectors/platform/:id/result', async (c) => {
  const result = z
    .object({
      status: z.enum(['succeeded', 'failed', 'skipped']),
      uncertain: z.boolean().optional(),
      log: z.string().max(48000),
      artifacts: z.record(z.string(), z.string().max(500)).nullable(),
    })
    .strict()
    .parse(await c.req.json())
  const connector = c.get('connector')
  const row = (
    await pool.query(
      'SELECT v.encrypted_config,r.encrypted_dispatch_secrets FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE r.id=$1 AND r.connector_id=$2',
      [uuid.parse(c.req.param('id')), connector],
    )
  ).rows[0]
  if (!row) throw new HTTPException(404)
  if (result.uncertain) {
    await pool.query(
      `UPDATE service_release_state s SET paused=true,reason='Serving state requires reconciliation',updated=now() FROM service_rollouts x WHERE x.run=$1 AND x.connector_id=$2 AND s.project=x.project AND s.service=x.service`,
      [c.req.param('id'), connector],
    )
    return c.json({ ok: true, reconciling: true })
  }
  const dispatch = row.encrypted_dispatch_secrets
    ? (unseal(row.encrypted_dispatch_secrets) as string[])
    : []
  const safeLog = dispatch
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce(
      (text, secret) => text.split(secret).join('[redacted]'),
      redact(result.log, unseal(row.encrypted_config)),
    )
  await pool.query(
    "UPDATE service_runs SET status=$1,log=$2,artifacts=$3,finished=now() WHERE id=$4 AND connector_id=$5 AND status='running'",
    [result.status, safeLog, result.artifacts, c.req.param('id'), connector],
  )
  return c.json({ ok: true })
})
platformWorker.post('/connectors/platform/proxy', async (c) => {
  const connector = c.get('connector')
  const report = z
    .object({
      applied: z.string().max(64).nullable(),
      error: z.string().max(500).nullable(),
      certificates: z
        .record(z.string(), z.enum(['ready', 'pending', 'error']))
        .optional(),
    })
    .strict()
    .parse(await c.req.json())
  const routes = (
    await pool.query(
      'SELECT project,service,config FROM service_domains WHERE connector_id=$1 ORDER BY id',
      [connector],
    )
  ).rows
  const desired = createHash('sha256')
    .update(JSON.stringify(routes))
    .digest('hex')
  await pool.query(
    'INSERT INTO proxy_status(connector_id,desired,applied,error,certificates) VALUES($1,$2,$3,$4,$5) ON CONFLICT(connector_id) DO UPDATE SET desired=$2,applied=$3,error=$4,certificates=$5,updated=now()',
    [
      connector,
      desired,
      report.applied,
      report.error,
      report.certificates ?? {},
    ],
  )
  return c.json({ routes, desired })
})

registerRolloutRoutes(platformWorker)

platform.route('/', rolloutControls)
