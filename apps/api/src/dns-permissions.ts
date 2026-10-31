import { domainToASCII } from 'node:url'
import { HTTPException } from 'hono/http-exception'
import type { PoolClient } from 'pg'
import {
  dnsRuleSchema,
  type DnsAction,
  type DnsGrant,
  type DnsRule,
} from '@kloud/protocol/dns'
import { projectAccess } from './permissions.js'
import type { User } from './auth.js'
import { pool } from './db.js'

export function dnsName(value: string) {
  // domainToASCII uses URL host parsing, which would otherwise silently drop
  // path/query suffixes rather than reject an invalid DNS name.
  if (/[\s:/\\?#@]/.test(value))
    throw new HTTPException(400, { message: 'Invalid DNS name' })
  const name = domainToASCII(value.replace(/\.$/, '').toLowerCase())
  if (
    !name ||
    name.length > 253 ||
    !name
      .split('.')
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^(?:\*|[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)$/.test(label),
      )
  )
    throw new HTTPException(400, { message: 'Invalid DNS name' })
  return name
}
export function withinDnsName(name: string, root: string) {
  return name === root || name.endsWith(`.${root}`)
}
export function normalizeDnsRule(value: DnsRule, zone: string): DnsRule {
  const rule = dnsRuleSchema.parse(value)
  const target =
    rule.kind === 'zone'
      ? null
      : rule.kind === 'record'
        ? rule.target
        : dnsName(rule.target!)
  if (target && rule.kind !== 'record' && !withinDnsName(target, zone))
    throw new HTTPException(400, {
      message: 'DNS scope is outside the selected zone',
    })
  if (rule.kind === 'record' && !/^[a-f0-9]{32}$/.test(target!))
    throw new HTTPException(400, { message: 'Invalid provider record ID' })
  return {
    ...rule,
    target,
    types: [...new Set(rule.types)],
    actions: [...new Set([...rule.actions, 'read' as const])],
  }
}
export function matchesDnsRule(
  rule: DnsRule,
  action: DnsAction,
  record: { name: string; type: string; id?: string },
) {
  return (
    rule.actions.includes(action) &&
    rule.types.includes(record.type) &&
    (rule.kind === 'zone' ||
      (rule.kind === 'record' &&
        action !== 'create' &&
        rule.target === record.id) ||
      (rule.kind === 'name' && rule.target === record.name) ||
      (rule.kind === 'subtree' && withinDnsName(record.name, rule.target!)))
  )
}
export function allowsDns(
  projectRules: DnsRule[],
  memberRules: DnsRule[] | null,
  action: DnsAction,
  record: { name: string; type: string; id?: string },
) {
  return (
    projectRules.some((r) => matchesDnsRule(r, action, record)) &&
    (memberRules === null ||
      memberRules.some((r) => matchesDnsRule(r, action, record)))
  )
}
// Compute intersections for creation pickers, without advertising a broader
// name/type/action scope than either side permits.
export function intersectDnsRules(a: DnsRule, b: DnsRule): DnsRule | null {
  const types = a.types.filter((t) => b.types.includes(t)),
    actions = a.actions.filter((v) => b.actions.includes(v))
  if (!types.length || !actions.length) return null
  let scope: DnsRule
  if (a.kind === 'zone') scope = b
  else if (b.kind === 'zone') scope = a
  else if (a.kind === 'record' || b.kind === 'record') {
    if (a.kind !== 'record' || b.kind !== 'record' || a.target !== b.target)
      return null
    scope = a
  } else if (a.kind === 'name') {
    if (
      !(b.kind === 'name'
        ? a.target === b.target
        : withinDnsName(a.target!, b.target!))
    )
      return null
    scope = a
  } else if (b.kind === 'name') {
    if (!withinDnsName(b.target!, a.target!)) return null
    scope = b
  } else if (withinDnsName(a.target!, b.target!)) scope = a
  else if (withinDnsName(b.target!, a.target!)) scope = b
  else return null
  return { ...scope, types, actions }
}
export async function dnsAccess(
  user: User,
  project: string,
  db: Pick<PoolClient, 'query'> = pool,
) {
  const access = await projectAccess(user, project, db)
  const memberRules = access.can_manage_access
    ? null
    : (
        await db.query<{ rule: DnsGrant }>(
          'SELECT rule FROM dns_member_grants WHERE user_id=$1 AND project_slug=$2',
          [user.id, project],
        )
      ).rows.map((r) => r.rule)
  return { admin: access.can_manage_access, memberRules }
}
