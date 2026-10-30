import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, token, digest } from './security.js'
import { snapshotSchema } from '@dedi-dash/protocol'
test('passwords are salted and credentials compare correctly', async () => {
  const a = await hashPassword('correct horse battery staple'),
    b = await hashPassword('correct horse battery staple')
  assert.notEqual(a, b)
  assert.equal(await verifyPassword('correct horse battery staple', a), true)
  assert.equal(await verifyPassword('wrong', a), false)
  assert.notEqual(digest(token()), digest(token()))
})
test('snapshot protocol rejects unknown versions, secrets, duplicate IDs and invalid metrics', () => {
  const container = {
    id: 'a'.repeat(64),
    name: 'worker',
    state: 'running',
    project: 'miki',
    application: 'imgen',
    cpu: null,
    memory: null,
    memoryLimit: null,
  }
  const valid = {
    version: 1,
    type: 'snapshot',
    host: 'host',
    containers: [container],
  }
  assert.equal(snapshotSchema.safeParse(valid).success, true)
  for (const snapshot of [
    { ...valid, version: 2 },
    { ...valid, env: { PASSWORD: 'secret' } },
    { ...valid, containers: [container, container] },
    { ...valid, containers: [{ ...container, cpu: -1 }] },
  ])
    assert.equal(snapshotSchema.safeParse(snapshot).success, false)
})
