import { setTimeout as delay } from 'node:timers/promises'
import type { DeploymentPolicy } from '@kloud/protocol/platform'

export type RolloutStage =
  | 'prepared'
  | 'dependency-restart'
  | 'dependencies'
  | 'started'
  | 'ready'
  | 'cutover'
  | 'serving'
  | 'retired'
  | 'failed'
  | 'uncertain'
export interface ComposeReleaseDetails {
  targets: Record<
    string,
    {
      candidate: string
      previous: string | null
      original: string
      action: 'redeploy' | 'restart'
      stopGraceSeconds?: number
    }
  >
  commits: Record<string, string>
  hashes: Record<string, string>
  images: Record<string, string>
  dependencies: string[]
  directory?: string
  project?: string
}
export interface RolloutContext {
  compose?: ComposeReleaseDetails
  job?: any
  policy: DeploymentPolicy
  serving?: string | null
  progress: (
    stage: RolloutStage,
    candidate: string,
    previous: string | null,
  ) => Promise<{ applied?: boolean }>
  httpProbe: (
    candidate: string,
    probe: NonNullable<DeploymentPolicy['readiness']['http']>,
    signal: AbortSignal,
  ) => Promise<boolean>
}
export interface RolloutDriver {
  inspect: (name: string) => Promise<any>
  create: (name: string, spec: any) => Promise<string>
  start: (id: string) => Promise<void>
  stop: (id: string, seconds: number) => Promise<void>
  remove: (id: string) => Promise<void>
}
export class UncertainRolloutError extends Error {
  readonly uncertain = true
}
export function assertOverlap(spec: any, reviewed: boolean) {
  if (!reviewed)
    throw new Error(
      'Review blue/green compatibility before replacing this existing application',
    )
  const host = spec.HostConfig ?? {}
  if (
    Object.keys(host.PortBindings ?? {}).length ||
    spec.HostConfig?.PublishAllPorts
  )
    throw new Error(
      'Blue/green cannot overlap fixed host ports; use managed HTTP routing or explicitly allow downtime',
    )
  if (
    ['host', 'none'].includes(host.NetworkMode) ||
    host.NetworkMode?.startsWith('container:')
  )
    throw new Error('Blue/green requires isolated container networking')
  if (
    (host.Mounts ?? []).some((v: any) => !v.ReadOnly) ||
    (host.Binds ?? []).some((v: string) => !v.endsWith(':ro')) ||
    Object.keys(spec.Volumes ?? {}).length
  )
    throw new Error(
      'Blue/green cannot overlap writable volumes; resolve exclusive writers or explicitly allow downtime',
    )
  if (
    Object.values(spec.NetworkingConfig?.EndpointsConfig ?? {}).some(
      (v: any) => v.IPAMConfig?.IPv4Address || v.IPAMConfig?.IPv6Address,
    )
  )
    throw new Error('Blue/green cannot overlap fixed container addresses')
}
export function candidateSpec(spec: any, candidate: string) {
  const next = structuredClone(spec)
  next.Hostname = candidate
  next.Labels = { ...next.Labels, 'kloud.release': candidate }
  for (const endpoint of Object.values(
    next.NetworkingConfig?.EndpointsConfig ?? {},
  ) as any[]) {
    endpoint.Aliases = [candidate]
    delete endpoint.IPAMConfig
  }
  return next
}
export async function waitReadiness(
  driver: RolloutDriver,
  candidate: string,
  context: RolloutContext,
  signal: AbortSignal,
  log: (text: string) => void,
  heartbeat?: () => Promise<unknown>,
) {
  const readiness = context.policy.readiness
  if (!readiness.dockerHealth && !readiness.http)
    throw new Error(
      'Blue/green requires Docker health checks and/or an HTTP probe',
    )
  const deadline = Date.now() + readiness.timeoutSeconds * 1000
  while (Date.now() <= deadline) {
    signal.throwIfAborted()
    if (heartbeat) await heartbeat()
    const state = (await driver.inspect(candidate)).State
    if (!state.Running)
      throw new Error('Candidate stopped before becoming ready')
    const dockerReady =
      !readiness.dockerHealth || state.Health?.Status === 'healthy'
    const httpReady =
      !readiness.http ||
      (await context.httpProbe(
        candidate,
        readiness.http,
        AbortSignal.any([
          signal,
          AbortSignal.timeout(
            Math.min(
              readiness.http.timeoutSeconds * 1000,
              Math.max(1, deadline - Date.now()),
            ),
          ),
        ]),
      ))
    if (dockerReady && httpReady && Date.now() <= deadline) return
    log(
      `Readiness pending: Docker=${dockerReady ? 'ready' : 'not ready'}, HTTP=${httpReady ? 'ready' : 'not ready'}.\n`,
    )
    await delay(
      Math.min(
        readiness.intervalSeconds * 1000,
        Math.max(1, deadline - Date.now()),
      ),
      undefined,
      { signal },
    )
  }
  throw new Error(
    'Candidate readiness timed out; previous release remains active',
  )
}
export async function runBlueGreen(
  driver: RolloutDriver,
  spec: any,
  candidate: string,
  original: any | null,
  context: RolloutContext,
  signal: AbortSignal,
  log: (text: string) => void,
) {
  const previous = original?.Name?.replace(/^\//, '') ?? null
  if (original) assertOverlap(spec, context.policy.compatibilityReviewed)
  else if (Object.keys(spec.HostConfig?.PortBindings ?? {}).length)
    throw new Error(
      'Blue/green requires managed routing instead of published host ports',
    )
  if (
    context.policy.readiness.dockerHealth &&
    (!spec.Healthcheck || spec.Healthcheck.Test?.[0] === 'NONE')
  )
    throw new Error(
      'Configure a Docker health check or HTTP readiness probe before blue/green deployment',
    )
  await context.progress('prepared', candidate, previous)
  let created: string | undefined,
    switching = false
  try {
    created = await driver.create(candidate, candidateSpec(spec, candidate))
    await driver.start(created)
    await context.progress('started', candidate, previous)
    await waitReadiness(driver, created, context, signal, log, () =>
      context.progress('started', candidate, previous),
    )
    await context.progress('ready', candidate, previous)
    switching = true
    const switchDeadline =
      Date.now() + context.policy.readiness.timeoutSeconds * 1000
    while (true) {
      signal.throwIfAborted()
      if ((await context.progress('cutover', candidate, previous)).applied)
        break
      if (Date.now() > switchDeadline)
        throw new Error('Managed proxy cutover was not confirmed')
      await delay(1000, undefined, { signal })
    }
    await context.progress('serving', candidate, previous)
    if (original) {
      await driver.stop(original.Id, context.policy.stopGraceSeconds)
      await driver.remove(original.Id)
    }
    await context.progress('retired', candidate, previous)
  } catch (error) {
    if (switching) {
      await context.progress('uncertain', candidate, previous).catch(() => {})
      throw new UncertainRolloutError(
        'Cutover outcome requires reconciliation; both releases were preserved',
      )
    }
    if (created) await driver.remove(created).catch(() => {})
    await context.progress('failed', candidate, previous).catch(() => {})
    throw error
  }
}
