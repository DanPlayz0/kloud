import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import {
  platformConfigSchema,
  type RuntimeConfig,
} from '@dedi-dash/protocol/platform'
import type { DeploymentJob } from '@dedi-dash/protocol'
import type { ConnectorConfig } from './config.js'
import { engine, runCommand, dockerHost } from './deployment-process.js'
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
      config: {
        ...desired.source.config,
        connector_id: desired.connector_id,
        managed: true,
        container_name: `dedi-${job.project}-${job.service}`,
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
      )
      return job.artifacts
    }
    return executeDeployment(gitJob, config, signal, log, desired.runtime)
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
    if (desired.source.type === 'image') {
      log(
        job.artifacts
          ? 'Using retained image for rollback.\n'
          : 'Pulling registry image.\n',
      )
      if (desired.source.registry) {
        await mkdir(auth, { mode: 0o700 })
        const credentials = desired.source.registry
        await writeFile(
          join(auth, 'config.json'),
          JSON.stringify({
            auths: {
              [credentials.server]: {
                auth: Buffer.from(
                  `${credentials.username}:${credentials.password}`,
                ).toString('base64'),
              },
            },
          }),
          { mode: 0o600 },
        )
        docker.unshift('--config', auth)
      }
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
          container_name: `dedi-${job.project}-${job.service}`,
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
      )
      await engine(
        config.dockerSocket,
        'POST',
        `/images/${encodeURIComponent(inspected.Id)}/tag?repo=dedi-dash%2Fretained&tag=${job.id}`,
      )
      return { image: `dedi-dash/retained:${job.id}` }
    }
    const source = join(directory, 'compose.yaml')
    log('Validating Compose definition.\n')
    await writeFile(source, desired.source.content, { mode: 0o600 })
    const prefix = [
      ...docker,
      'compose',
      '--project-name',
      `dedi-${job.project}-${job.service}`,
      '--file',
      source,
    ]
    const parsed = JSON.parse(
      await runCommand(
        'docker',
        [...prefix, 'config', '--format', 'json'],
        directory,
        signal,
        () => {},
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
        'dedi-dash.project': job.project,
        'dedi-dash.application': job.service,
      }
      if (job.artifacts?.[name]) service.image = job.artifacts[name]
    }
    const runtime = join(directory, 'runtime.json')
    // Compose interpolation must not process literal dollars from canonical output again.
    const escape = (v: any): any =>
      typeof v === 'string'
        ? v.replaceAll('$', '$$')
        : Array.isArray(v)
          ? v.map(escape)
          : v && typeof v === 'object'
            ? Object.fromEntries(
                Object.entries(v).map(([k, x]) => [k, escape(x)]),
              )
            : v
    await writeFile(runtime, JSON.stringify(escape(parsed)), { mode: 0o600 })
    const args = [
      ...docker,
      'compose',
      '--project-name',
      `dedi-${job.project}-${job.service}`,
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
      const pinned = `dedi-dash/retained:${job.id}-${name}`
      await engine(
        config.dockerSocket,
        'POST',
        `/images/${encodeURIComponent(image.Id)}/tag?repo=dedi-dash%2Fretained&tag=${encodeURIComponent(`${job.id}-${name}`)}`,
      )
      artifacts[name] = pinned
      service.image = pinned
    }
    await writeFile(runtime, JSON.stringify(escape(parsed)), { mode: 0o600 })
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
    for (const file of ['compose.yaml', 'runtime.json'])
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
          ])
            if (typeof secret === 'string' && secret.length)
              text = text.split(secret).join('[redacted]')
          output = (output + text).slice(-47000)
        }
        try {
          result = {
            status: 'succeeded',
            log: '',
            artifacts: await executeServiceRun(
              job,
              config,
              AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]),
              log,
            ),
          }
          result.log =
            output +
            '\nDeployment completed. Check runtime health in Containers.'
        } catch {
          result = {
            status: 'failed',
            log:
              output +
              '\nDeployment failed. Check host connectivity, source credentials, image availability, and runtime configuration. Volumes were retained.',
            artifacts: null,
          }
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
