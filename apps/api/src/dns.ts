import { addressNumber } from '@kloud/protocol/forwarding'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import {
  dnsRecordSchema,
  dnsRuleSchema,
  dnsActions,
  type DnsRule,
  type DnsGrant,
  type DnsLiveRecord,
} from '@kloud/protocol/dns'
import type { Env, User } from './auth.js'
import { pool } from './db.js'
import {
  demandServer,
  demandProjectAdmin,
  permissionTransaction,
} from './permissions.js'
import {
  CloudflareDns,
  decryptDnsToken,
  encryptDnsToken,
} from './dns-provider.js'
import {
  allowsDns,
  dnsAccess,
  dnsName,
  intersectDnsRules,
  normalizeDnsRule,
  withinDnsName,
} from './dns-permissions.js'

export const dns = new Hono<Env>()
const uuid = z.string().uuid()
export const dnsProviderBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    token: z.string().trim().min(1).max(4096),
  })
  .strict()
export const dnsProviderUpdate = dnsProviderBody
  .partial()
  .extend({ enabled: z.boolean().optional() })
  .strict()
export const dnsDelegationBody = z
  .object({ rules: z.array(dnsRuleSchema).max(200) })
  .strict()
type Provider = {
  id: string
  name: string
  owner_project: string | null
  encrypted_token: string
  enabled: boolean
}
type Zone = {
  id: string
  provider_id: string
  external_id: string
  name: string
  rules: DnsRule[]
  encrypted_token: string
  enabled: boolean
  provider_name: string
  owner_project: string | null
}
const provider = (row: Provider | Zone) =>
  new CloudflareDns(decryptDnsToken(row.encrypted_token))
const notFound = () =>
  new HTTPException(404, { message: 'DNS resource not found' })

dns.get('/admin/dns/projects', async (c) => {
  demandServer(c.get('user'), 'dns.manage')
  return c.json(
    (await pool.query('SELECT slug,name FROM projects ORDER BY name')).rows,
  )
})

async function managedProvider(
  db: Pick<PoolClient, 'query'>,
  actor: User,
  id: string,
  project: string | null,
) {
  if (project === null) demandServer(actor, 'dns.manage')
  else await demandProjectAdmin(actor, project, db)
  const row = (
    await db.query<Provider>(
      'SELECT * FROM dns_providers WHERE id=$1 AND owner_project IS NOT DISTINCT FROM $2',
      [uuid.parse(id), project],
    )
  ).rows[0]
  if (!row) throw notFound()
  return row
}
async function zoneAccess(
  db: Pick<PoolClient, 'query'>,
  actor: User,
  project: string,
  id: string,
) {
  const access = await dnsAccess(actor, project, db)
  const zone = (
    await db.query<Zone>(
      `SELECT z.*,d.rules,p.encrypted_token,p.enabled,p.name AS provider_name,p.owner_project
    FROM dns_zones z JOIN dns_providers p ON p.id=z.provider_id JOIN dns_delegations d ON d.zone_id=z.id
    WHERE z.id=$1 AND d.project_slug=$2 AND p.enabled`,
      [uuid.parse(id), project],
    )
  ).rows[0]
  const member = access.memberRules?.filter((r) => r.zone_id === id) ?? null
  if (!zone || !zone.rules.length || (member !== null && !member.length))
    throw notFound()
  const allows = (
    action: (typeof dnsActions)[number],
    record: { name: string; type: string; id?: string },
  ) =>
    withinDnsName(dnsName(record.name), zone.name) &&
    allowsDns(zone.rules, member, action, {
      ...record,
      name: dnsName(record.name),
    })
  const effective =
    member === null
      ? zone.rules
      : zone.rules.flatMap((a) =>
          member.flatMap((b) => {
            const r = intersectDnsRules(a, b)
            return r ? [r] : []
          }),
        )
  return { zone, allows, effective, admin: access.admin }
}
function publicRecord(
  record: DnsLiveRecord,
  allows: (a: (typeof dnsActions)[number], r: DnsLiveRecord) => boolean,
) {
  // Explicit allowlist: provider metadata must never escape through record data.
  const {
    id,
    type,
    name,
    ttl,
    content,
    priority,
    data,
    proxied,
    comment,
    tags,
    settings,
  } = record
  return {
    id,
    type,
    name,
    ttl,
    content,
    priority,
    data,
    proxied,
    comment,
    tags,
    settings,
    actions: dnsActions.filter((a) => a !== 'create' && allows(a, record)),
  }
}

for (const base of [
  '/admin/dns/providers',
  '/projects/:project/dns/providers',
]) {
  const owner = (project: string | undefined) => project ?? null
  dns.get(base, async (c) => {
    const project = owner(c.req.param('project'))
    if (project === null) demandServer(c.get('user'), 'dns.manage')
    else await demandProjectAdmin(c.get('user'), project)
    return c.json(
      (
        await pool.query(
          'SELECT id,name,type,owner_project,enabled FROM dns_providers WHERE owner_project IS NOT DISTINCT FROM $1 ORDER BY name',
          [project],
        )
      ).rows,
    )
  })
  dns.post(base, async (c) => {
    const body = dnsProviderBody.parse(await c.req.json()),
      project = owner(c.req.param('project'))
    const id = await permissionTransaction(c.get('user'), async (db, actor) => {
      if (project === null) demandServer(actor, 'dns.manage')
      else await demandProjectAdmin(actor, project, db)
      const encrypted = encryptDnsToken(body.token)
      await new CloudflareDns(body.token).check()
      const id = randomUUID()
      await db.query(
        'INSERT INTO dns_providers(id,name,owner_project,encrypted_token) VALUES($1,$2,$3,$4)',
        [id, body.name, project, encrypted],
      )
      return id
    })
    return c.json({ id }, 201)
  })
  dns.put(`${base}/:id`, async (c) => {
    const body = dnsProviderUpdate.parse(await c.req.json())
    await permissionTransaction(c.get('user'), async (db, actor) => {
      const row = await managedProvider(
        db,
        actor,
        c.req.param('id'),
        owner(c.req.param('project')),
      )
      if (body.token) await new CloudflareDns(body.token).check()
      await db.query(
        'UPDATE dns_providers SET name=$2,encrypted_token=$3,enabled=$4 WHERE id=$1',
        [
          row.id,
          body.name ?? row.name,
          body.token ? encryptDnsToken(body.token) : row.encrypted_token,
          body.enabled ?? row.enabled,
        ],
      )
    })
    return c.json({ ok: true })
  })
  dns.delete(`${base}/:id`, async (c) => {
    await permissionTransaction(c.get('user'), async (db, actor) => {
      const row = await managedProvider(
        db,
        actor,
        c.req.param('id'),
        owner(c.req.param('project')),
      )
      await db.query('DELETE FROM dns_providers WHERE id=$1', [row.id])
    })
    return c.json({ ok: true })
  })
  dns.post(`${base}/:id/test`, async (c) => {
    const row = await managedProvider(
      pool,
      c.get('user'),
      c.req.param('id'),
      owner(c.req.param('project')),
    )
    await provider(row).check()
    return c.json({ ok: true })
  })
  // Discovery returns choices only. Importing a choice never grants access.
  dns.post(`${base}/:id/discover`, async (c) => {
    const zones = await permissionTransaction(
      c.get('user'),
      async (db, actor) => {
        const row = await managedProvider(
          db,
          actor,
          c.req.param('id'),
          owner(c.req.param('project')),
        )
        const discovered = await provider(row).zones()
        const result = []
        for (const zone of discovered) {
          const saved = (
            await db.query(
              'INSERT INTO dns_zones(id,provider_id,external_id,name) VALUES($1,$2,$3,$4) ON CONFLICT(provider_id,external_id) DO UPDATE SET name=EXCLUDED.name RETURNING id,name',
              [randomUUID(), row.id, zone.id, dnsName(zone.name)],
            )
          ).rows[0]
          result.push(saved)
        }
        return result
      },
    )
    return c.json(zones)
  })
  dns.get(`${base}/:id/zones`, async (c) => {
    const row = await managedProvider(
      pool,
      c.get('user'),
      c.req.param('id'),
      owner(c.req.param('project')),
    )
    return c.json(
      (
        await pool.query(
          `SELECT z.id,z.name,
      COALESCE((SELECT json_agg(json_build_object('project',d.project_slug,'rules',d.rules)) FROM dns_delegations d WHERE d.zone_id=z.id),'[]') AS delegations
      FROM dns_zones z WHERE z.provider_id=$1 ORDER BY z.name`,
          [row.id],
        )
      ).rows,
    )
  })
  dns.get(`${base}/:id/zones/:zone/records`, async (c) => {
    const row = await managedProvider(
      pool,
      c.get('user'),
      c.req.param('id'),
      owner(c.req.param('project')),
    )
    const zone = (
      await pool.query(
        'SELECT external_id FROM dns_zones WHERE id=$1 AND provider_id=$2',
        [uuid.parse(c.req.param('zone')), row.id],
      )
    ).rows[0]
    if (!zone) throw notFound()
    return c.json(
      (await provider(row).records(zone.external_id)).map((r) =>
        publicRecord(r, () => true),
      ),
    )
  })
  dns.put(`${base}/:id/zones/:zone/projects/:target`, async (c) => {
    const body = dnsDelegationBody.parse(await c.req.json())
    await permissionTransaction(c.get('user'), async (db, actor) => {
      const row = await managedProvider(
        db,
        actor,
        c.req.param('id'),
        owner(c.req.param('project')),
      )
      const target = c.req.param('target')
      if (row.owner_project !== null && row.owner_project !== target)
        throw new HTTPException(403, {
          message: 'Private providers cannot be shared',
        })
      const zone = (
        await db.query(
          'SELECT * FROM dns_zones WHERE id=$1 AND provider_id=$2',
          [uuid.parse(c.req.param('zone')), row.id],
        )
      ).rows[0]
      if (!zone) throw notFound()
      const rules = body.rules.map((r) => normalizeDnsRule(r, zone.name))
      for (const r of rules.filter((r) => r.kind === 'record'))
        await provider(row).record(zone.external_id, r.target!)
      if (!rules.length)
        await db.query(
          'DELETE FROM dns_delegations WHERE zone_id=$1 AND project_slug=$2',
          [zone.id, target],
        )
      else
        await db.query(
          'INSERT INTO dns_delegations(zone_id,project_slug,rules) VALUES($1,$2,$3) ON CONFLICT(zone_id,project_slug) DO UPDATE SET rules=EXCLUDED.rules',
          [zone.id, target, JSON.stringify(rules)],
        )
    })
    return c.json({ ok: true })
  })
}

dns.get('/projects/:project/dns/access-scopes', async (c) => {
  const project = c.req.param('project')
  await demandProjectAdmin(c.get('user'), project)
  return c.json({
    zones: (
      await pool.query(
        `SELECT z.id,z.name,d.rules FROM dns_zones z JOIN dns_delegations d ON d.zone_id=z.id JOIN dns_providers p ON p.id=z.provider_id WHERE d.project_slug=$1 AND p.enabled ORDER BY z.name`,
        [project],
      )
    ).rows,
  })
})
dns.get('/projects/:project/dns', async (c) => {
  const project = c.req.param('project'),
    access = await dnsAccess(c.get('user'), project)
  const rows = (
    await pool.query<Zone>(
      `SELECT z.id,z.name,z.provider_id,p.name AS provider_name,p.owner_project,d.rules
    FROM dns_zones z JOIN dns_providers p ON p.id=z.provider_id JOIN dns_delegations d ON d.zone_id=z.id
    WHERE d.project_slug=$1 AND p.enabled ORDER BY z.name`,
      [project],
    )
  ).rows
  const zones = []
  for (const row of rows) {
    if (!row.rules.length) continue
    if (access.memberRules !== null) {
      const rules = access.memberRules.filter((r) => r.zone_id === row.id)
      if (!rules.length) continue
      // Record-ID and name rules may intersect without a structural intersection.
      // Establish visibility using live records rather than leaking zone metadata.
      const a = await zoneAccess(pool, c.get('user'), project, row.id)
      const creation = a.effective.some((r) => r.actions.includes('create'))
      if (
        !creation &&
        !(await provider(a.zone).records(a.zone.external_id)).some((r) =>
          a.allows('read', r),
        )
      )
        continue
    }
    zones.push({
      id: row.id,
      name: row.name,
      provider_name: row.provider_name,
      origin: row.owner_project ? 'project' : 'server',
    })
  }
  return c.json({ can_manage_providers: access.admin, zones })
})
dns.get('/projects/:project/dns/zones/:zone/records', async (c) => {
  const a = await zoneAccess(
    pool,
    c.get('user'),
    c.req.param('project'),
    c.req.param('zone'),
  )
  const records = (await provider(a.zone).records(a.zone.external_id))
    .filter((r) => a.allows('read', r))
    .map((r) => publicRecord(r, a.allows))
  const creation_scopes = a.effective.filter(
    (r) => r.kind !== 'record' && r.actions.includes('create'),
  )
  if (!a.admin && !records.length && !creation_scopes.length) throw notFound()
  return c.json({ records, creation_scopes })
})
dns.post('/projects/:project/dns/zones/:zone/records', async (c) => {
  const body = dnsRecordSchema.parse(await c.req.json())
  body.name = dnsName(body.name)
  const record = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      const a = await zoneAccess(
        db,
        actor,
        c.req.param('project'),
        c.req.param('zone'),
      )
      if (!a.allows('create', body))
        throw new HTTPException(403, {
          message: 'DNS create permission required for this name and type',
        })
      return publicRecord(
        await provider(a.zone).create(a.zone.external_id, body),
        a.allows,
      )
    },
  )
  return c.json(record, 201)
})
dns.get('/projects/:project/dns/zones/:zone/records/:record', async (c) => {
  const a = await zoneAccess(
    pool,
    c.get('user'),
    c.req.param('project'),
    c.req.param('zone'),
  )
  const record = await provider(a.zone).record(
    a.zone.external_id,
    c.req.param('record'),
  )
  if (!a.allows('read', record)) throw notFound()
  return c.json(publicRecord(record, a.allows))
})
dns.put('/projects/:project/dns/zones/:zone/records/:record', async (c) => {
  const body = dnsRecordSchema.parse(await c.req.json())
  body.name = dnsName(body.name)
  const record = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      const a = await zoneAccess(
        db,
        actor,
        c.req.param('project'),
        c.req.param('zone'),
      )
      const current = await provider(a.zone).record(
        a.zone.external_id,
        c.req.param('record'),
      )
      if (!a.allows('read', current)) throw notFound()
      if (
        !a.allows('update', current) ||
        !a.allows('update', { ...body, id: current.id })
      )
        throw new HTTPException(403, {
          message:
            'DNS update permission required for current and proposed record',
        })
      return publicRecord(
        await provider(a.zone).update(a.zone.external_id, current.id, body),
        a.allows,
      )
    },
  )
  return c.json(record)
})
dns.delete('/projects/:project/dns/zones/:zone/records/:record', async (c) => {
  await permissionTransaction(c.get('user'), async (db, actor) => {
    const a = await zoneAccess(
      db,
      actor,
      c.req.param('project'),
      c.req.param('zone'),
    )
    const current = await provider(a.zone).record(
      a.zone.external_id,
      c.req.param('record'),
    )
    if (!a.allows('read', current)) throw notFound()
    if (!a.allows('delete', current))
      throw new HTTPException(403, {
        message: 'DNS delete permission required',
      })
    await provider(a.zone).delete(a.zone.external_id, current.id)
  })
  return c.json({ ok: true })
})

export async function saveDnsGrants(
  db: PoolClient,
  actor: User,
  user: string,
  project: string,
  grants: DnsGrant[] | undefined,
) {
  if (grants === undefined) return
  const normalized: DnsGrant[] = []
  for (const grant of grants) {
    const a = await zoneAccess(db, actor, project, grant.zone_id)
    const { zone_id: _, ...scope } = grant
    const rule = normalizeDnsRule(scope, a.zone.name)
    // Every action/type must be covered by a parent rule. A record-ID grant can
    // be narrowed from name scopes by resolving that record once.
    const record =
      rule.kind === 'record'
        ? await provider(a.zone).record(a.zone.external_id, rule.target!)
        : null
    const covered = rule.actions.every((action) =>
      rule.types.every((type) =>
        record
          ? a.allows(action, { ...record, type })
          : a.zone.rules.some((parent) => {
              const intersection = intersectDnsRules(parent, {
                ...rule,
                types: [type],
                actions: [action],
              })
              return (
                intersection &&
                intersection.kind === rule.kind &&
                intersection.target === rule.target
              )
            }),
      ),
    )
    if (!covered)
      throw new HTTPException(400, {
        message: 'Member DNS grant exceeds project delegation',
      })
    normalized.push({ ...rule, zone_id: grant.zone_id })
  }
  await db.query(
    'DELETE FROM dns_member_grants WHERE user_id=$1 AND project_slug=$2',
    [user, project],
  )
  for (const rule of normalized)
    await db.query(
      'INSERT INTO dns_member_grants(user_id,project_slug,zone_id,rule) VALUES($1,$2,$3,$4)',
      [user, project, rule.zone_id, JSON.stringify(rule)],
    )
}

function sameAddress(left: unknown, right: string) {
  if (typeof left !== 'string') return false
  try {
    const a = addressNumber(left),
      b = addressNumber(right)
    return a.bits === b.bits && a.value === b.value
  } catch {
    return false
  }
}

// Domain onboarding reuses DNS delegation; creating a route never grants DNS access.
export async function ensureDomainDns(
  db: Pick<PoolClient, 'query'>,
  actor: User,
  project: string,
  zone: string,
  input: { type: 'A' | 'AAAA'; name: string; content: string },
) {
  const body = dnsRecordSchema.parse({
    ...input,
    name: dnsName(input.name),
    ttl: 1,
    proxied: false,
  })
  const access = await zoneAccess(db, actor, project, zone)
  if (!access.allows('create', body))
    throw new HTTPException(403, {
      message:
        'DNS create permission required for this hostname and record type. Configure DNS manually or request delegation.',
    })
  const client = provider(access.zone)
  const existing = (await client.records(access.zone.external_id)).filter(
    (record) =>
      dnsName(record.name) === body.name &&
      (record.type === body.type || record.type === 'CNAME'),
  )
  if (existing.length) {
    if (
      existing.every(
        (record) =>
          record.type === body.type &&
          sameAddress(record.content, input.content) &&
          !record.proxied,
      )
    )
      return { unchanged: true }
    throw new HTTPException(409, {
      message:
        'Conflicting DNS records were preserved. Review them in Cloud DNS and explicitly update them with DNS update permission.',
    })
  }
  await client.create(access.zone.external_id, body)
  return { unchanged: false }
}
