import { test } from 'node:test'
import assert from 'node:assert/strict'
import { helperSpec } from './build-sandbox.js'
import { readConfig } from './config.js'
import type { DeploymentJob } from '@kloud/protocol'

test('source checkout credentials never enter build-phase job serialization; build secrets never enter source checkout', () => {
  const job: DeploymentJob = {
    id: '00000000-0000-4000-8000-000000000001',
    deployment_id: '00000000-0000-4000-8000-000000000002',
    project: 'demo',
    application: 'web',
    commit: 'a'.repeat(40),
    config: {
      connector_id: '00000000-0000-4000-8000-000000000003',
      container_name: 'web',
      repository: 'owner/repo',
      branch: 'main',
      kind: 'dockerfile',
      build_file: 'Dockerfile',
      context: '.',
      service: 'app',
      enabled: true,
    },
    source_auth: {
      token: 'connection-source-secret',
      url: 'https://github.com/owner/repo.git',
    },
  }
  const config = readConfig({
    CONNECTOR_TOKEN: 'connector-api-secret',
    DEPLOYMENTS_GITHUB_TOKEN: 'legacy-source-secret',
  })
  const inputs = {
    secrets: { npmrc: 'private-npm-secret' },
    registries: [
      {
        server: 'registry.example',
        username: 'user',
        password: 'private-registry-secret',
      },
    ],
  }
  const checkout = helperSpec(
    job,
    config,
    'project',
    'network',
    'volume',
    {},
    false,
    'checkout',
    job.source_auth,
  )
  const build = helperSpec(
    job,
    config,
    'project',
    'network',
    'volume',
    {},
    false,
    'build',
    undefined,
    inputs,
  )
  const jobEnv = checkout.Env.find((value) =>
    value.startsWith('DEPLOYMENT_JOB='),
  )!
  assert.ok(!jobEnv.includes('connection-source-secret'))
  assert.ok(
    checkout.Env.some((value) => value.includes('connection-source-secret')),
  )
  for (const secret of [
    'connector-api-secret',
    'legacy-source-secret',
    'private-npm-secret',
    'private-registry-secret',
  ])
    assert.ok(!JSON.stringify(checkout).includes(secret))
  for (const secret of [
    'connector-api-secret',
    'connection-source-secret',
    'legacy-source-secret',
  ])
    assert.ok(!JSON.stringify(build).includes(secret))
  assert.ok(build.Env.some((value) => value.includes('private-npm-secret')))
  assert.ok(
    build.Env.some((value) => value.includes('private-registry-secret')),
  )
  assert.ok(
    !build.Env.find((value) => value.startsWith('DEPLOYMENT_JOB='))!.includes(
      'private-npm-secret',
    ),
  )
})

test('watch diffs include deleted and both renamed paths and reject incomplete history output', async () => {
  const { changedPaths } = await import('./build-helper.js')
  assert.deepEqual(
    changedPaths(
      'M\0apps/web/main.ts\0D\0packages/old.ts\0R100\0old/name.ts\0new/name.ts\0',
    ),
    ['apps/web/main.ts', 'packages/old.ts', 'old/name.ts', 'new/name.ts'],
  )
  assert.deepEqual(changedPaths(''), [])
  assert.equal(changedPaths('R100\0only-one-path\0'), null)
  assert.equal(changedPaths('M\0truncated'), null)
  assert.equal(changedPaths('M\0bad-\uFFFD-name\0'), null)
  assert.equal(changedPaths('M\0' + 'a'.repeat(2 * 1024 * 1024) + '\0'), null)
})

test('secret output redaction spans arbitrary chunks and does not reveal trailing prefixes', async () => {
  const { secretOutput } = await import('./secret-output.js')
  let output = ''
  const stream = secretOutput(['very-private-token'], (chunk) => {
    output += chunk
  })
  for (const chunk of ['starting very-', 'private-', 'token finished\n'])
    stream.write(chunk)
  stream.flush()
  assert.ok(!output.includes('very-private-token'))
  assert.match(output, /\[redacted\]/)
  const partial = secretOutput(['other-private-token'], (chunk) => {
    output += chunk
  })
  partial.write('final other-private-')
  partial.flush()
  assert.ok(!output.includes('other-private-'))
})
