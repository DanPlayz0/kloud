import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app } from './app.js'

test('health endpoint responds with a healthy status', async () => {
  const response = await app.request('/health')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })
})

test('OpenAPI document exposes the health endpoint and schema', async () => {
  const response = await app.request('/openapi.json')
  assert.equal(response.status, 200)
  const document = await response.json()
  assert.equal(document.openapi, '3.0.0')
  assert.ok(document.paths['/health'].get.responses['200'])
  assert.ok(document.components.schemas.Health)
})

test('unknown endpoints return 404', async () => {
  const response = await app.request('/missing')
  assert.equal(response.status, 404)
})
