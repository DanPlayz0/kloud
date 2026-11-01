import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loginDestination } from '../src/navigation.ts'
test('login redirects reject external URLs and normalization bypasses', () => {
  for (const value of [
    undefined,
    'https://example.com',
    '//example.com',
    '/\\example.com',
    '/\n/example.com',
    '/\r/example.com',
    '/\t/example.com',
    ' /projects',
  ])
    assert.equal(loginDestination(value), '/')
  assert.equal(
    loginDestination('/projects/your-project-slug/compute/containers'),
    '/projects/your-project-slug/compute/containers',
  )
})
