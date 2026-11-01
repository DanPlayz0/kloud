import { z } from 'zod'
export type FactorMethod = 'email' | 'totp' | 'passkey'
export type AuthenticationResult =
  | { status: 'authenticated' }
  | {
      status: 'second_factor_required'
      methods: FactorMethod[]
      emailAvailable: boolean
      totpAvailable: boolean
      passkeyAvailable?: boolean
    }
export interface SecurityStatus {
  methods: FactorMethod[]
  email: string | null
  emailAvailable: boolean
  totpAvailable: boolean
  passkeyAvailable?: boolean
  passkeys: { id: string; name: string; rpId?: string }[]
  recoveryCodesRemaining: number
}
export const factorMethodSchema: z.ZodType<FactorMethod>
export const credentialsSchema: z.ZodType<{
  username: string
  password: string
}>
export const setupSchema: typeof credentialsSchema
export const enrollmentSchema: z.ZodType<{ token: string; password: string }>
export const factorRequestSchema: z.ZodObject<{
  method: z.ZodEnum<{ email: 'email'; totp: 'totp'; passkey: 'passkey' }>
}>
export const factorVerificationSchema: z.ZodType<{
  method: 'email' | 'totp' | 'recovery'
  code: string
}>
export const authenticationResultSchema: z.ZodType<AuthenticationResult>
export const securityStatusSchema: z.ZodType<SecurityStatus>
