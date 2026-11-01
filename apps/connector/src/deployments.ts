import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { deploymentJobSchema, type DeploymentJob } from '@kloud/protocol'
import type { ConnectorConfig } from './config.js'
import { formatComposeEnvironment } from './compose-environment.js'
import {
  engine,
  runCommand,
  runComposeConfig,
  dockerHost,
} from './deployment-process.js'
export { repositoryPath, runCommand } from './deployment-process.js'
import { sandboxBuild, cleanupExpiredBuilds } from './build-sandbox.js'
import { applyRuntime } from './platform.js'
import type { RuntimeConfig } from '@kloud/protocol/platform'
import { applyComposeRelease } from './compose-rollout.js'
import { runBlueGreen, type RolloutContext } from './rollout.js'

export function replacementSpec(
  original: any,
  image: string,
  job: DeploymentJob,
  oldDefaults: any = {},
  newDefaults: any = {},
) {
  if (
    original.HostConfig.AutoRemove ||
    original.HostConfig.NetworkMode?.startsWith('container:')
  )
    throw new Error(
      'Auto-remove and shared-container network targets require Compose deployment',
    )
  const host = structuredClone(original.HostConfig)
  // Pin anonymous volumes to their existing volume names across replacement.
  host.Mounts ??= []
  for (const mount of original.Mounts ?? []) {
    const bound =
      (host.Binds ?? []).some(
        (b: string) => b.split(':')[1] === mount.Destination,
      ) || host.Mounts.some((m: any) => m.Target === mount.Destination)
    if (mount.Type === 'volume' && !bound)
      host.Mounts.push({
        Type: 'volume',
        Source: mount.Name,
        Target: mount.Destination,
        ReadOnly: !mount.RW,
      })
  }
  const endpoints: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(
    original.NetworkSettings?.Networks ?? {},
  )) {
    const network = raw as any
    endpoints[name] = {
      Aliases: network.Aliases?.filter(
        (a: string) => a !== original.Id && a !== original.Id.slice(0, 12),
      ),
      IPAMConfig: network.IPAMConfig,
    }
  }
  const runtime = { ...original.Config }
  for (const key of [
    'Cmd',
    'Entrypoint',
    'WorkingDir',
    'User',
    'Healthcheck',
    'Shell',
    'StopSignal',
  ]) {
    if (JSON.stringify(runtime[key]) === JSON.stringify(oldDefaults[key]))
      runtime[key] = newDefaults[key]
  }
  const oldEnv = new Map<string, string>(
    (oldDefaults.Env ?? []).map((v: string) => [v.split('=')[0]!, v]),
  )
  const env = new Map<string, string>(
    (newDefaults.Env ?? []).map((v: string) => [v.split('=')[0]!, v]),
  )
  for (const value of original.Config.Env ?? []) {
    const key = value.split('=')[0]
    if (oldEnv.get(key) !== value) env.set(key, value)
  }
  runtime.Env = [...env.values()]
  if (runtime.Hostname === original.Id.slice(0, 12)) delete runtime.Hostname
  return {
    ...runtime,
    Image: image,
    ExposedPorts: { ...newDefaults.ExposedPorts, ...runtime.ExposedPorts },
    Volumes: { ...newDefaults.Volumes, ...runtime.Volumes },
    Labels: {
      ...newDefaults.Labels,
      ...original.Config.Labels,
      'kloud.project': job.project,
      'kloud.application': job.application,
      'kloud.run': job.id,
    },
    HostConfig: host,
    NetworkingConfig: { EndpointsConfig: endpoints },
  }
}

async function managedContainer(
  job: DeploymentJob,
  socket: string,
  serving?: string | null,
) {
  try {
    const container = await engine(
      socket,
      'GET',
      `/containers/${encodeURIComponent(serving ?? job.config.container_name)}/json`,
    )
    const labels = container.Config.Labels ?? {}
    if (
      labels['kloud.project'] !== job.project ||
      labels['kloud.application'] !== job.application ||
      labels['kloud.internal'] === 'true'
    )
      throw new Error('Managed deployment target belongs to another service')
    return container
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Docker GET failed (404):')
    )
      return null
    throw error
  }
}

export function initialContainerSpec(job: DeploymentJob, image: string) {
  return {
    Image: image,
    Labels: {
      'kloud.project': job.project,
      'kloud.application': job.application,
      'kloud.run': job.id,
    },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
  }
}

export async function replaceContainer(
  job: DeploymentJob,
  socket: string,
  signal: AbortSignal,
  log: (s: string) => void,
  imageOverride?: string,
  runtime?: RuntimeConfig,
  rollout?: RolloutContext,
) {
  if (!rollout)
    throw new Error(
      'Review the application deployment policy before deploying; downtime is never enabled implicitly',
    )
  if (rollout.policy.strategy === 'stop-first' && !rollout.policy.allowDowntime)
    throw new Error('Stop-before-start requires explicit downtime permission')
  const name = job.config.container_name
  const original = job.config.managed
    ? await managedContainer(job, socket, rollout.serving)
    : await engine(
        socket,
        'GET',
        `/containers/${encodeURIComponent(name)}/json`,
      )
  if (original?.Config.Labels?.['kloud.internal'] === 'true')
    throw new Error('Internal containers cannot be deployment targets')
  if (original?.Config.Labels?.['com.docker.compose.project'])
    throw new Error('Use Compose mode for Compose-managed containers')
  const image = imageOverride ?? `kloud/${job.deployment_id}:${job.commit}`
  if (rollout.policy.strategy === 'blue-green') {
    const newImage = await engine(
      socket,
      'GET',
      `/images/${encodeURIComponent(image)}/json`,
    )
    let spec = original
      ? replacementSpec(
          original,
          image,
          job,
          (
            await engine(
              socket,
              'GET',
              `/images/${encodeURIComponent(original.Image)}/json`,
            )
          ).Config,
          newImage.Config,
        )
      : {
          ...initialContainerSpec(job, image),
          Healthcheck: newImage.Config.Healthcheck,
          Volumes: newImage.Config.Volumes,
        }
    if (runtime)
      spec = applyRuntime(
        {
          ...spec,
          Env: newImage.Config.Env ?? [],
          Healthcheck: newImage.Config.Healthcheck,
        },
        runtime,
      )
    const driver = {
      inspect: (id: string) =>
        engine(socket, 'GET', `/containers/${encodeURIComponent(id)}/json`),
      create: async (candidate: string, value: any) =>
        (
          await engine(
            socket,
            'POST',
            `/containers/create?name=${encodeURIComponent(candidate)}`,
            value,
          )
        ).Id as string,
      start: async (id: string) => {
        await engine(socket, 'POST', `/containers/${id}/start`)
      },
      stop: async (id: string, seconds: number) => {
        await engine(socket, 'POST', `/containers/${id}/stop?t=${seconds}`)
      },
      remove: async (id: string) => {
        await engine(socket, 'DELETE', `/containers/${id}?force=true`)
      },
    }
    return runBlueGreen(
      driver,
      spec,
      `${name}-release-${job.id}`,
      original,
      rollout,
      signal,
      log,
    )
  }
  const journalPrevious = original ? `${name}-backup-${job.id}` : null
  await rollout.progress('prepared', name, journalPrevious)
  const completeStopFirst = async () => {
    const previous = journalPrevious
    try {
      await rollout.progress('started', name, previous)
      await rollout.progress('ready', name, previous)
      const deadline =
        Date.now() + rollout.policy.readiness.timeoutSeconds * 1000
      while (!(await rollout.progress('cutover', name, previous)).applied) {
        if (Date.now() > deadline)
          throw new Error('Proxy application timed out')
        await delay(1000, undefined, { signal })
      }
      await rollout.progress('serving', name, previous)
      await rollout.progress('retired', name, previous)
    } catch {
      await rollout.progress('uncertain', name, previous).catch(() => {})
      const { UncertainRolloutError } = await import('./rollout.js')
      throw new UncertainRolloutError(
        'Runtime changed but proxy outcome requires reconciliation',
      )
    }
  }
  if (!original) {
    signal.throwIfAborted()
    const created = await engine(
      socket,
      'POST',
      `/containers/create?name=${encodeURIComponent(name)}`,
      runtime
        ? applyRuntime(initialContainerSpec(job, image), runtime)
        : initialContainerSpec(job, image),
    )
    try {
      await engine(socket, 'POST', `/containers/${created.Id}/start`)
      await verifyStartup(socket, created.Id, signal)
    } catch (error) {
      await engine(socket, 'DELETE', `/containers/${created.Id}?force=true`)
      throw error
    }
    await completeStopFirst()
    return
  }
  const oldImage = await engine(
    socket,
    'GET',
    `/images/${encodeURIComponent(original.Image)}/json`,
  )
  const newImage = await engine(
    socket,
    'GET',
    `/images/${encodeURIComponent(image)}/json`,
  )
  let spec = replacementSpec(
    original,
    image,
    job,
    oldImage.Config,
    newImage.Config,
  )
  if (runtime)
    spec = applyRuntime(
      {
        ...spec,
        Env: newImage.Config.Env ?? [],
        Healthcheck: newImage.Config.Healthcheck,
      },
      runtime,
    )
  signal.throwIfAborted()
  const backup = `${name}-backup-${job.id}`
  let renamed = false,
    stopped = false,
    created: string | undefined
  try {
    if (original.State.Running) {
      await engine(socket, 'POST', `/containers/${original.Id}/stop?t=20`)
      stopped = true
    }
    await engine(
      socket,
      'POST',
      `/containers/${original.Id}/rename?name=${encodeURIComponent(backup)}`,
    )
    renamed = true
    created = (
      await engine(
        socket,
        'POST',
        `/containers/create?name=${encodeURIComponent(name)}`,
        spec,
      )
    ).Id
    await engine(socket, 'POST', `/containers/${created}/start`)
    const deadline = Date.now() + 60000
    while (true) {
      signal.throwIfAborted()
      const state = (await engine(socket, 'GET', `/containers/${created}/json`))
        .State
      if (!state.Running || state.Health?.Status === 'unhealthy')
        throw new Error('Replacement container failed its startup check')
      if (
        state.Health?.Status === 'healthy' ||
        (!state.Health && Date.now() > deadline - 55000)
      )
        break
      if (Date.now() > deadline)
        throw new Error('Replacement health check timed out')
      await delay(1000, undefined, { signal })
    }
  } catch (error) {
    log('\nDeployment failed; restoring the previous container.\n')
    if (created)
      await engine(socket, 'DELETE', `/containers/${created}?force=true`)
    if (renamed)
      await engine(
        socket,
        'POST',
        `/containers/${original.Id}/rename?name=${encodeURIComponent(original.Name?.replace(/^\//, '') ?? name)}`,
      )
    if (stopped)
      await engine(socket, 'POST', `/containers/${original.Id}/start`)
    throw error
  }
  await completeStopFirst()
  // Keep volumes; removing the stopped backup must never delete persistent data.
  try {
    await engine(socket, 'DELETE', `/containers/${original.Id}`)
  } catch {
    log(`\nDeployment succeeded; remove stopped backup ${backup} manually.\n`)
  }
}

export async function executeDeployment(
  job: DeploymentJob,
  config: ConnectorConfig,
  signal: AbortSignal,
  log: (s: string) => void,
  runtime?: RuntimeConfig,
  rollout?: RolloutContext,
  sourceAuth?: { token: string; url: string },
  buildInputs?: any,
) {
  if (!rollout)
    throw new Error(
      'Review and save the application deployment policy before building or deploying',
    )
  const project = await composeProject(job, config)
  const result = await sandboxBuild(
    job,
    config,
    project,
    signal,
    log,
    undefined,
    sourceAuth ?? job.source_auth,
    buildInputs,
  )
  await deployArtifact(
    job,
    config,
    result.directory,
    project,
    signal,
    log,
    runtime,
    undefined,
    rollout,
  )
  if (job.config.kind === 'dockerfile') {
    const image = await engine(
      config.dockerSocket,
      'GET',
      `/images/${encodeURIComponent(`kloud/${job.deployment_id}:${job.commit}`)}/json`,
    )
    await engine(
      config.dockerSocket,
      'POST',
      `/images/${encodeURIComponent(image.Id)}/tag?repo=kloud%2Fretained&tag=${job.id}`,
    )
    return {
      directory: result.directory,
      project,
      commit: job.commit,
      image: `kloud/retained:${job.id}`,
    }
  }
  const manifestPath = join(result.directory, 'output', 'compose.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  let index = 0
  for (const service of Object.values(manifest.services) as any[]) {
    const image = await engine(
      config.dockerSocket,
      'GET',
      `/images/${encodeURIComponent(service.image)}/json`,
    )
    const tag = `${job.id}-${index++}`
    await engine(
      config.dockerSocket,
      'POST',
      `/images/${encodeURIComponent(image.Id)}/tag?repo=kloud%2Fretained&tag=${tag}`,
    )
    service.image = `kloud/retained:${tag}`
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { directory: result.directory, project, commit: job.commit }
}

/** A supplied local checkout is also built exclusively inside the helper. */
export async function deployCheckout(
  job: DeploymentJob,
  config: ConnectorConfig,
  root: string,
  signal: AbortSignal,
  log: (s: string) => void,
) {
  const project = await composeProject(job, config)
  const result = await sandboxBuild(job, config, project, signal, log, root)
  await deployArtifact(job, config, result.directory, project, signal, log)
}

async function composeProject(job: DeploymentJob, config: ConnectorConfig) {
  if (job.config.kind !== 'compose' || job.config.managed)
    return `kloud-${job.deployment_id}`
  const target = await engine(
    config.dockerSocket,
    'GET',
    `/containers/${encodeURIComponent(job.config.container_name)}/json`,
  )
  const labels = target.Config.Labels ?? {}
  if (
    labels['kloud.internal'] === 'true' ||
    labels['com.docker.compose.service'] !== job.config.service ||
    !labels['com.docker.compose.project']
  )
    throw new Error('Target must belong to the configured Compose service')
  return labels['com.docker.compose.project'] as string
}

export async function deployArtifact(
  job: DeploymentJob,
  config: ConnectorConfig,
  directory: string,
  project: string,
  signal: AbortSignal,
  log: (s: string) => void,
  runtime?: RuntimeConfig,
  retainedImage?: string,
  rollout?: RolloutContext,
) {
  log('\nDeploying built artifacts on the service host.\n')
  if (job.config.kind === 'dockerfile')
    return replaceContainer(
      job,
      config.dockerSocket,
      signal,
      log,
      retainedImage,
      runtime,
      rollout,
    )
  if (
    !rollout ||
    (!rollout.policy.compose &&
      (rollout.policy.strategy !== 'stop-first' ||
        !rollout.policy.allowDowntime))
  )
    throw new Error(
      'This Compose stack requires a selective-service compatibility plan; explicitly allow downtime until candidate isolation is verified',
    )
  const manifest = JSON.parse(
    await readFile(join(directory, 'output', 'compose.json'), 'utf8'),
  )
  // Rebase source paths for retained runtime bind mounts. Compose's canonical
  // output already preserves escaped dollars and must not be escaped a second time.
  const rebase = (value: any): any => {
    if (typeof value === 'string')
      return value === '/workspace/repository' ||
        value.startsWith('/workspace/repository/')
        ? resolve(
            directory,
            'repository',
            value.slice('/workspace/repository'.length).replace(/^\//, ''),
          )
        : value
    if (Array.isArray(value)) return value.map(rebase)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, rebase(v)]),
      )
    return value
  }
  const file = join(directory, 'runtime-compose.json')
  let resolved = rebase(manifest)
  await writeFile(file, JSON.stringify(resolved), { mode: 0o600 })
  const envFile = join(directory, 'runtime.env')
  await writeFile(
    envFile,
    formatComposeEnvironment(runtime?.environment ?? {}),
    { mode: 0o600 },
  )
  const auth = join(directory, 'runtime-auth')
  const docker = ['--host', dockerHost(config.dockerSocket)]
  try {
    const registries = rollout.job?.config?.build_inputs?.registries ?? []
    if (registries.length) {
      await mkdir(auth, { mode: 0o700, recursive: true })
      await writeFile(
        join(auth, 'config.json'),
        JSON.stringify({
          auths: Object.fromEntries(
            registries.map((credentials: any) => [
              credentials.server,
              {
                auth: Buffer.from(
                  `${credentials.username}:${credentials.password}`,
                ).toString('base64'),
              },
            ]),
          ),
        }),
        { mode: 0o600 },
      )
      docker.unshift('--config', auth)
    }
    resolved = JSON.parse(
      await runComposeConfig(
        [
          ...docker,
          'compose',
          '--env-file',
          envFile,
          '--project-name',
          project,
          '--file',
          file,
          'config',
          '--format',
          'json',
        ],
        directory,
        signal,
      ),
    )
    await writeFile(file, JSON.stringify(resolved), { mode: 0o600 })
    for (const service of Object.values(resolved.services) as any[]) {
      if (service.pull_policy === 'never') continue
      await runCommand(
        'docker',
        [...docker, 'pull', service.image],
        directory,
        signal,
        log,
      )
    }
    if (rollout.policy.compose)
      return await applyComposeRelease({
        model: resolved,
        file,
        directory,
        project,
        job: rollout.job ?? job,
        connector: config,
        context: rollout,
        signal,
        log,
        escaped: true,
        dockerPrefix: docker,
      })
    const args = [
      ...docker,
      'compose',
      '--project-name',
      project,
      '--file',
      file,
      'up',
      '--detach',
      '--no-build',
      '--wait',
      '--wait-timeout',
      String(rollout.policy.readiness.timeoutSeconds),
    ]
    if (!job.config.managed)
      args.push('--no-deps', '--force-recreate', job.config.service)
    await runCommand('docker', args, directory, signal, log)
  } finally {
    await rm(auth, { recursive: true, force: true })
    await rm(file, { force: true })
    await rm(envFile, { force: true })
  }
}

async function verifyStartup(socket: string, id: string, signal: AbortSignal) {
  const deadline = Date.now() + 60000
  while (true) {
    signal.throwIfAborted()
    const state = (await engine(socket, 'GET', `/containers/${id}/json`)).State
    if (!state.Running || state.Health?.Status === 'unhealthy')
      throw new Error('Container failed its startup check')
    if (
      state.Health?.Status === 'healthy' ||
      (!state.Health && Date.now() > deadline - 55000)
    )
      return
    if (Date.now() > deadline)
      throw new Error('Container health check timed out')
    await delay(1000, undefined, { signal })
  }
}

export async function deploymentWorker(
  config: ConnectorConfig,
  signal: AbortSignal,
) {
  let lastCleanup = 0
  const post = async (path: string, body?: unknown) => {
    const response = await fetch(new URL(path, config.apiUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    })
    if (!response.ok)
      throw new Error(`Deployment API returned ${response.status}`)
    return response.json() as Promise<any>
  }
  while (!signal.aborted) {
    try {
      if (Date.now() - lastCleanup > 5 * 60 * 1000) {
        await cleanupExpiredBuilds(config, (s) => console.log(s.trim()))
        lastCleanup = Date.now()
      }
      const { job: raw } = await post('connectors/deployments/claim')
      if (raw) {
        const job = deploymentJobSchema.parse(raw)
        let log = '',
          status: 'succeeded' | 'failed' = 'succeeded'
        try {
          await executeDeployment(
            job,
            config,
            AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]),
            (value) => {
              log = (log + value).slice(-48000)
            },
          )
        } catch (error) {
          status = 'failed'
          log = (
            log +
            '\n' +
            (error instanceof Error ? error.message : 'Deployment failed')
          ).slice(-48000)
        }
        // Retry reporting, never the deployment itself after an ambiguous failure.
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await post(`connectors/deployments/${job.id}/result`, {
              status,
              log,
            })
            break
          } catch (error) {
            if (attempt === 4) throw error
            await delay(2000, undefined, { signal })
          }
        }
      }
    } catch (error) {
      if (!signal.aborted)
        console.error(
          'Deployment worker:',
          error instanceof Error ? error.message : 'Unknown error',
        )
    }
    await delay(5000, undefined, { signal }).catch(() => {})
  }
}
