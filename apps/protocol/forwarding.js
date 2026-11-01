import { z } from 'zod'
export function addressNumber(input) {
  let value = input
  if (value.startsWith('::ffff:') && z.ipv4().safeParse(value.slice(7)).success)
    value = value.slice(7)
  if (z.ipv4().safeParse(value).success)
    return {
      bits: 32,
      value: value.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n),
    }
  if (!z.ipv6().safeParse(value).success || value.includes('.'))
    throw new Error('Invalid IP address')
  const [left, right] = value.split('::')
  const before = left ? left.split(':') : [],
    after = right ? right.split(':') : []
  const words = value.includes('::')
    ? [
        ...before,
        ...Array(8 - before.length - after.length).fill('0'),
        ...after,
      ]
    : before
  return {
    bits: 128,
    value: words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n),
  }
}
export function validCidr(input) {
  try {
    const pieces = input.split('/')
    if (pieces.length !== 2 || !/^\d+$/.test(pieces[1])) return false
    const address = addressNumber(pieces[0]),
      prefix = Number(pieces[1])
    return prefix >= 0 && prefix <= address.bits
  } catch {
    return false
  }
}
export function sourceAllowed(source, cidrs) {
  try {
    const address = addressNumber(source)
    if (!cidrs.length) return true
    if (cidrs.some((cidr) => !validCidr(cidr))) return false
    return cidrs.some((cidr) => {
      if (!validCidr(cidr)) return false
      const [base, raw] = cidr.split('/'),
        network = addressNumber(base),
        prefix = Number(raw)
      if (address.bits !== network.bits) return false
      const shift = BigInt(address.bits - prefix)
      return address.value >> shift === network.value >> shift
    })
  } catch {
    return false
  }
}
export const protectedPorts = [22, 80, 443, 2375, 2376, 3000, 3001, 5173, 51820]
export const listenerSchema = z
  .object({
    protocol: z.enum(['tcp', 'udp']),
    bind_address: z.union([z.ipv4(), z.ipv6()]),
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .refine(
        (value) => !protectedPorts.includes(value),
        'This port is reserved for host management, VPN or the HTTP proxy',
      ),
    container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/),
    compose_service: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
      .optional(),
    network: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
    target_port: z.number().int().min(1).max(65535),
    sources: z
      .array(
        z.string().max(64).refine(validCidr, 'Enter a valid IPv4 or IPv6 CIDR'),
      )
      .max(100),
    enabled: z.boolean().default(false),
    application_protocol: z.enum(['generic', 'postgresql']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.enabled &&
      (value.application_protocol === 'postgresql' ||
        value.target_port === 5432)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Public PostgreSQL requires verified native TLS and certificate renewal. This listener cannot be enabled until those prerequisites are available.',
      })
  })
