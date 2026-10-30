import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app } from './app.js'

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
