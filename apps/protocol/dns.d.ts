import { z } from 'zod'
export type DnsAction = 'read' | 'create' | 'update' | 'delete'
export interface DnsRule {
  kind: 'zone' | 'name' | 'subtree' | 'record'
  target: string | null
  types: string[]
  actions: DnsAction[]
}
export interface DnsGrant extends DnsRule {
  zone_id: string
}
export interface DnsRecord {
  type: string
  name: string
  ttl: number
  content?: string
  priority?: number
  data?: Record<string, string | number>
  proxied?: boolean
  comment?: string
  tags?: string[]
  settings?: { ipv4_only?: boolean; ipv6_only?: boolean }
}
export interface DnsLiveRecord extends DnsRecord {
  id: string
  actions?: DnsAction[]
}
export const dnsFields: Record<string, Record<string, string | number>>
export const dnsTypes: string[]
export const dnsActions: DnsAction[]
export const dnsRuleSchema: z.ZodType<DnsRule>
export const dnsMemberGrantSchema: z.ZodType<DnsGrant>
export const dnsGrantsSchema: z.ZodType<DnsGrant[]>
export const dnsRecordSchema: z.ZodType<DnsRecord>
