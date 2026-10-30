import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replacementSpec, repositoryPath } from './deployments.js'
import { readConfig } from './config.js'
import type { DeploymentJob } from '@dedi-dash/protocol'

const job: DeploymentJob = {
  id: 'build',
  deployment_id: 'deployment',
  commit: 'a'.repeat(40),
  project: 'demo',
  application: 'web',
  config: {
    connector_id: 'connector',
    container_name: 'web',
    repository: 'owner/repo',
    branch: 'main',
    kind: 'dockerfile',
    build_file: 'Dockerfile',
    context: '.',
    service: 'web',
    enabled: true,
  },
}
test('deployment execution requires explicit opt-in', () => {
  assert.equal(readConfig({}).deploymentsEnabled, false)
  assert.equal(
    readConfig({ DEPLOYMENTS_ENABLED: 'false' }).deploymentsEnabled,
    false,
  )
  assert.equal(
    readConfig({ DEPLOYMENTS_ENABLED: 'true' }).deploymentsEnabled,
    true,
  )
})
test('replacement preserves runtime settings, mounts and network aliases while using new image defaults', () => {
  const original = {
    Id: 'a'.repeat(64),
    Config: {
      Cmd: ['old'],
      Env: ['DEFAULT=old', 'SECRET=keep'],
      Labels: { custom: 'yes' },
    },
    HostConfig: {
      PortBindings: { '80/tcp': [{ HostPort: '8080' }] },
      RestartPolicy: { Name: 'always' },
      Binds: ['/host:/data'],
      Mounts: [],
    },
    Mounts: [{ Type: 'volume', Name: 'anon', Destination: '/state', RW: true }],
    NetworkSettings: {
      Networks: {
        app: {
          Aliases: ['web', 'a'.repeat(12)],
          NetworkID: 'ignore',
          EndpointID: 'ignore',
        },
      },
    },
  }
  const spec = replacementSpec(
    original,
    'new-image',
    job,
    { Cmd: ['old'], Env: ['DEFAULT=old'] },
    { Cmd: ['new'], Env: ['DEFAULT=new', 'ADDED=yes'] },
  )
  assert.deepEqual(spec.Cmd, ['new'])
  assert.deepEqual(spec.Env, ['DEFAULT=new', 'ADDED=yes', 'SECRET=keep'])
  assert.deepEqual(
    spec.HostConfig.PortBindings,
    original.HostConfig.PortBindings,
  )
  assert.deepEqual(spec.HostConfig.Binds, ['/host:/data'])
  assert.deepEqual(spec.HostConfig.Mounts, [
    { Type: 'volume', Source: 'anon', Target: '/state', ReadOnly: false },
  ])
  assert.deepEqual(spec.NetworkingConfig.EndpointsConfig.app, {
    Aliases: ['web'],
    IPAMConfig: undefined,
  })
  assert.equal(spec.Labels['dedi-dash.project'], 'demo')
  assert.equal(spec.Labels.custom, 'yes')
  assert.deepEqual(original.HostConfig.Mounts, [])
  assert.throws(() =>
    replacementSpec(
      { ...original, HostConfig: { AutoRemove: true } },
      'image',
      job,
    ),
  )
})
test('resolved build paths must remain inside checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dedi-deploy-test-'))
  try {
    const root = join(directory, 'repo')
    await mkdir(root)
    await writeFile(join(root, 'Dockerfile'), 'FROM scratch')
    await writeFile(join(directory, 'outside'), 'private')
    assert.equal(
      await repositoryPath(root, 'Dockerfile'),
      await import('node:fs/promises').then((fs) =>
        fs.realpath(join(root, 'Dockerfile')),
      ),
    )
    await assert.rejects(
      repositoryPath(root, '../outside'),
      /inside the repository/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
