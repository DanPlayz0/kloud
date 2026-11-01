import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import nodemailer from 'nodemailer'
import * as OTPAuth from 'otpauth'
import type { PoolClient } from 'pg'
import { digest, token } from './security.js'

export function authKey() {
  const value = process.env.AUTH_ENCRYPTION_KEY
  if (!value || !/^[a-f\d]{64}$/i.test(value))
    throw new HTTPException(503, {
      message:
        'Configure AUTH_ENCRYPTION_KEY as 64 hexadecimal characters before using TOTP.',
    })
  return Buffer.from(value, 'hex')
}
export function totpAvailable() {
  return /^[a-f\d]{64}$/i.test(process.env.AUTH_ENCRYPTION_KEY ?? '')
}
export function encryptSecret(secret: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', authKey(), iv)
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), body]
    .map((v) => v.toString('base64url'))
    .join('.')
}
export function decryptSecret(secret: string) {
  const [iv, tag, body] = secret
    .split('.')
    .map((v) => Buffer.from(v, 'base64url'))
  const cipher = createDecipheriv('aes-256-gcm', authKey(), iv!)
  cipher.setAuthTag(tag!)
  return Buffer.concat([cipher.update(body!), cipher.final()]).toString('utf8')
}
export function newTotp(username: string) {
  return new OTPAuth.TOTP({
    issuer: 'Kloud',
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  })
}
export function totpStep(
  secret: string,
  code: string,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  })
  const delta = totp.validate({ token: code, timestamp: now, window: 1 })
  return delta === null ? null : Math.floor(now / 30000) + delta
}
export const emailCode = () => randomInt(1000000).toString().padStart(6, '0')
export const codeHash = (code: string, pending: string) =>
  createHmac('sha256', pending).update(code).digest('hex')
export function matchesCode(code: string, pending: string, expected: string) {
  const actual = Buffer.from(codeHash(code, pending), 'hex'),
    stored = Buffer.from(expected, 'hex')
  return actual.length === stored.length && timingSafeEqual(actual, stored)
}
export function smtpAvailable() {
  return (
    !!process.env.SMTP_HOST &&
    !!process.env.SMTP_FROM &&
    ['implicit', 'starttls', 'plain'].includes(
      process.env.SMTP_TLS ?? 'starttls',
    ) &&
    !(
      process.env.NODE_ENV === 'production' && process.env.SMTP_TLS === 'plain'
    ) &&
    !!process.env.SMTP_USER === !!process.env.SMTP_PASSWORD &&
    /^\d+$/.test(process.env.SMTP_PORT ?? '587') &&
    Number(process.env.SMTP_PORT ?? 587) > 0 &&
    Number(process.env.SMTP_PORT ?? 587) <= 65535
  )
}
export async function sendEmailCode(to: string, code: string) {
  if (!smtpAvailable())
    throw new HTTPException(503, {
      message:
        'Email verification is unavailable. Configure SMTP or use another factor or recovery code.',
    })
  const tls = process.env.SMTP_TLS ?? 'starttls'
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? (tls === 'implicit' ? 465 : 587)),
    secure: tls === 'implicit',
    requireTLS: tls === 'starttls',
    ignoreTLS: tls === 'plain',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject: 'Your Kloud verification code',
      text: `Your Kloud verification code is ${code}. It expires in 5 minutes. If you did not request this code, ignore this email.`,
    })
  } catch {
    throw new HTTPException(503, {
      message:
        'Could not deliver your code. Try again later or use another factor or recovery code.',
    })
  } finally {
    transport.close()
  }
}
export async function recoveryCodes(db: PoolClient, user: string) {
  const codes = Array.from({ length: 10 }, () => token().slice(0, 20))
  await db.query('DELETE FROM recovery_codes WHERE user_id=$1', [user])
  for (const code of codes)
    await db.query('INSERT INTO recovery_codes(user_id,hash) VALUES($1,$2)', [
      user,
      digest(code),
    ])
  return codes
}
// Caller holds the user row lock; all reset paths use the same lock order.
export async function clearFactors(db: PoolClient, user: string) {
  await db.query(
    'UPDATE users SET email=NULL,email_2fa=false,totp_secret=NULL,totp_last_step=NULL,passkey_2fa=false,security_version=security_version+1 WHERE id=$1',
    [user],
  )
  for (const table of [
    'auth_pending',
    'recovery_codes',
    'auth_email_limits',
    'sessions',
    'passkeys',
    'challenges',
    'invitations',
  ])
    await db.query(`DELETE FROM ${table} WHERE user_id=$1`, [user])
}
