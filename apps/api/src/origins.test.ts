import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  browserOrigin,
  originConfiguration,
  parseOrigin,
  publicOrigin,
  relyingParty,
  secureCookies,
} from './security.js'

test('origin allowlists contain only exact configured HTTP(S) addresses', () => {
  const origins = originConfiguration(
    'https://kloud.example.com',
    ' http://localhost:8080, http://203.0.113.10:8080, http://[::1]:8080,https://kloud.example.com ',
  )
  assert.equal(origins.size, 4)
  for (const input of [
    'null',
    '*',
    'https://*.example.com',
    'https://example.com/path',
    'https://example.com/',
    'https://example.com?query',
    'https://user:secret@example.com',
    'file:///tmp',
    'https://example.com:443',
    'https://example.com#fragment',
  ])
    assert.throws(() => parseOrigin(input), input)
  assert.equal(origins.has('https://evil.example.com'), false)
  assert.equal(origins.has('http://localhost:3000'), false)
})
test('passkeys select RP per hostname and retain a configured parent RP', () => {
  assert.equal(
    relyingParty('http://localhost:8080', 'example.com'),
    'localhost',
  )
  assert.equal(
    relyingParty('https://kloud.example.com', 'example.com'),
    'example.com',
  )
  assert.equal(
    relyingParty('https://other.example.net', 'example.com'),
    'other.example.net',
  )
  for (const origin of [
    'http://203.0.113.10:8080',
    'https://203.0.113.10',
    'http://[::1]:8080',
    'http://kloud.example.com',
  ])
    assert.equal(relyingParty(origin), null)
})
test('cookie transport uses a configured browser origin and ignores forwarded headers', async () => {
  const app = new Hono().get('/', (c) =>
    c.json({ origin: browserOrigin(c), secure: secureCookies(c) }),
  )
  const response = await app.request('http://internal/', {
    headers: {
      origin: publicOrigin,
      'x-forwarded-proto': 'https',
      forwarded: 'proto=https;host=attacker.example',
    },
  })
  assert.deepEqual(await response.json(), {
    origin: publicOrigin,
    secure: publicOrigin.startsWith('https:'),
  })
  const forged = await app.request('http://internal/', {
    headers: {
      origin: 'https://attacker.example',
      'x-forwarded-proto': 'https',
    },
  })
  assert.deepEqual(await forged.json(), {
    origin: publicOrigin,
    secure: publicOrigin.startsWith('https:'),
  })
  const hint = await app.request('http://internal/', {
    headers: { 'x-kloud-origin': publicOrigin },
  })
  assert.equal((await hint.json()).origin, publicOrigin)
})
