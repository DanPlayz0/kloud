import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import {
  platformConfigSchema,
  type RuntimeConfig,
} from '@kloud/protocol/platform'
import type { DeploymentJob } from '@kloud/protocol'
import {
  applyComposeRelease,
  SkippedDeployment,
  reconcileComposeRelease,
} from './compose-rollout.js'
import { type RolloutContext, UncertainRolloutError } from './rollout.js'
import type { ConnectorConfig } from './config.js'
import { formatComposeEnvironment } from './compose-environment.js'
import {
  engine,
  runCommand,
  runComposeConfig,
  dockerHost,
} from './deployment-process.js'
import {
  replaceContainer,
  executeDeployment,
  deployArtifact,
} from './deployments.js'

export function applyRuntime(spec: any, runtime: RuntimeConfig) {
  const ports = Object.fromEntries(
    runtime.ports.map((p) => [
      `${p.container}/${p.protocol}`,
      [{ HostIp: '0.0.0.0', HostPort: String(p.host) }],
    ]),
  )
  const defaults = new Map<string, string>(
    (spec.Env ?? []).map((v: string) => [v.split('=')[0]!, v]),
  )
  for (const [k, v] of Object.entries(runtime.environment))
    defaults.set(k, `${k}=${v}`)
  return {
    ...spec,
    Env: [...defaults.values()],
    ExposedPorts: Object.fromEntries(
      runtime.ports.map((p) => [`${p.container}/${p.protocol}`, {}]),
    ),
    ...(runtime.healthcheck
      ? {
          Healthcheck: {
            Test: ['CMD', ...runtime.healthcheck.command],
            Interval: runtime.healthcheck.intervalSeconds * 1e9,
          },
        }
      : {}),
    HostConfig: {
      ...spec.HostConfig,
      PortBindings: ports,
      RestartPolicy: { Name: runtime.restart },
      Mounts: [
        ...(spec.HostConfig?.Mounts ?? []).filter(
          (v: any) =>
            /^[a-f0-9]{64}$/.test(v.Source ?? '') &&
            !runtime.volumes.some((next) => next.target === v.Target),
        ),
        ...runtime.volumes.map((v) => ({
          Type: 'volume',
          Source: v.source,
          Target: v.target,
          ReadOnly: v.readOnly,
        })),
      ],
      Binds: [],
      Memory: runtime.memoryMb ? runtime.memoryMb * 1024 * 1024 : 0,
      NanoCpus: runtime.cpus ? runtime.cpus * 1e9 : 0,
    },
    NetworkingConfig: {
      EndpointsConfig: Object.fromEntries(runtime.networks.map((n) => [n, {}])),
    },
  }
}

export async function executeServiceRun(
  job: any,
  config: ConnectorConfig,
  signal: AbortSignal,
  log: (text: string) => void = () => {},
) {
  const desired = platformConfigSchema.parse(job.config)
  if (!desired.deployment)
    throw new Error(
      'Review and save this application deployment policy before deploying',
    )
  if (
    desired.deployment.readiness.http ||
    Object.values(desired.deployment.compose?.services ?? {}).some(
      (value) => value.http,
    )
  ) {
    try {
      await engine(
        config.dockerSocket,
        'GET',
        `/images/${encodeURIComponent(config.buildHelperImage)}/json`,
      )
    } catch {
      throw new Error(
        `HTTP readiness requires the configured helper image ${config.buildHelperImage}. Install it on this host before deployment.`,
      )
    }
  }
  const rollout = rolloutContext(job, desired.deployment, config, signal)
  if (job.reconcile)
    return reconcileServiceRun(job, config, rollout, signal, log)
  log('Preparing saved service revision.\n')
  if (desired.source.type === 'github') {
    const identity = createHash('sha256')
      .update(`${job.project}/${job.service}`)
      .digest('hex')
      .slice(0, 32)
    const stable = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20)}`
    const gitJob: DeploymentJob = {
      id: job.id,
      deployment_id: stable,
      project: job.project,
      application: job.service,
      commit: job.artifacts?.commit ?? job.commit,
      watch_baselines: job.compose_state?.commits,
      config: {
        ...desired.source.config,
        connector_id: desired.connector_id,
        managed: true,
        container_name: `kloud-${job.project}-${job.service}`,
      },
    }
    if (!/^[a-f0-9]{40}$/.test(gitJob.commit))
      throw new Error('Invalid commit SHA')
    if (job.artifacts) {
      await deployArtifact(
        gitJob,
        config,
        job.artifacts.directory,
        job.artifacts.project,
        signal,
        log,
        desired.runtime,
        job.artifacts.image,
        rollout,
      )
      return job.artifacts
    }
    return executeDeployment(
      gitJob,
      config,
      signal,
      log,
      desired.runtime,
      rollout,
      job.source_auth,
      desired.build_inputs,
    )
  }
  const directory = resolve(
    config.deploymentsDir,
    'services',
    job.project,
    job.service,
    job.id,
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const docker = ['--host', dockerHost(config.dockerSocket)]
  const auth = join(directory, 'auth')
  try {
    const registries = [
      ...(desired.build_inputs?.registries ?? []),
      ...(desired.source.type === 'image' && desired.source.registry
        ? [desired.source.registry]
        : []),
    ]
    if (registries.length) {
      await mkdir(auth, { mode: 0o700 })
      await writeFile(
        join(auth, 'config.json'),
        JSON.stringify({
          auths: Object.fromEntries(
            registries.map((credentials) => [
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
    if (desired.source.type === 'image') {
      log(
        job.artifacts
          ? 'Using retained image for rollback.\n'
          : 'Pulling registry image.\n',
      )
      const image = job.artifacts?.image ?? desired.source.image
      if (!job.artifacts)
        await runCommand(
          'docker',
          [...docker, 'pull', image],
          directory,
          signal,
          () => {},
        )
      const inspected = await engine(
        config.dockerSocket,
        'GET',
        `/images/${encodeURIComponent(image)}/json`,
      )
      const jobSpec: DeploymentJob = {
        id: job.id,
        deployment_id: job.revision,
        project: job.project,
        application: job.service,
        commit: '0'.repeat(40),
        config: {
          connector_id: desired.connector_id,
          container_name: `kloud-${job.project}-${job.service}`,
          managed: true,
          kind: 'dockerfile',
          repository: 'unused/unused',
          branch: 'main',
          build_file: 'Dockerfile',
          context: '.',
          service: 'app',
          enabled: true,
        },
      }
      await replaceContainer(
        jobSpec,
        config.dockerSocket,
        signal,
        () => {},
        inspected.Id,
        desired.runtime,
        rollout,
      )
      await engine(
        config.dockerSocket,
        'POST',
        `/images/${encodeURIComponent(inspected.Id)}/tag?repo=kloud%2Fretained&tag=${job.id}`,
      )
      return { image: `kloud/retained:${job.id}` }
    }
    if (
      !desired.deployment.compose &&
      (desired.deployment.strategy !== 'stop-first' ||
        !desired.deployment.allowDowntime)
    )
      throw new Error(
        'This Compose stack requires a verified selective-service compatibility plan; blue/green never duplicates database dependencies',
      )
    const source = join(directory, 'compose.yaml')
    log('Validating Compose definition.\n')
    await writeFile(source, desired.source.content, { mode: 0o600 })
    const envFile = join(directory, 'runtime.env')
    await writeFile(
      envFile,
      formatComposeEnvironment(desired.runtime.environment),
      { mode: 0o600 },
    )
    const prefix = [
      ...docker,
      'compose',
      '--env-file',
      envFile,
      '--project-name',
      `kloud-${job.project}-${job.service}`,
      '--file',
      source,
    ]
    const parsed = JSON.parse(
      await runComposeConfig(
        [...prefix, 'config', '--format', 'json'],
        directory,
        signal,
      ),
    )
    if (!Object.keys(parsed.services ?? {}).length)
      throw new Error('Compose must define at least one service')
    for (const [name, service] of Object.entries(parsed.services) as [
      string,
      any,
    ][]) {
      if (service.build)
        throw new Error(
          'Pasted Compose must use images; use Git Compose for repository builds',
        )
      if (!service.image)
        throw new Error('Every Compose service requires an image')
      // No user-defined bind paths relative to a secret revision directory.
      if (
        service.volumes?.some(
          (v: any) => v.type === 'bind' && !String(v.source).startsWith('/'),
        )
      )
        throw new Error('Use named volumes or absolute bind paths')
      service.labels = {
        ...service.labels,
        'kloud.project': job.project,
        'kloud.application': job.service,
      }
      if (job.artifacts?.[name]) service.image = job.artifacts[name]
    }
    const runtime = join(directory, 'runtime.json')
    // Compose's canonical JSON already escapes literal dollars for a second parse.
    await writeFile(runtime, JSON.stringify(parsed), { mode: 0o600 })
    const args = [
      ...docker,
      'compose',
      '--project-name',
      `kloud-${job.project}-${job.service}`,
      '--file',
      runtime,
    ]
    log(
      job.artifacts
        ? 'Using retained Compose images.\n'
        : 'Pulling Compose images.\n',
    )
    if (!job.artifacts)
      await runCommand('docker', [...args, 'pull'], directory, signal, () => {})
    const artifacts: Record<string, string> = {}
    for (const [name, service] of Object.entries(parsed.services) as [
      string,
      any,
    ][]) {
      const image = await engine(
        config.dockerSocket,
        'GET',
        `/images/${encodeURIComponent(service.image)}/json`,
      )
      const pinned = `kloud/retained:${job.id}-${name}`
      await engine(
        config.dockerSocket,
        'POST',
        `/images/${encodeURIComponent(image.Id)}/tag?repo=kloud%2Fretained&tag=${encodeURIComponent(`${job.id}-${name}`)}`,
      )
      artifacts[name] = pinned
      service.image = pinned
    }
    await writeFile(runtime, JSON.stringify(parsed), { mode: 0o600 })
    if (desired.deployment.compose) {
      await applyComposeRelease({
        model: parsed,
        file: runtime,
        directory,
        project: `kloud-${job.project}-${job.service}`,
        job,
        connector: config,
        context: rollout,
        signal,
        log,
        escaped: true,
        dockerPrefix: docker,
      })
      return artifacts
    }
    log('Applying Compose stack and waiting for startup checks.\n')
    await runCommand(
      'docker',
      [
        ...args,
        'up',
        '--detach',
        '--no-build',
        '--wait',
        '--wait-timeout',
        '60',
      ],
      directory,
      signal,
      () => {},
    )
    return artifacts
  } finally {
    await rm(auth, { recursive: true, force: true })
    // Canonical runtime definitions can contain secrets; keep only encrypted API revisions.
    for (const file of ['compose.yaml', 'runtime.json', 'runtime.env'])
      await rm(join(directory, file), { force: true })
  }
}

export async function serviceWorker(
  config: ConnectorConfig,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    try {
      const { job } = await platformPost(config, 'claim', {}, signal)
      if (job) {
        let result: any
        let output = ''
        const log = (text: string) => {
          for (const secret of [
            ...Object.values(job.config.runtime?.environment ?? {}),
            job.config.source?.registry?.password,
            config.githubToken,
            job.source_auth?.token,
            ...Object.values(job.config.build_inputs?.secrets ?? {}),
            ...(job.config.build_inputs?.registries ?? []).map(
              (v: any) => v.password,
            ),
          ])
            if (typeof secret === 'string' && secret.length)
              text = text.split(secret).join('[redacted]')
          output = (output + text).slice(-47000)
        }
        const lease = new AbortController()
        const executionSignal = AbortSignal.any([
          signal,
          lease.signal,
          AbortSignal.timeout(30 * 60 * 1000),
        ])
        let heartbeatBusy = false
        const heartbeat = setInterval(async () => {
          if (heartbeatBusy || executionSignal.aborted) return
          heartbeatBusy = true
          try {
            const response = await platformPost(
              config,
              `${job.id}/heartbeat`,
              {},
              executionSignal,
            )
            if (!response.ok) lease.abort()
          } catch {
            lease.abort()
          } finally {
            heartbeatBusy = false
          }
        }, 10000)
        try {
          result = {
            status: 'succeeded',
            log: '',
            artifacts: await executeServiceRun(
              job,
              config,
              executionSignal,
              log,
            ),
          }
          result.log =
            output +
            '\nDeployment completed. Check runtime health in Containers.'
        } catch (error) {
          log(
            `\n${error instanceof Error ? error.message : 'Deployment failed'}\n`,
          )
          result = {
            status: 'failed',
            log:
              output +
              '\nDeployment failed. Check host connectivity, source credentials, image availability, and runtime configuration. Volumes were retained.',
            artifacts: null,
          }
          if (error instanceof UncertainRolloutError) result.uncertain = true
          if (error instanceof SkippedDeployment)
            result = {
              status: 'skipped',
              log:
                output + '\nNo selected Compose service matched changed paths.',
              artifacts: null,
            }
          if (lease.signal.aborted) result.uncertain = true
        } finally {
          clearInterval(heartbeat)
        }
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await platformPost(config, `${job.id}/result`, result, signal)
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
          'Service worker:',
          error instanceof Error ? error.message : 'Unavailable',
        )
    }
    await delay(5000, undefined, { signal }).catch(() => {})
  }
}
export async function platformPost(
  config: ConnectorConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<any> {
  const response = await fetch(
    new URL(`connectors/platform/${path}`, config.apiUrl),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    },
  )
  if (!response.ok) throw new Error(`Platform API returned ${response.status}`)
  return response.json()
}

function rolloutContext(
  job: any,
  policy: import('@kloud/protocol/platform').DeploymentPolicy,
  config: ConnectorConfig,
  signal: AbortSignal,
): RolloutContext {
  const context: RolloutContext = {
    policy,
    job,
    serving: job.serving ?? null,
    progress: (stage, candidate, previous) =>
      platformPost(
        config,
        `${job.id}/rollout`,
        {
          stage,
          candidate,
          previous,
          ...(context.compose ? { compose: context.compose } : {}),
        },
        signal,
      ),
    httpProbe: async (candidate, probe, probeSignal) => {
      let id: string | undefined
      try {
        const script =
          "try { const response = await fetch(process.argv[1], {redirect:'manual',signal:AbortSignal.timeout(Number(process.argv[2]))}); process.exit(response.status >= 200 && response.status <= 299 ? 0 : 1) } catch { process.exit(1) }"
        id = (
          await engine(config.dockerSocket, 'POST', '/containers/create', {
            Image: config.buildHelperImage,
            Cmd: [
              'node',
              '--input-type=module',
              '-e',
              script,
              `http://127.0.0.1:${probe.port}${probe.path}`,
              String(probe.timeoutSeconds * 1000),
            ],
            Labels: {
              'kloud.internal': 'true',
              'kloud.role': 'readiness-probe',
              'kloud.run': job.id,
            },
            HostConfig: {
              NetworkMode: `container:${candidate}`,
              ReadonlyRootfs: true,
              CapDrop: ['ALL'],
              SecurityOpt: ['no-new-privileges'],
              Memory: 64 * 1024 * 1024,
              PidsLimit: 32,
            },
          })
        ).Id
        await engine(config.dockerSocket, 'POST', `/containers/${id}/start`)
        while (!probeSignal.aborted) {
          const state = (
            await engine(config.dockerSocket, 'GET', `/containers/${id}/json`)
          ).State
          if (state.Status === 'exited') return state.ExitCode === 0
          await delay(100, undefined, { signal: probeSignal })
        }
        return false
      } catch {
        return false
      } finally {
        if (id)
          await engine(
            config.dockerSocket,
            'DELETE',
            `/containers/${id}?force=true`,
          ).catch(() => {})
      }
    },
  }
  return context
}

async function reconcileServiceRun(
  job: any,
  config: ConnectorConfig,
  context: RolloutContext,
  signal: AbortSignal,
  log: (text: string) => void,
) {
  const details = job.reconcile
  if (details.details?.targets) {
    context.compose = details.details
    return reconcileComposeRelease(job, config, context, signal, log)
  }
  const inspect = async (name: string | null) => {
    if (!name) return null
    try {
      const value = await engine(
        config.dockerSocket,
        'GET',
        `/containers/${encodeURIComponent(name)}/json`,
      )
      if (
        value.Config.Labels?.['kloud.project'] !== job.project ||
        value.Config.Labels?.['kloud.application'] !== job.service
      )
        throw new Error('Release ownership changed')
      return value
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Docker GET failed (404):')
      )
        return null
      throw error
    }
  }
  let candidate = await inspect(details.candidate)
  if (candidate && candidate.Config.Labels?.['kloud.run'] !== job.id)
    candidate = null
  const previous = await inspect(details.previous)
  if (details.stage === 'failed') {
    if (candidate)
      await engine(
        config.dockerSocket,
        'DELETE',
        `/containers/${candidate.Id}?force=true`,
      )
    throw new Error(
      'Interrupted candidate already failed before cutover; previous release was preserved',
    )
  }
  if (details.stage === 'retired' && candidate?.State.Running)
    return { image: candidate.Image, commit: job.commit ?? '0'.repeat(40) }
  if (
    ['prepared', 'started', 'failed'].includes(details.stage) &&
    !candidate?.State.Running
  ) {
    await context.progress('failed', details.candidate, details.previous)
    throw new Error(
      'Interrupted candidate startup failed; previous release was preserved',
    )
  }
  if (candidate?.State.Running) {
    try {
      if (details.stage === 'failed')
        throw new Error('This candidate already failed before cutover')
      const { waitReadiness } = await import('./rollout.js')
      const driver = {
        inspect: async (id: string) =>
          engine(config.dockerSocket, 'GET', `/containers/${id}/json`),
        create: async () => '',
        start: async () => {},
        stop: async () => {},
        remove: async () => {},
      }
      await waitReadiness(driver, candidate.Id, context, signal, log)
      if (details.stage === 'prepared')
        await context.progress('started', details.candidate, details.previous)
      if (['prepared', 'started'].includes(details.stage))
        await context.progress('ready', details.candidate, details.previous)
      const deadline =
        Date.now() + context.policy.readiness.timeoutSeconds * 1000
      while (
        !(
          await context.progress('cutover', details.candidate, details.previous)
        ).applied
      ) {
        if (Date.now() > deadline)
          throw new Error('Proxy reconciliation timed out')
        await delay(1000, undefined, { signal })
      }
      await context.progress('serving', details.candidate, details.previous)
      if (previous) {
        await engine(
          config.dockerSocket,
          'POST',
          `/containers/${previous.Id}/stop?t=${context.policy.stopGraceSeconds}`,
        )
        await engine(
          config.dockerSocket,
          'DELETE',
          `/containers/${previous.Id}`,
        )
      }
      await context.progress('retired', details.candidate, details.previous)
      return { image: candidate.Image, commit: job.commit ?? '0'.repeat(40) }
    } catch (error) {
      // A still-running prior release can recover a failed candidate, but only after confirmed routing.
      if (!previous?.State.Running)
        throw new UncertainRolloutError(
          'Candidate reconciliation failed and no running previous release is available',
        )
    }
  }
  if (!previous?.State.Running)
    throw new UncertainRolloutError(
      'Neither release can establish a known serving state',
    )
  const deadline = Date.now() + context.policy.readiness.timeoutSeconds * 1000
  while (
    !(
      await platformPost(
        config,
        `${job.id}/reconcile`,
        {
          previous_running: true,
          candidate_running: !!candidate?.State.Running,
        },
        signal,
      )
    ).applied
  ) {
    if (Date.now() > deadline)
      throw new UncertainRolloutError(
        'Previous release routing could not be confirmed',
      )
    await delay(1000, undefined, { signal })
  }
  if (candidate)
    await engine(
      config.dockerSocket,
      'DELETE',
      `/containers/${candidate.Id}?force=true`,
    )
  throw new Error(
    'Failed candidate was retired after restoring the known previous release',
  )
}
