import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grantSchema, normalizeGrants, hasServer } from './permissions.js'

test('grant validation rejects malformed and over-broad targets', () => {
  for (const grant of [
    { capability: 'view', kind: 'all', target: 'hidden' },
    { capability: 'view', kind: 'name', target: 'web' },
    {
      capability: 'view',
      kind: 'id',
      connector_id: '00000000-0000-4000-8000-000000000001',
      target: 'short',
    },
    { capability: 'execute', kind: 'all' },
  ])
    assert.equal(grantSchema.safeParse(grant).success, false)
})
test('operational grants include View once and retain their precise scope', () => {
  const grant = grantSchema.parse({
    capability: 'logs',
    kind: 'name',
    connector_id: '00000000-0000-4000-8000-000000000001',
    target: '/web',
  })
  const normalized = normalizeGrants([grant, grant])
  assert.deepEqual(
    normalized.map((g) => g.capability),
    ['logs', 'view'],
  )
  assert.equal(normalized[1]!.target, '/web')
  assert.equal(
    hasServer(
      { id: 'u', username: 'u', admin: false, capabilities: ['users.manage'] },
      'projects.manage',
    ),
    false,
  )
})
