import { z } from 'zod'

export const connectorStatusSchema = z
  .object({
    type: z.literal('connector-status'),
    version: z.string().min(1).max(100),
    revision: z.string().regex(/^(?:[a-f0-9]{7,64}|unknown)$/),
    started_at: z.iso.datetime(),
    updater: z
      .object({
        configured: z.boolean(),
        enabled: z.boolean(),
        state: z.enum(['idle', 'checking', 'failed']),
        checked_at: z.iso.datetime().nullable(),
        completed_at: z.iso.datetime().nullable(),
        error: z.string().max(200).nullable(),
      })
      .strict(),
  })
  .strict()
export const connectorUpdateSchema = z.discriminatedUnion('action', [
  z
    .object({ kind: z.literal('connector-update'), action: z.literal('check') })
    .strict(),
  z
    .object({
      kind: z.literal('connector-update'),
      action: z.literal('configure'),
      enabled: z.boolean(),
    })
    .strict(),
])
