import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  pm2GrantsSchema,
  normalizePm2Grants,
  pm2RequestSchema,
  pm2LogQuerySchema,
} from '@kloud/protocol/pm2'
import { memberBody } from './project-permissions.js'

test('PM2 grant dependencies are explicit, deduplicated and independent from Docker', () => {
  const app = randomUUID()
  const grants = pm2GrantsSchema.parse([
    { capability: 'manage', app },
    { capability: 'delete', app },
  ])
  assert.deepEqual(normalizePm2Grants(grants), [
    { capability: 'manage', app },
    { capability: 'view', app },
    { capability: 'delete', app },
  ])
  assert.equal(
    normalizePm2Grants(grants).some((g) => g.capability === 'logs'),
    false,
  )
  assert.equal(
    memberBody.parse({ role: 'member', grants: [] }).pm2_grants,
    undefined,
  )
  assert.equal(
    pm2GrantsSchema.safeParse([{ capability: 'terminal', app }]).success,
    false,
  )
})
test('PM2 operations cannot accept arbitrary command, path, or script fields', () => {
  const request = {
    kind: 'pm2',
    name: 'web',
    namespace: 'default',
    action: 'restart',
  }
  assert.ok(pm2RequestSchema.safeParse(request).success)
  assert.equal(
    pm2RequestSchema.safeParse({ ...request, script: '/tmp/a.js' }).success,
    false,
  )
  assert.equal(
    pm2RequestSchema.safeParse({ ...request, action: 'save' }).success,
    false,
  )
  assert.deepEqual(pm2LogQuerySchema.parse({ worker: '0' }), {
    stream: 'combined',
    worker: 0,
  })
})
