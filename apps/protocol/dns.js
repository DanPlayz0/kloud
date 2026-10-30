import { z } from 'zod'

// Shared by the API validator and the typed form renderer. Numbers describe
// unsigned integer limits; strings describe text fields.
export const dnsFields = {
  A: { content: 'IPv4 address' },
  AAAA: { content: 'IPv6 address' },
  CNAME: { content: 'Target' },
  TXT: { content: 'Text' },
  NS: { content: 'Nameserver' },
  PTR: { content: 'Target' },
  MX: { content: 'Mail server', priority: 65535 },
  CAA: { flags: 255, tag: 'Tag', value: 'Value' },
  CERT: {
    type: 65535,
    key_tag: 65535,
    algorithm: 255,
    certificate: 'Certificate',
  },
  DNSKEY: {
    flags: 65535,
    protocol: 255,
    algorithm: 255,
    public_key: 'Public key',
  },
  DS: { key_tag: 65535, algorithm: 255, digest_type: 255, digest: 'Digest' },
  HTTPS: { priority: 65535, target: 'Target', value: 'Parameters' },
  LOC: {
    lat_degrees: 90,
    lat_minutes: 59,
    lat_seconds: 59.999,
    lat_direction: 'N/S',
    long_degrees: 180,
    long_minutes: 59,
    long_seconds: 59.999,
    long_direction: 'E/W',
    altitude: 'Altitude',
    size: 'Size',
    precision_horz: 'Horizontal precision',
    precision_vert: 'Vertical precision',
  },
  NAPTR: {
    order: 65535,
    preference: 65535,
    flags: 'Flags',
    service: 'Service',
    regex: 'Expression',
    replacement: 'Replacement',
  },
  OPENPGPKEY: { content: 'Public key' },
  SMIMEA: {
    usage: 255,
    selector: 255,
    matching_type: 255,
    certificate: 'Certificate',
  },
  SRV: { priority: 65535, weight: 65535, port: 65535, target: 'Target' },
  SSHFP: { algorithm: 255, type: 255, fingerprint: 'Fingerprint' },
  SVCB: { priority: 65535, target: 'Target', value: 'Parameters' },
  TLSA: {
    usage: 255,
    selector: 255,
    matching_type: 255,
    certificate: 'Certificate',
  },
  URI: { priority: 65535, weight: 65535, target: 'Target' },
}
export const dnsTypes = Object.keys(dnsFields)
export const dnsActions = ['read', 'create', 'update', 'delete']
export const dnsRuleSchema = z
  .object({
    kind: z.enum(['zone', 'name', 'subtree', 'record']),
    target: z.string().min(1).max(255).nullable().default(null),
    types: z.array(z.enum(dnsTypes)).min(1).max(dnsTypes.length),
    actions: z.array(z.enum(dnsActions)).min(1).max(4),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.kind === 'zone') !== (r.target === null))
      ctx.addIssue({
        code: 'custom',
        message: 'Scope requires a target except for whole zones',
      })
    if (r.kind === 'record' && r.actions.includes('create'))
      ctx.addIssue({
        code: 'custom',
        message: 'Record IDs cannot grant creation',
      })
  })
export const dnsMemberGrantSchema = dnsRuleSchema.safeExtend({
  zone_id: z.string().uuid(),
})
export const dnsGrantsSchema = z.array(dnsMemberGrantSchema).max(200)
export const dnsRecordSchema = z
  .discriminatedUnion(
    'type',
    dnsTypes.map((type) => {
      const fields = Object.fromEntries(
        Object.entries(dnsFields[type]).map(([key, spec]) => {
          let schema =
            typeof spec === 'number'
              ? z.number().min(0).max(spec)
              : z.string().max(65535)
          if (typeof spec === 'number' && Number.isInteger(spec))
            schema = schema.int()
          if (type === 'A' && key === 'content') schema = z.ipv4()
          if (type === 'AAAA' && key === 'content') schema = z.ipv6()
          if (key === 'lat_direction') schema = z.enum(['N', 'S'])
          if (key === 'long_direction') schema = z.enum(['E', 'W'])
          if (
            type === 'LOC' &&
            ['altitude', 'size', 'precision_horz', 'precision_vert'].includes(
              key,
            )
          )
            schema = z
              .number()
              .min(key === 'altitude' ? -100000 : 0)
              .max(key === 'altitude' ? 42849672.95 : 90000000)
          return [key, schema]
        }),
      )
      const simple = Object.hasOwn(fields, 'content')
      return z
        .object({
          type: z.literal(type),
          name: z.string().min(1).max(255),
          ttl: z.union([z.literal(1), z.number().int().min(30).max(86400)]),
          ...(simple ? fields : { data: z.object(fields).strict() }),
          proxied: z.boolean().optional(),
          comment: z.string().max(500).optional(),
          tags: z.array(z.string().max(256)).max(200).optional(),
          settings: z
            .object({
              ipv4_only: z.boolean().optional(),
              ipv6_only: z.boolean().optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
    }),
  )
  .superRefine((record, ctx) => {
    if (record.proxied && !['A', 'AAAA', 'CNAME'].includes(record.type))
      ctx.addIssue({
        code: 'custom',
        message: 'This record type cannot be proxied',
      })
    if (record.settings?.ipv4_only && record.settings?.ipv6_only)
      ctx.addIssue({
        code: 'custom',
        message: 'Choose only one proxy address family',
      })
  })
