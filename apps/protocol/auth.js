import { z } from 'zod'
export const factorMethodSchema = z.enum(['email', 'totp', 'passkey'])
export const credentialsSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(256),
})
export const setupSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.@-]{1,100}$/),
  password: z.string().min(12).max(256),
})
export const enrollmentSchema = z.object({
  token: z.string().min(32).max(100),
  password: z.string().min(12).max(256),
})
export const factorRequestSchema = z.object({ method: factorMethodSchema })
export const factorVerificationSchema = z.object({
  method: z.enum(['email', 'totp', 'recovery']),
  code: z.string().min(1).max(100),
})
export const authenticationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authenticated') }),
  z.object({
    status: z.literal('second_factor_required'),
    methods: z.array(factorMethodSchema),
    emailAvailable: z.boolean(),
    totpAvailable: z.boolean(),
    passkeyAvailable: z.boolean().optional(),
  }),
])
export const securityStatusSchema = z.object({
  methods: z.array(factorMethodSchema),
  email: z.string().nullable(),
  emailAvailable: z.boolean(),
  totpAvailable: z.boolean(),
  passkeyAvailable: z.boolean().optional(),
  passkeys: z.array(
    z.object({ id: z.string(), name: z.string(), rpId: z.string().optional() }),
  ),
  recoveryCodesRemaining: z.number(),
})
