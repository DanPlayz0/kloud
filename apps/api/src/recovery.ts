import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { pool, transaction } from './db.js'
import { requireUser, type Env, type User } from './auth.js'
import {
  permissionTransaction,
  projectAccess,
  demandProjectAdmin,
} from './permissions.js'
import { seal, unseal } from './platform-secrets.js'
import { digest } from './security.js'
import { nextBackupRun } from './recovery-schedule.js'

const uuid = z.string().uuid()
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80)
const capabilities = [
  'read',
  'manage',
  'backup',
  'restore',
  'destinations',
  'reveal',
] as const
type Capability = (typeof capabilities)[number]
type DB = Pick<import('pg').PoolClient, 'query'>
async function demandDatabase(
  user: User,
  project: string,
  capability: Capability,
  resource: string | null,
  db: DB = pool,
) {
  const access = await projectAccess(user, project, db)
  if (
    !access.can_manage_access &&
    !(
      await db.query(
        'SELECT 1 FROM database_grants WHERE user_id=$1 AND project=$2 AND capability=$3 AND (resource IS NULL OR resource=$4)',
        [user.id, project, capability, resource],
      )
    ).rowCount
  )
    throw new HTTPException(403, {
      message: `Database ${capability} permission required`,
    })
  if (
    resource &&
    !(
      await db.query(
        'SELECT 1 FROM database_resources WHERE id=$1 AND project=$2',
        [resource, project],
      )
    ).rowCount
  )
    throw new HTTPException(404)
}
const createBody = z
  .object({
    slug,
    name: z.string().trim().min(1).max(100),
    connector_id: uuid,
    version: z.literal('17.6').default('17.6'),
    request_key: uuid,
  })
  .strict()
const destinationBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    connector_id: uuid,
    config: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('disk'), root: z.string().min(1).max(1000) })
        .strict(),
      z
        .object({
          kind: z.literal('s3'),
          endpoint: z.url().refine((v) => {
            const u = new URL(v)
            return (
              u.protocol === 'https:' &&
              !u.username &&
              !u.password &&
              !u.search &&
              !u.hash
            )
          }),
          region: z.string().regex(/^[a-z0-9-]+$/),
          bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
          prefix: z
            .string()
            .regex(/^[A-Za-z0-9/_-]*$/)
            .max(200)
            .default('kloud'),
          accessKey: z.string().min(1).max(256),
          secretKey: z.string().min(1).max(1024),
        })
        .strict(),
    ]),
  })
  .strict()
const limit = z
  .object({
    destination: uuid,
    maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    minimumPoints: z.number().int().min(1).max(10000),
    reserveBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
const policyBody = z
  .object({
    name: z.string().min(1).max(100),
    destinations: z.array(limit).min(1).max(2),
    cron: z.string().max(100),
    timezone: z.string().max(100),
    enabled: z.boolean().default(false),
  })
  .strict()
export const recovery = new Hono<Env>()
recovery.use('*', requireUser)
const base = '/projects/:project/databases'
async function activeHost(db: DB, id: string) {
  if (
    !(
      await db.query(
        "SELECT 1 FROM connectors WHERE id=$1 AND NOT revoked AND 'postgres'=ANY(capabilities)",
        [id],
      )
    ).rowCount
  )
    throw new HTTPException(409, {
      message: 'Choose an active host with PostgreSQL management enabled',
    })
}
async function resource(
  db: DB,
  project: string,
  input: z.infer<typeof createBody>,
) {
  await activeHost(db, input.connector_id)
  const id = randomUUID(),
    credentials = {
      username: 'kloud',
      database: 'app',
      password: randomBytes(32).toString('base64url'),
      adminPassword: randomBytes(32).toString('base64url'),
    }
  await db.query(
    'INSERT INTO database_resources(id,project,slug,name,connector_id,version,encrypted_credentials) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      id,
      project,
      input.slug,
      input.name,
      input.connector_id,
      input.version,
      seal(credentials),
    ],
  )
  return id
}
async function enqueue(
  db: DB,
  user: User,
  id: string,
  kind: string,
  key: string,
  config: unknown = {},
  policy: string | null = null,
) {
  const row = (
    await db.query('SELECT connector_id FROM database_resources WHERE id=$1', [
      id,
    ])
  ).rows[0]
  const job = randomUUID()
  const result = await db.query(
    'INSERT INTO database_jobs(id,resource,connector_id,actor,kind,request_key,config,policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(request_key) DO NOTHING RETURNING id',
    [job, id, row.connector_id, user.id, kind, key, config, policy],
  )
  if (result.rowCount) return job
  const existing = (
    await db.query(
      'SELECT id,resource,kind,config,policy FROM database_jobs WHERE request_key=$1',
      [key],
    )
  ).rows[0]
  if (
    existing?.resource !== id ||
    existing.kind !== kind ||
    existing.policy !== policy ||
    JSON.stringify(existing.config) !== JSON.stringify(config)
  )
    throw new HTTPException(409, {
      message: 'Request key belongs to another operation',
    })
  return existing.id
}
recovery.get(base, async (c) => {
  const user = c.get('user'),
    project = c.req.param('project')
  const access = await projectAccess(user, project)
  const rows = (
    await pool.query(
      `SELECT r.id,r.slug,r.name,r.connector_id,r.version,r.state,r.created FROM database_resources r WHERE r.project=$1 AND ($3 OR EXISTS(SELECT 1 FROM database_grants g WHERE g.user_id=$2 AND g.project=$1 AND (g.resource IS NULL OR g.resource=r.id))) ORDER BY r.name`,
      [project, user.id, access.can_manage_access],
    )
  ).rows
  const grants = (
    await pool.query(
      'SELECT resource,capability FROM database_grants WHERE project=$1 AND user_id=$2',
      [project, user.id],
    )
  ).rows
  const allows = (cap: Capability, id: string | null = null) =>
    access.can_manage_access ||
    grants.some(
      (g) => g.capability === cap && (g.resource === null || g.resource === id),
    )
  return c.json({
    can_create: allows('manage'),
    can_restore: allows('restore'),
    can_destinations: allows('destinations'),
    can_manage_access: access.can_manage_access,
    resources: rows.map((r) => ({
      ...r,
      permissions: Object.fromEntries(
        capabilities.map((cap) => [cap, allows(cap, r.id)]),
      ),
    })),
  })
})
recovery.get(`${base}/hosts/list`, async (c) => {
  await projectAccess(c.get('user'), c.req.param('project'))
  return c.json(
    (
      await pool.query(
        "SELECT id,name,seen,capabilities FROM connectors WHERE NOT revoked AND 'postgres'=ANY(capabilities) ORDER BY name",
      )
    ).rows,
  )
})
recovery.post(base, async (c) => {
  const body = createBody.parse(await c.req.json()),
    project = c.req.param('project')
  const result = await permissionTransaction(
    c.get('user'),
    async (db, user) => {
      await demandDatabase(user, project, 'manage', null, db)
      const previous = (
        await db.query(
          'SELECT j.id,j.resource,j.kind,j.config,r.slug,r.name,r.connector_id,r.version FROM database_jobs j JOIN database_resources r ON r.id=j.resource WHERE request_key=$1 AND r.project=$2 AND actor=$3',
          [body.request_key, project, user.id],
        )
      ).rows[0]
      if (previous) {
        if (
          previous.kind !== 'create' ||
          previous.slug !== body.slug ||
          previous.name !== body.name ||
          previous.connector_id !== body.connector_id ||
          previous.version !== body.version
        )
          throw new HTTPException(409, {
            message: 'Request key was already used with different inputs',
          })
        return { id: previous.id, resource: previous.resource }
      }
      const id = await resource(db, project, body)
      return {
        resource: id,
        id: await enqueue(db, user, id, 'create', body.request_key),
      }
    },
  )
  return c.json(result, 202)
})
recovery.get(`${base}/:id`, async (c) => {
  const id = uuid.parse(c.req.param('id'))
  await demandDatabase(c.get('user'), c.req.param('project'), 'read', id)
  const row = (
    await pool.query(
      'SELECT id,name,slug,version,connector_id,state FROM database_resources WHERE id=$1',
      [id],
    )
  ).rows[0]
  const jobs = (
    await pool.query(
      'SELECT j.id,j.kind,j.state,j.created,j.started,j.finished,j.log,j.result,EXISTS(SELECT 1 FROM database_imports i WHERE i.job=j.id) AS has_import FROM database_jobs j WHERE j.resource=$1 ORDER BY sequence DESC LIMIT 50',
      [id],
    )
  ).rows
  const archives = (
    await pool.query(
      'SELECT a.id,a.policy,a.destination,a.state,a.metadata,a.created,d.name AS destination_name FROM database_archives a LEFT JOIN backup_destinations d ON d.id=a.destination WHERE a.resource=$1 ORDER BY a.created DESC LIMIT 100',
      [id],
    )
  ).rows
  const policies = (
    await pool.query(
      'SELECT id,name,config,enabled,next_run FROM backup_policies WHERE resource=$1 ORDER BY created',
      [id],
    )
  ).rows
  const runtime =
    (
      await pool.query(
        "SELECT i.data->>'state' AS state,i.data->>'health' AS health,c.docker_seen AS seen,(c.docker_seen IS NULL OR c.docker_seen<now()-interval '20 seconds') AS stale FROM database_resources r JOIN inventory i ON i.connector_id=r.connector_id AND i.data->>'name'='kloud-postgres-' || r.id::text JOIN connectors c ON c.id=r.connector_id WHERE r.id=$1",
        [id],
      )
    ).rows[0] ?? null
  return c.json({ ...row, jobs, archives, policies, runtime })
})
recovery.get(`${base}/:id/credentials`, async (c) => {
  const result = await permissionTransaction(
    c.get('user'),
    async (db, user) => {
      const id = uuid.parse(c.req.param('id'))
      await demandDatabase(user, c.req.param('project'), 'reveal', id, db)
      const row = (
        await db.query(
          'SELECT encrypted_credentials FROM database_resources WHERE id=$1',
          [id],
        )
      ).rows[0]
      const { adminPassword: _, ...credentials } = unseal(
        row.encrypted_credentials,
      )
      return {
        ...credentials,
        hostname: `kloud-postgres-${id}`,
        port: 5432,
        network: `kloud-db-${c.req.param('project')}`,
        public: false,
      }
    },
  )
  return c.json(result)
})
recovery.post(`${base}/:id/operations`, async (c) => {
  const id = uuid.parse(c.req.param('id')),
    body = z
      .object({
        action: z.enum(['start', 'stop', 'restart', 'logs']),
        request_key: uuid,
      })
      .strict()
      .parse(await c.req.json())
  const job = await permissionTransaction(c.get('user'), async (db, user) => {
    await demandDatabase(
      user,
      c.req.param('project'),
      body.action === 'logs' ? 'read' : 'manage',
      id,
      db,
    )
    return enqueue(db, user, id, body.action, body.request_key)
  })
  return c.json({ id: job }, 202)
})
recovery.post(`${base}/:id/reconcile`, async (c) => {
  const id = uuid.parse(c.req.param('id')),
    body = z
      .object({
        unknown_job: uuid,
        request_key: uuid,
        confirm: z.literal(true),
      })
      .strict()
      .parse(await c.req.json())
  const job = await permissionTransaction(c.get('user'), async (db, user) => {
    await demandDatabase(user, c.req.param('project'), 'manage', id, db)
    const unknown = (
      await db.query(
        "SELECT kind FROM database_jobs WHERE id=$1 AND resource=$2 AND state='unknown'",
        [body.unknown_job, id],
      )
    ).rows[0]
    if (!unknown)
      throw new HTTPException(409, {
        message: 'Choose an unresolved unknown operation',
      })
    return enqueue(db, user, id, 'reconcile', body.request_key, {
      unknown_job: body.unknown_job,
      unknown_kind: unknown.kind,
    })
  })
  return c.json({ id: job }, 202)
})
recovery.get(`${base}/destinations/list`, async (c) => {
  await projectAccess(c.get('user'), c.req.param('project'))
  return c.json(
    (
      await pool.query(
        'SELECT id,name,connector_id,kind FROM backup_destinations WHERE project=$1 ORDER BY name',
        [c.req.param('project')],
      )
    ).rows,
  )
})
recovery.post(`${base}/destinations`, async (c) => {
  const body = destinationBody.parse(await c.req.json())
  const id = await permissionTransaction(c.get('user'), async (db, user) => {
    await demandDatabase(user, c.req.param('project'), 'destinations', null, db)
    await activeHost(db, body.connector_id)
    const id = randomUUID()
    await db.query(
      'INSERT INTO backup_destinations(id,project,connector_id,name,kind,encrypted_config) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        c.req.param('project'),
        body.connector_id,
        body.name,
        body.config.kind,
        seal(body.config),
      ],
    )
    return id
  })
  return c.json({ id }, 201)
})
recovery.post(`${base}/destinations/:destination/test`, async (c) => {
  const destination = uuid.parse(c.req.param('destination')),
    body = z
      .object({ resource: uuid, request_key: uuid })
      .strict()
      .parse(await c.req.json())
  const job = await permissionTransaction(c.get('user'), async (db, user) => {
    await demandDatabase(user, c.req.param('project'), 'destinations', null, db)
    const row = (
      await db.query(
        'SELECT d.connector_id FROM backup_destinations d JOIN database_resources r ON r.connector_id=d.connector_id WHERE d.id=$1 AND d.project=$2 AND r.id=$3 AND r.project=$2',
        [destination, c.req.param('project'), body.resource],
      )
    ).rows[0]
    if (!row)
      throw new HTTPException(400, {
        message:
          'Select a database on the destination host for the connection test',
      })
    return enqueue(
      db,
      user,
      body.resource,
      'test-destination',
      body.request_key,
      { destination },
    )
  })
  return c.json({ id: job }, 202)
})
recovery.post(`${base}/:id/policies/preview`, async (c) => {
  const id = uuid.parse(c.req.param('id'))
  await demandDatabase(c.get('user'), c.req.param('project'), 'backup', id)
  const body = policyBody.parse(await c.req.json())
  try {
    return c.json({
      next_run: nextBackupRun(body.cron, body.timezone),
      destinations: body.destinations,
      timezone: body.timezone,
      cron: body.cron,
    })
  } catch (e) {
    throw new HTTPException(400, {
      message: e instanceof Error ? e.message : 'Invalid schedule',
    })
  }
})
recovery.post(`${base}/:id/policies`, async (c) => {
  const id = uuid.parse(c.req.param('id')),
    body = policyBody.parse(await c.req.json())
  let next: Date
  try {
    next = nextBackupRun(body.cron, body.timezone)
  } catch (e) {
    throw new HTTPException(400, {
      message: e instanceof Error ? e.message : 'Invalid schedule',
    })
  }
  const policy = await permissionTransaction(
    c.get('user'),
    async (db, user) => {
      await demandDatabase(user, c.req.param('project'), 'backup', id, db)
      const host = (
        await db.query(
          'SELECT connector_id FROM database_resources WHERE id=$1',
          [id],
        )
      ).rows[0].connector_id
      const destinations = (
        await db.query(
          'SELECT id,kind FROM backup_destinations WHERE id=ANY($1::uuid[]) AND project=$2 AND connector_id=$3',
          [
            body.destinations.map((d) => d.destination),
            c.req.param('project'),
            host,
          ],
        )
      ).rows
      if (
        destinations.length !== body.destinations.length ||
        new Set(destinations.map((d) => d.kind)).size !== destinations.length
      )
        throw new HTTPException(400, {
          message:
            'Select one disk destination, one S3 destination, or both on this host',
        })
      const policy = randomUUID()
      await db.query(
        'INSERT INTO backup_policies(id,resource,name,config,enabled,next_run) VALUES($1,$2,$3,$4,$5,$6)',
        [
          policy,
          id,
          body.name,
          { ...body, owner: user.id },
          body.enabled,
          next,
        ],
      )
      return policy
    },
  )
  return c.json({ id: policy, next_run: next }, 201)
})
recovery.put(`${base}/:id/policies/:policy`, async (c) => {
  const id = uuid.parse(c.req.param('id')),
    policy = uuid.parse(c.req.param('policy')),
    body = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, user) => {
    await demandDatabase(user, c.req.param('project'), 'backup', id, db)
    const p = (
      await db.query(
        'SELECT config FROM backup_policies WHERE id=$1 AND resource=$2 FOR UPDATE',
        [policy, id],
      )
    ).rows[0]
    if (!p) throw new HTTPException(404)
    await db.query(
      'UPDATE backup_policies SET enabled=$2,next_run=$3 WHERE id=$1',
      [policy, body.enabled, nextBackupRun(p.config.cron, p.config.timezone)],
    )
  })
  return c.json({ saved: true })
})
recovery.post(`${base}/:id/backups`, async (c) => {
  const id = uuid.parse(c.req.param('id')),
    body = z
      .object({ policy: uuid, request_key: uuid })
      .strict()
      .parse(await c.req.json())
  const job = await permissionTransaction(c.get('user'), async (db, user) => {
    await demandDatabase(user, c.req.param('project'), 'backup', id, db)
    if (
      !(
        await db.query(
          'SELECT 1 FROM backup_policies WHERE id=$1 AND resource=$2',
          [body.policy, id],
        )
      ).rowCount
    )
      throw new HTTPException(404)
    return enqueue(db, user, id, 'backup', body.request_key, {}, body.policy)
  })
  return c.json({ id: job }, 202)
})
recovery.post(`${base}/:id/restores`, async (c) => {
  const source = uuid.parse(c.req.param('id')),
    body = createBody.extend({ archive: uuid }).parse(await c.req.json())
  const result = await permissionTransaction(
    c.get('user'),
    async (db, user) => {
      await demandDatabase(user, c.req.param('project'), 'restore', source, db)
      const archive = (
        await db.query(
          "SELECT a.*,d.connector_id FROM database_archives a JOIN backup_destinations d ON d.id=a.destination WHERE a.id=$1 AND a.resource=$2 AND a.state='complete'",
          [body.archive, source],
        )
      ).rows[0]
      if (!archive)
        throw new HTTPException(404, { message: 'Complete backup not found' })
      if (
        archive.connector_id !== body.connector_id &&
        archive.metadata.kind !== 's3'
      )
        throw new HTTPException(400, {
          message:
            'Disk restores must run on the source host; select an S3 artifact for another host',
        })
      const previous = (
        await db.query(
          'SELECT j.id,j.resource,j.kind,j.config,r.slug,r.name,r.connector_id,r.version FROM database_jobs j JOIN database_resources r ON r.id=j.resource WHERE request_key=$1 AND r.project=$2 AND actor=$3',
          [body.request_key, c.req.param('project'), user.id],
        )
      ).rows[0]
      if (previous) {
        if (
          previous.kind !== 'restore' ||
          previous.slug !== body.slug ||
          previous.name !== body.name ||
          previous.connector_id !== body.connector_id ||
          previous.config.archive !== body.archive ||
          previous.config.source !== source
        )
          throw new HTTPException(409, {
            message: 'Request key was already used with different inputs',
          })
        return { id: previous.id, resource: previous.resource }
      }
      const id = await resource(db, c.req.param('project'), body)
      await db.query(
        "INSERT INTO database_grants(user_id,project,resource,capability) SELECT $1,$2,$3,unnest(ARRAY['read','manage','backup','restore']) FROM memberships WHERE user_id=$1 AND project_slug=$2 ON CONFLICT DO NOTHING",
        [user.id, c.req.param('project'), id],
      )
      return {
        resource: id,
        id: await enqueue(db, user, id, 'restore', body.request_key, {
          archive: body.archive,
          source,
        }),
      }
    },
  )
  return c.json(result, 202)
})
recovery.post(`${base}/imports`, async (c) => {
  const bytes = Buffer.from(await c.req.arrayBuffer())
  if (bytes.length > 67108864 || bytes.subarray(0, 5).toString() !== 'PGDMP')
    throw new HTTPException(400, {
      message: 'Upload a PostgreSQL custom-format PGDMP archive, up to 64 MiB',
    })
  const body = createBody.parse({
    slug: c.req.header('x-target-slug'),
    name: c.req.header('x-target-name'),
    connector_id: c.req.header('x-connector-id'),
    request_key: c.req.header('x-request-key'),
  })
  const result = await permissionTransaction(
    c.get('user'),
    async (db, user) => {
      await demandDatabase(user, c.req.param('project'), 'restore', null, db)
      const previous = (
        await db.query(
          'SELECT j.id,j.resource,j.kind,j.config,r.slug,r.name,r.connector_id,r.version FROM database_jobs j JOIN database_resources r ON r.id=j.resource WHERE request_key=$1 AND r.project=$2 AND actor=$3',
          [body.request_key, c.req.param('project'), user.id],
        )
      ).rows[0]
      if (previous) {
        const old = (
          await db.query('SELECT checksum FROM database_imports WHERE job=$1', [
            previous.id,
          ])
        ).rows[0]
        if (
          previous.kind !== 'import' ||
          previous.slug !== body.slug ||
          previous.name !== body.name ||
          previous.connector_id !== body.connector_id ||
          previous.config.checksum !==
            createHash('sha256').update(bytes).digest('hex')
        )
          throw new HTTPException(409, {
            message: 'Request key was already used with different inputs',
          })
        return { id: previous.id, resource: previous.resource }
      }
      const staged = Number(
        (
          await db.query(
            'SELECT COALESCE(sum(octet_length(i.content)),0) AS bytes FROM database_imports i JOIN database_jobs j ON j.id=i.job JOIN database_resources r ON r.id=j.resource WHERE r.project=$1',
            [c.req.param('project')],
          )
        ).rows[0].bytes,
      )
      if (staged + bytes.length > 1073741824)
        throw new HTTPException(409, {
          message:
            'Project import staging exceeds 1 GiB. Inspect retained failed imports before uploading more archives.',
        })
      const id = await resource(db, c.req.param('project'), body),
        job = await enqueue(db, user, id, 'import', body.request_key, {
          checksum: createHash('sha256').update(bytes).digest('hex'),
        })
      await db.query(
        "INSERT INTO database_grants(user_id,project,resource,capability) SELECT $1,$2,$3,unnest(ARRAY['read','manage','backup','restore']) FROM memberships WHERE user_id=$1 AND project_slug=$2 ON CONFLICT DO NOTHING",
        [user.id, c.req.param('project'), id],
      )
      await db.query(
        'INSERT INTO database_imports(job,content,checksum) VALUES($1,$2,$3)',
        [job, bytes, createHash('sha256').update(bytes).digest('hex')],
      )
      return { resource: id, id: job }
    },
  )
  return c.json(result, 202)
})
recovery.delete(`${base}/:id/imports/:job`, async (c) => {
  const id = uuid.parse(c.req.param('id')),
    job = uuid.parse(c.req.param('job'))
  await permissionTransaction(c.get('user'), async (db, user) => {
    await demandDatabase(user, c.req.param('project'), 'restore', id, db)
    const row = (
      await db.query(
        "SELECT state FROM database_jobs WHERE id=$1 AND resource=$2 AND kind='import' FOR UPDATE",
        [job, id],
      )
    ).rows[0]
    if (!row) throw new HTTPException(404)
    if (!['succeeded', 'failed', 'cancelled'].includes(row.state))
      throw new HTTPException(409, {
        message:
          'Reconcile this operation before discarding its retained source upload',
      })
    await db.query('DELETE FROM database_imports WHERE job=$1', [job])
  })
  return c.json({ discarded: true })
})
recovery.get(`${base}/access/grants`, async (c) => {
  await demandProjectAdmin(c.get('user'), c.req.param('project'))
  return c.json(
    (
      await pool.query(
        'SELECT user_id,resource,capability FROM database_grants WHERE project=$1',
        [c.req.param('project')],
      )
    ).rows,
  )
})
recovery.put(`${base}/access/grants`, async (c) => {
  const body = z
    .object({
      user_id: uuid,
      grants: z
        .array(
          z
            .object({
              resource: uuid.nullable(),
              capability: z.enum(capabilities),
            })
            .strict(),
        )
        .max(200),
    })
    .strict()
    .parse(await c.req.json())
  await permissionTransaction(c.get('user'), async (db, user) => {
    await demandProjectAdmin(user, c.req.param('project'), db)
    await db.query(
      'DELETE FROM database_grants WHERE project=$1 AND user_id=$2',
      [c.req.param('project'), body.user_id],
    )
    for (const g of body.grants) {
      if (
        g.resource &&
        !(
          await db.query(
            'SELECT 1 FROM database_resources WHERE id=$1 AND project=$2',
            [g.resource, c.req.param('project')],
          )
        ).rowCount
      )
        throw new HTTPException(400)
      await db.query(
        'INSERT INTO database_grants(user_id,project,resource,capability) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [body.user_id, c.req.param('project'), g.resource, g.capability],
      )
      if (g.capability !== 'read')
        await db.query(
          "INSERT INTO database_grants(user_id,project,resource,capability) VALUES($1,$2,$3,'read') ON CONFLICT DO NOTHING",
          [body.user_id, c.req.param('project'), g.resource],
        )
    }
  })
  return c.json({ saved: true })
})

export const recoveryWorker = new Hono<{ Variables: { connector: string } }>()
recoveryWorker.use('/connectors/recovery/*', async (c, next) => {
  const token = c.req
    .header('authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
  const host = token
    ? (
        await pool.query(
          "SELECT id FROM connectors WHERE token=$1 AND NOT revoked AND 'postgres'=ANY(capabilities)",
          [digest(token)],
        )
      ).rows[0]
    : null
  if (!host) throw new HTTPException(401)
  c.set('connector', host.id)
  await next()
})
recoveryWorker.post('/connectors/recovery/claim', async (c) => {
  const job = await transaction(async (db) => {
    if (
      !(
        await db.query(
          'SELECT id FROM connectors WHERE id=$1 AND NOT revoked FOR UPDATE',
          [c.get('connector')],
        )
      ).rowCount
    )
      throw new HTTPException(401)
    // An expired lease is uncertain. Never automatically execute a duplicate restore.
    await db.query(
      "UPDATE database_jobs SET state='unknown',finished=now(),log='Worker lease expired; inspect the host before any recovery operation. No automatic retry.' WHERE connector_id=$1 AND state='running' AND started<now()-interval '65 minutes'",
      [c.get('connector')],
    )
    if (
      (
        await db.query(
          "SELECT 1 FROM database_jobs WHERE connector_id=$1 AND state='running'",
          [c.get('connector')],
        )
      ).rowCount
    )
      return null
    const due = (
      await db.query(
        'SELECT p.*,r.connector_id FROM backup_policies p JOIN database_resources r ON r.id=p.resource WHERE r.connector_id=$1 AND p.enabled AND p.next_run<=now() ORDER BY p.next_run,p.id FOR UPDATE OF p',
        [c.get('connector')],
      )
    ).rows
    for (const p of due) {
      const key = randomUUID()
      await db.query(
        "INSERT INTO database_jobs(id,resource,connector_id,actor,kind,request_key,policy) VALUES($1,$2,$3,$4,'backup',$1,$5)",
        [key, p.resource, p.connector_id, p.config.owner, p.id],
      )
      await db.query('UPDATE backup_policies SET next_run=$2 WHERE id=$1', [
        p.id,
        nextBackupRun(p.config.cron, p.config.timezone),
      ])
    }
    const row = (
      await db.query(
        "SELECT j.*,r.project,r.slug,r.version,r.encrypted_credentials FROM database_jobs j JOIN database_resources r ON r.id=j.resource WHERE j.connector_id=$1 AND j.state='queued' AND (j.kind='reconcile' OR NOT EXISTS(SELECT 1 FROM database_jobs uncertain WHERE uncertain.connector_id=j.connector_id AND uncertain.state='unknown')) ORDER BY j.sequence LIMIT 1 FOR UPDATE OF j",
        [c.get('connector')],
      )
    ).rows[0]
    if (!row) return null
    const actor = (
      await db.query(
        'SELECT id,username,admin,capabilities FROM users WHERE id=$1 AND NOT disabled',
        [row.actor],
      )
    ).rows[0]
    try {
      if (!actor) throw new Error('owner unavailable')
      const cap: Capability =
        row.kind === 'backup'
          ? 'backup'
          : row.kind === 'restore' || row.kind === 'import'
            ? 'restore'
            : row.kind === 'logs'
              ? 'read'
              : row.kind === 'test-destination'
                ? 'destinations'
                : 'manage'
      await demandDatabase(
        actor,
        row.project,
        cap,
        row.kind === 'restore'
          ? row.config.source
          : row.kind === 'import' || row.kind === 'test-destination'
            ? null
            : row.resource,
        db,
      )
    } catch {
      await db.query(
        "UPDATE database_jobs SET state='cancelled',finished=now(),log='Current database permission or account access was revoked' WHERE id=$1",
        [row.id],
      )
      return null
    }
    let backup: any = null
    if (row.policy) {
      const policy = (
        await db.query(
          'SELECT config FROM backup_policies WHERE id=$1 AND resource=$2',
          [row.policy, row.resource],
        )
      ).rows[0]
      if (!policy) throw new Error('Policy unavailable')
      backup = {
        id: row.policy,
        ...policy.config,
        destinations: await Promise.all(
          policy.config.destinations.map(async (d: any) => {
            const dest = (
              await db.query(
                'SELECT encrypted_config FROM backup_destinations WHERE id=$1 AND project=$2 AND connector_id=$3',
                [d.destination, row.project, row.connector_id],
              )
            ).rows[0]
            if (!dest) throw new Error('Destination unavailable')
            const points = (
              await db.query(
                "SELECT id,metadata,created FROM database_archives WHERE policy=$1 AND destination=$2 AND state='complete' ORDER BY created",
                [row.policy, d.destination],
              )
            ).rows
            return { ...d, config: unseal(dest.encrypted_config), points }
          }),
        ),
      }
    }
    let archive: any = null
    if (row.kind === 'restore') {
      const a = (
        await db.query(
          "SELECT a.*,d.encrypted_config FROM database_archives a JOIN backup_destinations d ON d.id=a.destination WHERE a.id=$1 AND a.state='complete'",
          [row.config.archive],
        )
      ).rows[0]
      if (!a) throw new Error('Backup unavailable')
      archive = { ...a.metadata, destination: unseal(a.encrypted_config) }
    }
    const destination =
      row.kind === 'test-destination'
        ? (
            await db.query(
              'SELECT encrypted_config FROM backup_destinations WHERE id=$1 AND project=$2 AND connector_id=$3',
              [row.config.destination, row.project, row.connector_id],
            )
          ).rows[0]
        : null
    const upload =
      row.kind === 'import'
        ? (
            await db.query(
              'SELECT checksum FROM database_imports WHERE job=$1',
              [row.id],
            )
          ).rows[0]
        : null
    await db.query(
      "UPDATE database_jobs SET state='running',started=now() WHERE id=$1",
      [row.id],
    )
    return {
      id: row.id,
      resource: row.resource,
      project: row.project,
      slug: row.slug,
      version: row.version,
      kind: row.kind,
      credentials: unseal(row.encrypted_credentials),
      backup,
      archive,
      upload,
      destination: destination ? unseal(destination.encrypted_config) : null,
      reconciliation: row.kind === 'reconcile' ? row.config : null,
    }
  })
  return c.json({ job })
})
recoveryWorker.get('/connectors/recovery/:id/archive', async (c) => {
  const row = (
    await pool.query(
      "SELECT i.content,i.checksum FROM database_imports i JOIN database_jobs j ON j.id=i.job WHERE j.id=$1 AND j.connector_id=$2 AND j.state='running'",
      [uuid.parse(c.req.param('id')), c.get('connector')],
    )
  ).rows[0]
  if (!row) throw new HTTPException(404)
  c.header('Content-Type', 'application/octet-stream')
  c.header('X-Archive-SHA256', row.checksum)
  return c.body(new Uint8Array(row.content))
})
recoveryWorker.post('/connectors/recovery/:id/result', async (c) => {
  const body = z
    .object({
      state: z.enum(['succeeded', 'partial', 'failed', 'unknown']),
      log: z.string().max(16000),
      result: z.record(z.string(), z.unknown()).default({}),
      artifacts: z
        .array(
          z
            .object({
              destination: uuid,
              state: z.enum(['complete', 'failed']),
              metadata: z.record(z.string(), z.unknown()),
            })
            .strict(),
        )
        .max(2)
        .default([]),
      pruned: z.array(uuid).max(10000).default([]),
    })
    .strict()
    .parse(await c.req.json())
  await transaction(async (db) => {
    const row = (
      await db.query(
        "SELECT j.*,r.encrypted_credentials FROM database_jobs j JOIN database_resources r ON r.id=j.resource WHERE j.id=$1 AND j.connector_id=$2 AND j.state='running' FOR UPDATE OF j",
        [uuid.parse(c.req.param('id')), c.get('connector')],
      )
    ).rows[0]
    if (!row) return
    // Worker logs are deliberately bounded and passwords never appear in API output.
    const credentials = unseal(row.encrypted_credentials)
    const log = [credentials.password, credentials.adminPassword].reduce(
      (text, secret) => text.split(secret).join('[redacted]'),
      body.log,
    )
    await db.query(
      'UPDATE database_jobs SET state=$2,log=$3,result=$4,finished=now() WHERE id=$1',
      [row.id, body.state, log, body.result],
    )
    if (row.kind === 'reconcile' && body.state === 'succeeded') {
      const snapshot = z
        .object({
          quiescent: z.literal(true),
          container_exists: z.boolean(),
          running: z.boolean(),
        })
        .passthrough()
        .parse(body.result)
      const original = (
        await db.query(
          "UPDATE database_jobs SET state='failed',finished=now(),log=log || E'\nExplicit host reconciliation established quiescence. Original operation remains failed; no automatic retry or successful restore is inferred.',result=$3 WHERE id=$1 AND resource=$2 AND state='unknown' RETURNING kind",
          [
            row.config.unknown_job,
            row.resource,
            { reconciliation_job: row.id, ...snapshot },
          ],
        )
      ).rows[0]
      if (original)
        await db.query('UPDATE database_resources SET state=$2 WHERE id=$1', [
          row.resource,
          ['create', 'restore', 'import'].includes(original.kind)
            ? 'failed'
            : snapshot.running
              ? 'ready'
              : 'stopped',
        ])
    }
    if (['create', 'restore', 'import'].includes(row.kind))
      await db.query('UPDATE database_resources SET state=$2 WHERE id=$1', [
        row.resource,
        body.state === 'succeeded'
          ? 'ready'
          : body.state === 'unknown'
            ? 'unknown'
            : 'failed',
      ])
    if (row.kind === 'stop' && body.state === 'succeeded')
      await db.query(
        "UPDATE database_resources SET state='stopped' WHERE id=$1",
        [row.resource],
      )
    if (['start', 'restart'].includes(row.kind) && body.state === 'succeeded')
      await db.query(
        "UPDATE database_resources SET state='ready' WHERE id=$1",
        [row.resource],
      )
    if (row.kind === 'backup' && row.policy) {
      for (const artifact of body.artifacts) {
        if (
          !(
            await db.query(
              "SELECT 1 FROM backup_policies WHERE id=$1 AND config->'destinations' @> $2::jsonb",
              [
                row.policy,
                JSON.stringify([{ destination: artifact.destination }]),
              ],
            )
          ).rowCount
        )
          throw new HTTPException(400)
        await db.query(
          'INSERT INTO database_archives(id,job,resource,policy,destination,state,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            randomUUID(),
            row.id,
            row.resource,
            row.policy,
            artifact.destination,
            artifact.state,
            artifact.metadata,
          ],
        )
      }
      if (body.pruned.length)
        await db.query(
          "UPDATE database_archives SET state='pruned' WHERE id=ANY($1::uuid[]) AND policy=$2 AND resource=$3",
          [body.pruned, row.policy, row.resource],
        )
    }
    // Imported bytes remain until a terminal acknowledged outcome, then release staging.
    if (body.state === 'succeeded')
      await db.query('DELETE FROM database_imports WHERE job=$1', [row.id])
  })
  return c.json({ ok: true })
})
