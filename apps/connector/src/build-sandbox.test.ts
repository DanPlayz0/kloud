import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildkitSpec,
  helperSpec,
  cleanupExpiredBuilds,
} from './build-sandbox.js'
import { imageTag, runtimeCompose } from './build-helper.js'
import { readConfig } from './config.js'
import { commandEnvironment } from './deployment-process.js'
import type { DeploymentJob } from '@kloud/protocol'

const job: DeploymentJob = {
  id: '00000000-0000-4000-8000-000000000001',
  deployment_id: '00000000-0000-4000-8000-000000000002',
  project: 'demo',
  application: 'web',
  commit: 'a'.repeat(40),
  config: {
    connector_id: '00000000-0000-4000-8000-000000000003',
    container_name: 'kloud-demo-web',
    repository: 'owner/repo',
    branch: 'main',
    kind: 'dockerfile',
    build_file: 'Dockerfile',
    context: '.',
    service: 'app',
    enabled: true,
    managed: true,
  },
}

test('host Docker and Compose processes cannot interpolate connector or application secrets', () => {
  assert.deepEqual(
    commandEnvironment('docker', {
      Path: 'tools',
      SYSTEMROOT: 'Windows',
      HOME: 'home',
      DOCKER_CONFIG: 'registry-config',
      CONNECTOR_TOKEN: 'api-secret',
      DATABASE_URL: 'database-secret',
      DEPLOYMENTS_GITHUB_TOKEN: 'git-secret',
      COMPOSE_FILE: 'untrusted-file',
    }),
    {
      Path: 'tools',
      SYSTEMROOT: 'Windows',
      HOME: 'home',
      DOCKER_CONFIG: 'registry-config',
    },
  )
})

test('sandbox containers have no host socket, bind mounts, API credential, host network, or privileged flag', () => {
  const config = readConfig({
    CONNECTOR_TOKEN: 'connector-secret',
    DEPLOYMENTS_GITHUB_TOKEN: 'source-secret',
  })
  const helper = helperSpec(
    job,
    config,
    'project',
    'isolated-network',
    'workspace-volume',
    {},
    false,
  )
  assert.deepEqual(helper.HostConfig.Mounts, [
    { Type: 'volume', Source: 'workspace-volume', Target: '/workspace' },
  ])
  assert.equal(helper.User, '1000:1000')
  assert.equal(helper.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(helper.HostConfig.CapDrop, ['ALL'])
  assert.ok(helper.HostConfig.SecurityOpt.includes('no-new-privileges'))
  assert.equal(helper.HostConfig.NetworkMode, 'isolated-network')
  assert.ok(!JSON.stringify(helper).includes('connector-secret'))
  assert.ok(!JSON.stringify(helper).includes(config.dockerSocket))
  assert.equal(helper.Env.filter((v) => v.includes('source-secret')).length, 0)
  const source = helperSpec(
    job,
    config,
    'project',
    'isolated-network',
    'workspace-volume',
    {},
    false,
    'checkout',
  )
  assert.equal(source.Env.filter((v) => v.includes('source-secret')).length, 1)
  assert.ok(!JSON.stringify(source).includes('connector-secret'))
  assert.ok(
    !helperSpec(job, config, 'project', 'net', 'volume', {}, true).Env.some(
      (v) => v.includes('source-secret'),
    ),
  )
  const builder = buildkitSpec(config, 'isolated-network', {})
  assert.ok(builder.Image.endsWith('-rootless'))
  assert.ok(!JSON.stringify(builder).includes('source-secret'))
  assert.ok(!JSON.stringify(builder).includes('connector-secret'))
  assert.equal((builder.HostConfig as any).Privileged, undefined)
  assert.equal((builder.HostConfig as any).Binds, undefined)
  assert.equal((builder.HostConfig as any).Mounts, undefined)
  assert.ok(!builder.Cmd.includes('--oci-worker-no-process-sandbox'))
  assert.equal(builder.HostConfig.Memory, 2048 * 1024 * 1024)
  assert.equal(builder.HostConfig.NanoCpus, 2e9)
  assert.equal(builder.HostConfig.PidsLimit, 512)
})

test('runtime Compose manifest contains images only and retains service runtime configuration', () => {
  const model = {
    services: {
      web: {
        build: { context: '.' },
        develop: { watch: [] },
        environment: { PASSWORD: 'literal$value' },
        ports: ['8080:80'],
      },
      db: { image: 'postgres:17', volumes: ['state:/var/lib/postgresql/data'] },
    },
    volumes: { state: {} },
  }
  const tag = imageTag(job, 0)
  const runtime = runtimeCompose(model, job, { web: tag })
  assert.equal(runtime.services.web.build, undefined)
  assert.equal(runtime.services.web.develop, undefined)
  assert.equal(runtime.services.web.image, tag)
  assert.equal(runtime.services.web.pull_policy, 'never')
  assert.deepEqual(runtime.services.web.environment, {
    PASSWORD: 'literal$value',
  })
  assert.deepEqual(runtime.services.web.ports, ['8080:80'])
  assert.equal(runtime.services.db.labels['kloud.application'], 'web')
  assert.deepEqual(runtime.volumes, { state: {} })
  assert.ok(model.services.web.build)
  assert.notEqual(imageTag(job, 0), imageTag(job, 1))
})

test('crash recovery scopes cleanup to the connector and expires only old build resources', async () => {
  const now = Date.now(),
    removed: string[] = [],
    queries: string[] = []
  const call = async (_socket: string, method: string, path: string) => {
    if (method === 'DELETE') {
      removed.push(path)
      return null
    }
    queries.push(decodeURIComponent(path))
    if (path.startsWith('/containers/'))
      return [
        {
          Id: 'expired',
          Created: (now - 41 * 60 * 1000) / 1000,
          Labels: { 'kloud.role': 'buildkit' },
        },
        {
          Id: 'current',
          Created: now / 1000,
          Labels: { 'kloud.role': 'build-helper' },
        },
        { Id: 'runtime', Created: 0, Labels: {} },
      ]
    if (path.startsWith('/volumes'))
      return {
        Volumes: [
          {
            Name: 'kloud-build-expired-workspace',
            CreatedAt: new Date(now - 41 * 60 * 1000).toISOString(),
          },
          {
            Name: 'kloud-build-current-workspace',
            CreatedAt: new Date(now).toISOString(),
          },
        ],
      }
    return [
      {
        Id: 'network',
        Name: 'kloud-build-expired-net',
        Created: new Date(now - 41 * 60 * 1000).toISOString(),
      },
    ]
  }
  await cleanupExpiredBuilds(
    readConfig({ CONNECTOR_TOKEN: 'credential' }),
    () => {},
    now,
    call,
  )
  assert.deepEqual(removed, [
    '/containers/expired?force=true&v=true',
    '/volumes/kloud-build-expired-workspace',
    '/networks/network',
  ])
  assert.ok(
    queries.every(
      (q) =>
        q.includes('kloud.owner=') && q.includes('kloud.internal=true'),
    ),
  )
  assert.ok(queries.every((q) => !q.includes('credential')))
})
