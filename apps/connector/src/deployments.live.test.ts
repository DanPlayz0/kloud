import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deployCheckout } from './deployments.js'
import { readConfig } from './config.js'
import { sandboxBuild } from './build-sandbox.js'
import type { DeploymentJob } from '@dedi-dash/protocol'

test(
  'public GitHub checkout runs in its own disposable helper before building the exact commit',
  { skip: process.env.RUN_DEPLOYMENT_GITHUB !== '1', timeout: 90000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dedi-source-test-'))
    const deployment = randomUUID(),
      id = randomUUID()
    const commit = '522bcd2faf422c60b9d20e64d7cd6d56600aec97'
    const config = readConfig({
      ...process.env,
      CONNECTOR_TOKEN: 'not-a-build-credential',
      DEPLOYMENTS_DIR: directory,
    })
    const job: DeploymentJob = {
      id,
      deployment_id: deployment,
      project: 'test',
      application: 'source',
      commit,
      config: {
        connector_id: randomUUID(),
        container_name: 'unused',
        repository: 'docker-library/hello-world',
        branch: 'master',
        kind: 'dockerfile',
        build_file: 'amd64/Dockerfile',
        context: 'amd64',
        service: 'app',
        managed: true,
        enabled: true,
      },
    }
    const image = `dedi-dash/${deployment}:${commit}`
    const docker = (...args: string[]) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    const logs: string[] = []
    try {
      await sandboxBuild(
        job,
        config,
        `dedi-${deployment}`,
        AbortSignal.timeout(80000),
        (s) => logs.push(s),
      )
      assert.ok(logs.join('').includes('Source checkout completed.'))
      assert.match(docker('run', '--rm', image), /Hello from Docker/)
      assert.equal(
        docker(
          'ps',
          '--all',
          '--filter',
          `label=dedi-dash.build=${id}`,
          '--quiet',
        ),
        '',
      )
    } catch (error) {
      console.error(logs.join('').slice(-12000))
      throw error
    } finally {
      try {
        docker('image', 'rm', image)
      } catch {}
      const root = resolve(tmpdir())
      if (
        !resolve(directory).startsWith(root + '\\') &&
        !resolve(directory).startsWith(root + '/')
      )
        throw new Error('Unexpected cleanup path')
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  'managed services deploy initially, reject container takeover, and label every Compose service',
  { skip: process.env.RUN_DEPLOYMENT_DOCKER !== '1', timeout: 180000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dedi-managed-test-'))
    const artifacts = await mkdtemp(join(tmpdir(), 'dedi-build-output-'))
    const suffix = randomUUID().slice(0, 8),
      deploymentId = randomUUID()
    const name = `dedi-managed-${suffix}`
    const config = readConfig({ ...process.env, DEPLOYMENTS_DIR: artifacts })
    const docker = (...args: string[]) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    const inspect = (target: string) => JSON.parse(docker('inspect', target))[0]
    const job: DeploymentJob = {
      id: randomUUID(),
      deployment_id: deploymentId,
      project: 'managed-test',
      application: suffix,
      commit: 'a'.repeat(40),
      config: {
        connector_id: randomUUID(),
        container_name: name,
        managed: true,
        repository: 'owner/repo',
        branch: 'main',
        kind: 'dockerfile',
        build_file: 'Dockerfile',
        context: '.',
        service: 'app',
        enabled: true,
      },
    }
    const logs: string[] = []
    try {
      await writeFile(
        join(directory, 'Dockerfile'),
        'FROM node:22-alpine\nRUN test ! -S /var/run/docker.sock && test -z "$CONNECTOR_TOKEN"\nCMD ["node","-e","setInterval(()=>{},1000)"]\n',
      )
      await deployCheckout(
        job,
        config,
        directory,
        AbortSignal.timeout(60000),
        (s) => logs.push(s),
      )
      const before = inspect(name)
      assert.equal(before.State.Running, true)
      assert.equal(before.Config.Labels['dedi-dash.application'], suffix)
      // A source build failure must never reach the runtime replacement step.
      await writeFile(
        join(directory, 'Dockerfile'),
        'FROM node:22-alpine\nRUN exit 1\n',
      )
      const failed = { ...job, id: randomUUID() }
      await assert.rejects(
        deployCheckout(
          failed,
          config,
          directory,
          AbortSignal.timeout(60000),
          (s) => logs.push(s),
        ),
        /Build helper failed/,
      )
      assert.equal(inspect(name).Id, before.Id)
      assert.equal(
        docker(
          'ps',
          '--all',
          '--filter',
          `label=dedi-dash.build=${failed.id}`,
          '--quiet',
        ),
        '',
      )
      assert.equal(
        docker(
          'volume',
          'ls',
          '--filter',
          `label=dedi-dash.build=${failed.id}`,
          '--quiet',
        ),
        '',
      )
      assert.equal(
        docker(
          'network',
          'ls',
          '--filter',
          `label=dedi-dash.build=${failed.id}`,
          '--quiet',
        ),
        '',
      )
      await writeFile(
        join(directory, 'Dockerfile'),
        'FROM node:22-alpine\nRUN sleep 60\n',
      )
      const cancelled = { ...job, id: randomUUID() },
        abort = new AbortController()
      await assert.rejects(
        deployCheckout(
          cancelled,
          config,
          directory,
          AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]),
          (s) => {
            logs.push(s)
            if (s.includes('RUN sleep 60')) abort.abort()
          },
        ),
      )
      assert.equal(inspect(name).Id, before.Id)
      for (const kind of ['container', 'volume', 'network'])
        assert.equal(
          docker(
            kind,
            'ls',
            ...(kind === 'container' ? ['--all'] : []),
            '--filter',
            `label=dedi-dash.build=${cancelled.id}`,
            '--quiet',
          ),
          '',
        )
      await writeFile(
        join(directory, 'Dockerfile'),
        'FROM node:22-alpine\nCMD ["node","-e","setInterval(()=>{},1000)"]\n',
      )
      await assert.rejects(
        deployCheckout(
          { ...job, application: 'other' },
          config,
          directory,
          AbortSignal.timeout(60000),
          (s) => logs.push(s),
        ),
        /belongs to another service/,
      )
      await deployCheckout(
        { ...job, id: randomUUID() },
        config,
        directory,
        AbortSignal.timeout(60000),
        (s) => logs.push(s),
      )
      assert.notEqual(inspect(name).Id, before.Id)
      await writeFile(
        join(directory, 'compose.json'),
        JSON.stringify({
          services: {
            web: {
              image: 'node:22-alpine',
              container_name: `${name}-web`,
              command: ['node', '-e', 'setInterval(()=>{},1000)'],
            },
            cache: {
              image: 'node:22-alpine',
              container_name: `${name}-cache`,
              command: ['node', '-e', 'setInterval(()=>{},1000)'],
            },
          },
        }),
      )
      const stack = {
        ...job,
        config: {
          ...job.config,
          kind: 'compose' as const,
          build_file: 'compose.json',
        },
      }
      await deployCheckout(
        stack,
        config,
        directory,
        AbortSignal.timeout(60000),
        (s) => logs.push(s),
      )
      for (const target of [`${name}-web`, `${name}-cache`]) {
        const container = inspect(target)
        assert.equal(container.State.Running, true)
        assert.equal(
          container.Config.Labels['dedi-dash.project'],
          'managed-test',
        )
        assert.equal(container.Config.Labels['dedi-dash.application'], suffix)
        assert.equal(
          container.Config.Labels['com.docker.compose.project'],
          `dedi-${deploymentId}`,
        )
      }
    } catch (error) {
      console.error(logs.join('').slice(-12000))
      throw error
    } finally {
      for (const target of [name, `${name}-web`, `${name}-cache`]) {
        try {
          docker('rm', '--force', target)
        } catch {}
      }
      try {
        docker('network', 'rm', `dedi-${deploymentId}_default`)
      } catch {}
      try {
        docker('image', 'rm', `dedi-dash/${deploymentId}:${job.commit}`)
      } catch {}
      const root = resolve(tmpdir())
      if (
        !resolve(directory).startsWith(root + '\\') &&
        !resolve(directory).startsWith(root + '/')
      )
        throw new Error('Unexpected test directory')
      await rm(directory, { recursive: true, force: true })
      if (
        !resolve(artifacts).startsWith(resolve(tmpdir()) + '\\') &&
        !resolve(artifacts).startsWith(resolve(tmpdir()) + '/')
      )
        throw new Error('Unexpected artifact cleanup directory')
      await rm(artifacts, { recursive: true, force: true })
    }
  },
)

test(
  'live Docker rebuild preserves mounts and settings, restores failed replacement, and rebuilds a Compose service',
  { skip: process.env.RUN_DEPLOYMENT_DOCKER !== '1', timeout: 180000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dedi-live-deploy-'))
    const artifacts = await mkdtemp(join(tmpdir(), 'dedi-build-output-'))
    const suffix = randomUUID().slice(0, 8)
    const name = `dedi-deploy-${suffix}`,
      project = `dedi-compose-${suffix}`,
      image = `dedi-deploy-test:${suffix}`
    const deploymentID = randomUUID()
    const config = readConfig({
      ...process.env,
      DEPLOYMENTS_ENABLED: 'true',
      DEPLOYMENTS_DIR: artifacts,
    })
    const docker = (...args: string[]) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    const inspect = (target: string) => JSON.parse(docker('inspect', target))[0]
    const file = join(directory, 'Dockerfile')
    const job: DeploymentJob = {
      id: randomUUID(),
      deployment_id: deploymentID,
      commit: 'a'.repeat(40),
      project: 'demo',
      application: 'web',
      config: {
        connector_id: randomUUID(),
        container_name: name,
        repository: 'owner/repo',
        branch: 'main',
        kind: 'dockerfile',
        build_file: 'Dockerfile',
        context: '.',
        service: 'web',
        enabled: true,
      },
    }
    const logs: string[] = []
    let volume: string | undefined
    try {
      await writeFile(
        file,
        'FROM node:22-alpine\nENV VERSION=old\nCMD ["node","-e","setInterval(()=>{},1000)"]\n',
      )
      docker('build', '--tag', image, directory)
      docker(
        'run',
        '--detach',
        '--name',
        name,
        '--restart',
        'unless-stopped',
        '--env',
        'RUNTIME=keep',
        '--volume',
        '/state',
        image,
      )
      const before = inspect(name)
      volume = before.Mounts[0].Name
      await writeFile(
        file,
        'FROM node:22-alpine\nENV VERSION=new\nCMD ["node","-e","setInterval(()=>{},1000)"]\n',
      )
      await deployCheckout(
        job,
        config,
        directory,
        AbortSignal.timeout(60000),
        (s) => logs.push(s),
      )
      const after = inspect(name)
      assert.notEqual(after.Id, before.Id)
      assert.equal(after.State.Running, true)
      assert.ok(after.Config.Env.includes('VERSION=new'))
      assert.ok(after.Config.Env.includes('RUNTIME=keep'))
      assert.equal(after.HostConfig.RestartPolicy.Name, 'unless-stopped')
      assert.equal(after.Mounts[0].Name, volume)
      assert.equal(after.Config.Labels['dedi-dash.application'], 'web')
      await writeFile(
        file,
        'FROM node:22-alpine\nCMD ["node","-e","process.exit(1)"]\n',
      )
      // Disable restart so the intentional crash is observed immediately.
      docker('update', '--restart', 'no', name)
      const failure = { ...job, id: randomUUID(), commit: 'b'.repeat(40) }
      await assert.rejects(
        deployCheckout(
          failure,
          config,
          directory,
          AbortSignal.timeout(60000),
          (s) => logs.push(s),
        ),
        /startup check/,
      )
      assert.equal(inspect(name).Id, after.Id)
      assert.equal(inspect(name).State.Running, true)
      await writeFile(
        file,
        'FROM node:22-alpine\nENV COMPOSE_VERSION=new\nCMD ["node","-e","setInterval(()=>{},1000)"]\n',
      )
      const composeFile = join(directory, 'compose.json')
      await writeFile(
        join(directory, 'service.env'),
        'FROM_FILE=stable\nAPI_LEAK=${CONNECTOR_TOKEN:-empty}\n',
      )
      await writeFile(
        composeFile,
        JSON.stringify({
          services: {
            web: {
              build: '.',
              image,
              container_name: `${name}-compose`,
              environment: { LITERAL: 'value$$name' },
              env_file: ['./service.env'],
            },
          },
        }),
      )
      docker(
        'compose',
        '--project-name',
        project,
        '--file',
        composeFile,
        'up',
        '--detach',
        '--build',
      )
      const priorCompose = inspect(`${name}-compose`)
      const composeJob = {
        ...job,
        id: randomUUID(),
        config: {
          ...job.config,
          container_name: `${name}-compose`,
          kind: 'compose' as const,
          build_file: 'compose.json',
        },
      }
      await deployCheckout(
        composeJob,
        config,
        directory,
        AbortSignal.timeout(60000),
        (s) => logs.push(s),
      )
      const currentCompose = inspect(`${name}-compose`)
      assert.notEqual(currentCompose.Id, priorCompose.Id)
      assert.equal(
        currentCompose.Config.Labels['com.docker.compose.project'],
        project,
      )
      assert.equal(currentCompose.Config.Labels['dedi-dash.project'], 'demo')
      assert.ok(currentCompose.Config.Env.includes('LITERAL=value$name'))
      assert.ok(currentCompose.Config.Env.includes('FROM_FILE=stable'))
      assert.ok(currentCompose.Config.Env.includes('API_LEAK=empty'))
    } catch (error) {
      console.error(logs.join('').slice(-12000))
      throw error
    } finally {
      for (const target of [
        name,
        `${name}-compose`,
        `${name}-backup-${job.id}`,
      ]) {
        try {
          docker('rm', '--force', target)
        } catch {}
      }
      try {
        docker('network', 'rm', `${project}_default`)
      } catch {}
      if (volume) {
        try {
          docker('volume', 'rm', volume)
        } catch {}
      }
      for (const tag of [
        image,
        `dedi-dash/${deploymentID}:${'a'.repeat(40)}`,
        `dedi-dash/${deploymentID}:${'b'.repeat(40)}`,
        `dedi-dash/${deploymentID}:${'a'.repeat(40)}-0`,
      ]) {
        try {
          docker('image', 'rm', tag)
        } catch {}
      }
      if (
        !resolve(directory).startsWith(resolve(tmpdir()) + '\\') &&
        !resolve(directory).startsWith(resolve(tmpdir()) + '/')
      )
        throw new Error('Unexpected cleanup directory')
      await rm(directory, { recursive: true, force: true })
      if (
        !resolve(artifacts).startsWith(resolve(tmpdir()) + '\\') &&
        !resolve(artifacts).startsWith(resolve(tmpdir()) + '/')
      )
        throw new Error('Unexpected artifact cleanup directory')
      await rm(artifacts, { recursive: true, force: true })
    }
  },
)
