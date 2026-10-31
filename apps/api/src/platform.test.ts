import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  platformConfigSchema,
  runtimeSchema,
  domainSchema,
} from '@dedi-dash/protocol/platform'
import { seal, unseal, redact } from './platform-secrets.js'

test('service secrets use randomized authenticated encryption and fail closed', () => {
  process.env.PLATFORM_ENCRYPTION_KEY = 'ab'.repeat(32)
  const config = {
    runtime: { environment: { TOKEN: 'super-secret' } },
    source: { registry: { password: 'registry-secret' } },
  }
  const first = seal(config),
    second = seal(config)
  assert.notEqual(first, second)
  assert.ok(!first.includes('super-secret'))
  assert.deepEqual(unseal(first), config)
  assert.equal(
    redact('super-secret registry-secret', config),
    '[redacted] [redacted]',
  )
  assert.throws(() => unseal(first.slice(0, -4) + 'AAAA'))
  delete process.env.PLATFORM_ENCRYPTION_KEY
  assert.throws(() => seal(config))
})
test('source and routing schemas reject credential URLs, injected directives and invalid runtime configuration', () => {
  const base = {
    connector_id: '11111111-1111-4111-8111-111111111111',
    runtime: runtimeSchema.parse({}),
  }
  assert.ok(
    platformConfigSchema.safeParse({
      ...base,
      source: { type: 'image', image: 'ghcr.io/owner/app:latest' },
    }).success,
  )
  for (const image of [
    '--privileged',
    'https://user:password@registry/image',
    'image; rm -rf /',
  ])
    assert.ok(
      !platformConfigSchema.safeParse({
        ...base,
        source: { type: 'image', image },
      }).success,
    )
  for (const hostname of [
    '*.example.com',
    'example.com;',
    'example.com\ninclude /etc/passwd;',
  ])
    assert.ok(
      !domainSchema.safeParse({
        hostname,
        container: 'web',
        network: 'web',
        port: 80,
      }).success,
    )
  assert.ok(
    !runtimeSchema.safeParse({ ports: [{ host: 70000, container: 80 }] })
      .success,
  )
})
