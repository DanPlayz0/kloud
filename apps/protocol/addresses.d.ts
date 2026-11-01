import { z } from 'zod'
export interface AddressDetection {
  address: string | null
  last_success: string | null
  checked_at: string | null
  status: 'unknown' | 'ready' | 'error'
  error: string | null
}
export interface PublicAddresses {
  version: 1
  ipv4: AddressDetection
  ipv6: AddressDetection
}
export function isPublicIPv4(value: string): boolean
export function isPublicIPv6(value: string): boolean
export const publicAddressesSchema: z.ZodType<PublicAddresses>
