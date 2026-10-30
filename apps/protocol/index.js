import { z } from 'zod'
export const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100)
export const containerSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(256),
    state: z.enum([
      'created',
      'running',
      'paused',
      'restarting',
      'removing',
      'exited',
      'dead',
    ]),
    project: slug.nullable(),
    application: slug.nullable(),
    cpu: z.number().finite().nonnegative().nullable(),
    memory: z.number().int().nonnegative().nullable(),
    memoryLimit: z.number().int().nonnegative().nullable(),
  })
  .strict()
export const snapshotSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('snapshot'),
    host: z.string().min(1).max(256),
    containers: z.array(containerSchema).max(5000),
  })
  .strict()
  .refine(
    (s) => new Set(s.containers.map((c) => c.id)).size === s.containers.length,
    'Duplicate containers',
  )
