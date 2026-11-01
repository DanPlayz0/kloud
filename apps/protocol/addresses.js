import { z } from 'zod'

export function isPublicIPv4(value) {
  if (!z.ipv4().safeParse(value).success) return false
  const [a, b, c] = value.split('.').map(Number)
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  )
}
export function isPublicIPv6(value) {
  if (!z.ipv6().safeParse(value).success || value.includes('.')) return false
  const parts = value.toLowerCase().split('::')
  const before = parts[0] ? parts[0].split(':') : []
  const after = parts[1] ? parts[1].split(':') : []
  const words =
    parts.length === 2
      ? [
          ...before,
          ...Array(8 - before.length - after.length).fill('0'),
          ...after,
        ]
      : before
  const a = parseInt(words[0], 16),
    b = parseInt(words[1], 16)
  // Conservative global-unicast validation; exclude transition and documentation ranges.
  return (
    a >= 0x2000 &&
    a <= 0x3fff &&
    a !== 0x2002 &&
    !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) &&
    !(a === 0x3fff && b < 0x1000)
  )
}
const family = (validator) =>
  z
    .object({
      address: z
        .string()
        .refine(validator, 'Expected a globally routable address')
        .nullable(),
      last_success: z.iso.datetime().nullable(),
      checked_at: z.iso.datetime().nullable(),
      status: z.enum(['unknown', 'ready', 'error']),
      error: z.string().max(256).nullable(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (
        value.status === 'ready' &&
        (!value.address || !value.last_success || !value.checked_at)
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Ready public addresses require a value and successful detection timestamps',
        })
    })
export const publicAddressesSchema = z
  .object({
    version: z.literal(1),
    ipv4: family(isPublicIPv4),
    ipv6: family(isPublicIPv6),
  })
  .strict()
