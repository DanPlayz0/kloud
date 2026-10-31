import { z } from 'zod'

const label = z.string().min(1).max(256)
const integer = z.number().int().nonnegative()
export const pm2WorkerSchema = z
  .object({
    id: integer,
    name: label,
    namespace: label,
    status: z.enum([
      'online',
      'stopping',
      'stopped',
      'launching',
      'errored',
      'one-launch-status',
      'waiting restart',
      'unknown',
    ]),
    mode: z.enum(['fork_mode', 'cluster_mode', 'unknown']),
    pid: integer,
    uptime: integer.nullable(),
    restarts: integer,
    cpu: z.number().finite().nonnegative().nullable(),
    memory: integer.nullable(),
  })
  .strict()
export const pm2SnapshotSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('pm2-snapshot'),
    host: label,
    available: z.boolean(),
    workers: z.array(pm2WorkerSchema).max(5000),
  })
  .strict()
  .refine(
    (s) => new Set(s.workers.map((w) => w.id)).size === s.workers.length,
    'Duplicate PM2 IDs',
  )
export const pm2Actions = ['start', 'stop', 'restart', 'reload', 'delete']
export const pm2OperationSchema = z
  .object({ action: z.enum(pm2Actions) })
  .strict()
export const pm2LogQuerySchema = z
  .object({
    stream: z.enum(['stdout', 'stderr']).default('stdout'),
    worker: z.coerce.number().int().nonnegative().optional(),
  })
  .strict()
export const pm2RequestSchema = z
  .object({
    kind: z.literal('pm2'),
    name: label,
    namespace: label,
    action: z.enum([...pm2Actions, 'logs']),
    stream: z.enum(['stdout', 'stderr']).optional(),
    worker: integer.optional(),
  })
  .strict()
export const pm2ResultSchema = z
  .object({
    results: z
      .array(z.object({ id: integer, ok: z.boolean() }).strict())
      .max(5000),
  })
  .strict()
export const pm2LogsSchema = z
  .object({ output: z.string().max(48000), unavailable: z.boolean() })
  .strict()
export const pm2GrantSchema = z
  .object({
    capability: z.enum(['view', 'logs', 'manage', 'delete']),
    app: z.string().uuid().nullable(),
  })
  .strict()
export const pm2GrantsSchema = z.array(pm2GrantSchema).max(200)
export function normalizePm2Grants(grants) {
  const values = new Map()
  for (const g of grants) {
    values.set(`${g.capability}:${g.app}`, g)
    const view = { ...g, capability: 'view' }
    values.set(`${view.capability}:${view.app}`, view)
  }
  return [...values.values()]
}
