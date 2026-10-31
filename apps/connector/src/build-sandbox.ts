import { mkdir, mkdtemp, readFile, stat, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { buildArtifactSchema, type DeploymentJob } from '@kloud/protocol'
import type { ConnectorConfig } from './config.js'
import { engine, runCommand, dockerHost } from './deployment-process.js'

/** Builder has no host socket, mounts or connector credentials. */
export function buildkitSpec(
  config: ConnectorConfig,
  network: string,
  labels: Record<string, string>,
) {
  return {
    Image: config.buildkitImage,
    User: '1000:1000',
    Cmd: ['--addr', 'tcp://0.0.0.0:1234', '--oci-worker-snapshotter=native'],
    Labels: { ...labels, 'kloud.role': 'buildkit' },
    HostConfig: {
      NetworkMode: network,
      Memory: config.buildMemoryMb * 1024 * 1024,
      NanoCpus: 2e9,
      PidsLimit: 512,
      // Required by rootless BuildKit. Keep its process sandbox enabled.
      SecurityOpt: ['seccomp=unconfined', 'apparmor=unconfined'],
      MaskedPaths: [],
      ReadonlyPaths: [],
      LogConfig: {
        Type: 'json-file',
        Config: { 'max-size': '10m', 'max-file': '1' },
      },
    },
    NetworkingConfig: {
      EndpointsConfig: { [network]: { Aliases: ['buildkit'] } },
    },
  }
}

export function helperSpec(
  job: DeploymentJob,
  config: ConnectorConfig,
  project: string,
  network: string,
  volume: string,
  labels: Record<string, string>,
  local: boolean,
  phase: 'checkout' | 'build' = 'build',
) {
  return {
    Image: config.buildHelperImage,
    User: '1000:1000',
    Cmd: ['node', 'apps/connector/dist/build-helper.js'],
    Env: [
      `DEPLOYMENT_JOB=${JSON.stringify(job)}`,
      `COMPOSE_PROJECT_NAME=${project}`,
      `DEPLOYMENT_PHASE=${phase}`,
      'HOME=/tmp',
      'DOCKER_CONFIG=/tmp/docker',
      // Only the explicitly configured source credential crosses this boundary.
      ...(config.githubToken && !local && phase === 'checkout'
        ? [`DEPLOYMENT_GITHUB_TOKEN=${config.githubToken}`]
        : []),
    ],
    Labels: {
      ...labels,
      'kloud.role':
        phase === 'checkout' ? 'source-checkout' : 'build-helper',
    },
    HostConfig: {
      NetworkMode: network,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Memory: config.buildMemoryMb * 1024 * 1024,
      NanoCpus: 2e9,
      PidsLimit: 256,
      Mounts: [{ Type: 'volume', Source: volume, Target: '/workspace' }],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m' },
      LogConfig: {
        Type: 'json-file',
        Config: { 'max-size': '10m', 'max-file': '1' },
      },
    },
  }
}

export async function sandboxBuild(
  job: DeploymentJob,
  config: ConnectorConfig,
  project: string,
  signal: AbortSignal,
  log: (s: string) => void,
  checkout?: string,
) {
  await mkdir(config.deploymentsDir, { recursive: true })
  const directory = await mkdtemp(
    join(resolve(config.deploymentsDir), `${job.deployment_id}-`),
  )
  const owner = createHash('sha256')
    .update(config.token)
    .digest('hex')
    .slice(0, 20)
  const labels = {
    'kloud.internal': 'true',
    'kloud.build': job.id,
    'kloud.owner': owner,
  }
  const name = `kloud-build-${job.id}`
  const network = `${name}-net`,
    volume = `${name}-workspace`
  const docker = (args: string[], output = log) =>
    runCommand(
      'docker',
      ['--host', dockerHost(config.dockerSocket), ...args],
      directory,
      signal,
      output,
    )
  let builder: string | undefined,
    helper: string | undefined,
    source: string | undefined,
    hasNetwork = false,
    hasVolume = false
  const runHelper = async (id: string, phase: string) => {
    try {
      await docker(['start', '--attach', id])
    } catch (error) {
      if (signal.aborted) throw error
    }
    const state = (
      await engine(config.dockerSocket, 'GET', `/containers/${id}/json`)
    ).State
    if (state.Status !== 'exited' || state.ExitCode !== 0)
      throw new Error(
        `${phase} helper failed (exit ${state.ExitCode}); the running service was not changed`,
      )
  }
  try {
    for (const image of [config.buildHelperImage, config.buildkitImage]) {
      try {
        await engine(
          config.dockerSocket,
          'GET',
          `/images/${encodeURIComponent(image)}/json`,
        )
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.startsWith('Docker GET failed (404):')
        )
          throw error
        if (image === config.buildHelperImage)
          throw new Error(
            `Build helper image is missing: ${image}. Build the build-helper Dockerfile target first.`,
          )
        await docker(['pull', '--', image])
      }
    }
    log('Creating a temporary rootless builder and isolated build helper.\n')
    await engine(config.dockerSocket, 'POST', '/networks/create', {
      Name: network,
      Labels: labels,
      CheckDuplicate: true,
    })
    hasNetwork = true
    await engine(config.dockerSocket, 'POST', '/volumes/create', {
      Name: volume,
      Labels: labels,
    })
    hasVolume = true
    if (!checkout) {
      // The token-bearing checkout process is destroyed before any build tools run.
      source = (
        await engine(
          config.dockerSocket,
          'POST',
          `/containers/create?name=${name}-checkout`,
          helperSpec(
            job,
            config,
            project,
            network,
            volume,
            labels,
            false,
            'checkout',
          ),
        )
      ).Id
      await runHelper(source!, 'Checkout')
      await engine(
        config.dockerSocket,
        'DELETE',
        `/containers/${source}?force=true&v=true`,
      )
      source = undefined
    }
    builder = (
      await engine(
        config.dockerSocket,
        'POST',
        `/containers/create?name=${name}-builder`,
        buildkitSpec(config, network, labels),
      )
    ).Id
    helper = (
      await engine(
        config.dockerSocket,
        'POST',
        `/containers/create?name=${name}-helper`,
        helperSpec(job, config, project, network, volume, labels, !!checkout),
      )
    ).Id
    if (checkout) {
      // Test/local callers still build in the sandbox, never against the host daemon.
      await docker([
        'cp',
        `${resolve(checkout)}${process.platform === 'win32' ? '\\' : '/'}.`,
        `${helper}:/workspace/repository`,
      ])
    }
    await engine(config.dockerSocket, 'POST', `/containers/${builder}/start`)
    await runHelper(helper!, 'Build')
    signal.throwIfAborted()
    await docker(['cp', `${helper}:/workspace/output`, directory], () => {})
    if (job.config.kind === 'compose')
      await docker(
        ['cp', `${helper}:/workspace/repository`, directory],
        () => {},
      )
    const manifest = buildArtifactSchema.parse(
      JSON.parse(
        await readFile(join(directory, 'output', 'manifest.json'), 'utf8'),
      ),
    )
    const allowed = new RegExp(
      `^kloud/${job.deployment_id}:${job.commit}(?:-[0-9]+)?$`,
    )
    for (const image of manifest.images) {
      if (!allowed.test(image.tag))
        throw new Error('Unexpected build artifact image tag')
      const path = join(directory, 'output', image.file)
      if (!(await stat(path)).isFile())
        throw new Error('Missing image artifact')
      log(`Importing built image ${image.tag}.\n`)
      await docker(['load', '--input', path])
      await engine(
        config.dockerSocket,
        'GET',
        `/images/${encodeURIComponent(image.tag)}/json`,
      )
      await unlink(path)
    }
    return { directory }
  } catch (error) {
    if (builder) {
      try {
        log('\nBuilder diagnostics:\n')
        await docker(['logs', '--tail', '30', builder])
      } catch {}
    }
    throw error
  } finally {
    // Cleanup is independent of cancellation; do not leave source or running builders behind.
    for (const id of [source, helper, builder])
      if (id) {
        try {
          await engine(
            config.dockerSocket,
            'DELETE',
            `/containers/${id}?force=true&v=true`,
          )
        } catch (error) {
          log(
            `\nBuild container cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
          )
        }
      }
    if (hasVolume)
      try {
        await engine(config.dockerSocket, 'DELETE', `/volumes/${volume}`)
      } catch {
        log(`\nRemove unused build volume ${volume} manually.\n`)
      }
    if (hasNetwork)
      try {
        await engine(config.dockerSocket, 'DELETE', `/networks/${network}`)
      } catch {
        log(`\nRemove unused build network ${network} manually.\n`)
      }
  }
}

/** Recover resources left by a crashed connector; never touch another connector's builds. */
export async function cleanupExpiredBuilds(
  config: ConnectorConfig,
  log: (s: string) => void,
  now = Date.now(),
  call = engine,
) {
  const owner = createHash('sha256')
    .update(config.token)
    .digest('hex')
    .slice(0, 20)
  const filters = encodeURIComponent(
    JSON.stringify({
      label: [`kloud.owner=${owner}`, 'kloud.internal=true'],
    }),
  )
  const old = (time: number) =>
    Number.isFinite(time) && time < now - 40 * 60 * 1000
  const containers = await call(
    config.dockerSocket,
    'GET',
    `/containers/json?all=true&filters=${filters}`,
  )
  for (const container of containers) {
    if (
      !['source-checkout', 'build-helper', 'buildkit'].includes(
        container.Labels?.['kloud.role'],
      ) ||
      !old(container.Created * 1000)
    )
      continue
    await call(
      config.dockerSocket,
      'DELETE',
      `/containers/${container.Id}?force=true&v=true`,
    )
    log('Removed an expired build container.\n')
  }
  const volumes = await call(
    config.dockerSocket,
    'GET',
    `/volumes?filters=${filters}`,
  )
  for (const volume of volumes.Volumes ?? []) {
    if (
      !volume.Name.startsWith('kloud-build-') ||
      !old(Date.parse(volume.CreatedAt))
    )
      continue
    try {
      await call(
        config.dockerSocket,
        'DELETE',
        `/volumes/${encodeURIComponent(volume.Name)}`,
      )
    } catch {
      /* Still mounted: leave it alone. */
    }
  }
  const networks = await call(
    config.dockerSocket,
    'GET',
    `/networks?filters=${filters}`,
  )
  for (const network of networks) {
    if (
      !network.Name.startsWith('kloud-build-') ||
      !old(Date.parse(network.Created))
    )
      continue
    try {
      await call(config.dockerSocket, 'DELETE', `/networks/${network.Id}`)
    } catch {
      /* Still in use: leave it alone. */
    }
  }
}
