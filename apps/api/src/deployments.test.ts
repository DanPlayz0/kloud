import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { deploymentSchema } from '@dedi-dash/protocol'
import { verifySignature } from './deployments.js'
import { app } from './app.js'

test('GitHub signatures validate exact raw UTF-8 bytes and reject missing, malformed, or changed signatures', () => {
  const body = Buffer.from('{"message":"café"}')
  const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
  assert.equal(verifySignature(body, 'secret', signature), true)
  for (const value of [
    '',
    'sha256=invalid',
    signature.replace('sha256=', 'sha1='),
    signature.toUpperCase(),
  ])
    assert.equal(verifySignature(body, 'secret', value), false)
  assert.equal(verifySignature(body, 'other-secret', signature), false)
  assert.equal(
    verifySignature(Buffer.from('{ "message":"café"}'), 'secret', signature),
    false,
  )
})

test('deployment configuration rejects command options, credentials, and escaping paths', () => {
  const valid = {
    connector_id: '00000000-0000-4000-8000-000000000001',
    container_name: 'web',
    repository: 'owner/repo',
    branch: 'release/main',
    kind: 'dockerfile',
    build_file: 'apps/web/Dockerfile',
    context: '.',
    service: 'web',
    enabled: true,
  }
  assert.deepEqual(deploymentSchema.parse(valid), valid)
  for (const patch of [
    { repository: 'https://token@github.com/owner/repo' },
    { branch: '--upload-pack=bad' },
    { branch: 'main..other' },
    { build_file: '../Dockerfile' },
    { build_file: '/Dockerfile' },
    { context: 'C:/host' },
    { context: 'app/../../host' },
    { service: '--all' },
    { container_name: '-target' },
  ])
    assert.equal(
      deploymentSchema.safeParse({ ...valid, ...patch }).success,
      false,
    )
})

test('only the precise machine endpoints bypass browser origin validation', async () => {
  assert.equal(
    (await app.request('/connectors/deployments/claim', { method: 'POST' }))
      .status,
    401,
  )
  assert.equal(
    (
      await app.request('/connectors/deployments/not-a-route', {
        method: 'POST',
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await app.request('/projects/demo/applications/web/deployment', {
        method: 'PUT',
        body: '{}',
      })
    ).status,
    403,
  )
  assert.equal(
    (await app.request('/projects/demo/applications/web/deployment')).status,
    401,
  )
})
