import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from 'node:crypto'
import { promisify } from 'node:util'
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
export const publicOrigin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173'
export const rpID = process.env.WEBAUTHN_RP_ID ?? new URL(publicOrigin).hostname
const originURL = new URL(publicOrigin)
if (
  !['http:', 'https:'].includes(originURL.protocol) ||
  originURL.origin !== publicOrigin ||
  originURL.username ||
  originURL.password
)
  throw new Error(
    'PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials',
  )
if (rpID !== originURL.hostname && !originURL.hostname.endsWith(`.${rpID}`))
  throw new Error(
    'WEBAUTHN_RP_ID must match the public hostname or a parent domain',
  )
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.PUBLIC_ORIGIN ||
    !process.env.WEBAUTHN_RP_ID ||
    (!publicOrigin.startsWith('https://') &&
      new URL(publicOrigin).hostname !== 'localhost'))
) {
  throw new Error('Production requires HTTPS PUBLIC_ORIGIN and WEBAUTHN_RP_ID')
}
