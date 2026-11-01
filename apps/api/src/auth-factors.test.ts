import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as OTPAuth from 'otpauth'
import {
  codeHash,
  decryptSecret,
  emailCode,
  encryptSecret,
  matchesCode,
  smtpAvailable,
  totpStep,
} from './auth-factors.js'
function env(name: string, value: string) {
  process.env[name] = value
}

test('TOTP matches RFC 6238 SHA-1 vectors, tolerates one step and rejects distant codes', () => {
  const secret = OTPAuth.Secret.fromUTF8('12345678901234567890').base32
  for (const [seconds, code] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ] as const)
    assert.equal(
      totpStep(secret, code, seconds * 1000),
      Math.floor(seconds / 30),
    )
  assert.equal(totpStep(secret, '287082', 89000), 1)
  assert.equal(totpStep(secret, '287082', 119000), null)
  assert.equal(totpStep(secret, '12345', 59000), null)
})
test('TOTP secrets use randomized authenticated encryption and fail with the wrong key', (t) => {
  const original = { ...process.env }
  t.after(() => {
    process.env = original
  })
  env('AUTH_ENCRYPTION_KEY', 'ab'.repeat(32))
  const encrypted = encryptSecret('secret')
  assert.notEqual(encrypted, encryptSecret('secret'))
  assert.equal(decryptSecret(encrypted), 'secret')
  env('AUTH_ENCRYPTION_KEY', 'cd'.repeat(32))
  assert.throws(() => decryptSecret(encrypted))
})
test('email codes use keyed hashes bound to the raw pending token', () => {
  const code = emailCode(),
    hash = codeHash(code, 'pending')
  assert.match(code, /^\d{6}$/)
  assert.ok(matchesCode(code, 'pending', hash))
  assert.equal(matchesCode(code, 'other-pending', hash), false)
  assert.equal(matchesCode(code, 'pending', ''), false)
})
test('email availability requires a complete safe SMTP configuration', (t) => {
  const original = { ...process.env }
  t.after(() => {
    process.env = original
  })
  env('SMTP_HOST', '')
  assert.equal(smtpAvailable(), false)
  env('SMTP_HOST', 'localhost')
  env('SMTP_FROM', 'test@example.com')
  env('SMTP_USER', '')
  env('SMTP_PASSWORD', '')
  env('SMTP_TLS', 'plain')
  env('NODE_ENV', 'test')
  assert.equal(smtpAvailable(), true)
  env('NODE_ENV', 'production')
  assert.equal(smtpAvailable(), false)
})
