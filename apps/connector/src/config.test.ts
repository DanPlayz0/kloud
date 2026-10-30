import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readConfig } from './config.js'

test('defaults connect to the local API', () => {
  const config = readConfig({})
  assert.equal(
    new URL('health', config.apiUrl).href,
    'http://localhost:3000/health',
  )
  assert.equal(config.pollIntervalMs, 5_000)
  assert.equal(config.healthPort, 3001)
})

test('API base paths are retained', () => {
  const config = readConfig({ API_URL: 'https://dashboard.example.com/api' })
  assert.equal(
    new URL('health', config.apiUrl).href,
    'https://dashboard.example.com/api/health',
  )
})

test('invalid URLs, intervals, and ports fail at startup', () => {
  for (const env of [
    { API_URL: 'file:///tmp/api' },
    { API_URL: 'https://user:secret@example.com' },
    { API_URL: 'https://example.com?token=secret' },
    { POLL_INTERVAL_MS: '0' },
    { POLL_INTERVAL_MS: 'NaN' },
    { POLL_INTERVAL_MS: '2147483648' },
    { HEALTH_PORT: '65536' },
  ]) {
    assert.throws(() => readConfig(env))
  }
})
