import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app } from './app.js'
import { pool } from './db.js'
import { publicOrigin } from './security.js'

test('health endpoint responds with a healthy status', async () => {
  const response = await app.request('/health')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })
})

test('OpenAPI document requires authentication', async () => {
  const response = await app.request('/openapi.json')
  assert.equal(response.status, 401)
})

test('dashboard endpoints require authentication', async () => {
  const response = await app.request('/missing')
  assert.equal(response.status, 401)
})
test('mutations reject foreign origins before accessing storage', async () => {
  const response = await app.request('/auth/password', {
    method: 'POST',
    headers: {
      origin: 'https://untrusted.example',
      'content-type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(response.status, 403)
})

test('setup coalesces database checks and permanently caches an existing account', async (t) => {
  let populated = false
  let fail = true
  const query = t.mock.method(pool, 'query', async () => {
    if (fail) throw new Error('Database unavailable')
    // Keep the query pending while concurrent requests arrive.
    await new Promise((resolve) => setImmediate(resolve))
    return { rows: [{ populated }] }
  })
  assert.equal((await app.request('/auth/setup')).status, 503)
  fail = false
  assert.deepEqual(await (await app.request('/auth/setup')).json(), {
    required: true,
  })
  assert.deepEqual(await (await app.request('/auth/setup')).json(), {
    required: true,
  })
  assert.equal(query.mock.callCount(), 3)
  populated = true
  const results = await Promise.all(
    Array.from({ length: 20 }, () => app.request('/auth/setup')),
  )
  for (const response of results)
    assert.deepEqual(await response.json(), { required: false })
  assert.equal(query.mock.callCount(), 4)
  // Later requests must work without storage, including setup POSTs.
  fail = true
  assert.deepEqual(await (await app.request('/auth/setup')).json(), {
    required: false,
  })
  for (const path of ['/auth/setup/options', '/auth/setup/verify']) {
    const response = await app.request(path, {
      method: 'POST',
      headers: { origin: publicOrigin, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 409)
  }
  assert.equal(query.mock.callCount(), 4)
})
