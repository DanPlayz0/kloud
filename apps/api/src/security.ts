import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from 'node:crypto'
import { promisify } from 'node:util'
import { isIP } from 'node:net'
import type { Context } from 'hono'
const scrypt = promisify(scryptCallback)
export const token = () => randomBytes(32).toString('base64url')
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')
export async function hashPassword(value: string) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${((await scrypt(value, salt, 64)) as Buffer).toString('hex')}`
}
export async function verifyPassword(value: string, hash: string) {
  const [salt, encoded] = hash.split(':')
  if (!salt || !encoded) return false
  const actual = (await scrypt(value, salt, 64)) as Buffer
  const expected = Buffer.from(encoded, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
export function parseOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(
      'Origins must be exact HTTP(S) origins without paths, wildcards, or credentials',
    )
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.hostname.includes('*')
  )
    throw new Error(
      'Origins must be exact HTTP(S) origins without paths, wildcards, or credentials',
    )
  return value
}
export function originConfiguration(primary: string, extra = '') {
  return new Set([
    parseOrigin(primary),
    ...extra
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map(parseOrigin),
  ])
}
export const publicOrigin = parseOrigin(
  process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173',
)
export const allowedOrigins = originConfiguration(
  publicOrigin,
  process.env.ALLOWED_ORIGINS,
)
export const isAllowedOrigin = (origin: string | undefined): origin is string =>
  !!origin && allowedOrigins.has(origin)
// Only an explicitly configured browser origin determines cookie security; forwarded
// headers and Host can be supplied by an untrusted client or changed by a proxy.
export function browserOrigin(c: Context) {
  const origin = c.req.header('origin')
  if (isAllowedOrigin(origin)) return origin
  // Same-origin GETs omit Origin. The UI supplies its origin for read-only
  // capability reporting; this header never authorizes a mutation.
  const hint = ['GET', 'HEAD'].includes(c.req.method)
    ? c.req.header('x-kloud-origin')
    : undefined
  return isAllowedOrigin(hint) ? hint : publicOrigin
}
export const secureCookies = (c: Context) =>
  browserOrigin(c).startsWith('https:')
export const rpID = process.env.WEBAUTHN_RP_ID || new URL(publicOrigin).hostname
if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_ORIGIN)
  throw new Error(
    'Production requires PUBLIC_ORIGIN; configure additional access addresses in ALLOWED_ORIGINS',
  )
export function relyingParty(origin: string, preferred = rpID): string | null {
  const url = new URL(origin),
    host = url.hostname
  if (
    isIP(host.replace(/^\[|\]$/g, '')) ||
    (url.protocol !== 'https:' &&
      host !== 'localhost' &&
      !host.endsWith('.localhost'))
  )
    return null
  return host === preferred || host.endsWith(`.${preferred}`) ? preferred : host
}
