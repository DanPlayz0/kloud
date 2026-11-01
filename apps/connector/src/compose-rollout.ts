import { createHash } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  affected,
  protectedConfigHash,
  composeCandidateModel,
  stopGraceSeconds,
} from './compose-plan.js'
import { engine, runCommand, dockerHost } from './deployment-process.js'
import { UncertainRolloutError, type RolloutContext } from './rollout.js'
import type { ConnectorConfig } from './config.js'
export class SkippedDeployment extends Error {}
export async function applyComposeRelease(options: {
  model: any
  file: string
  directory: string
  project: string
  job: any
  connector: ConnectorConfig
  context: RolloutContext
  signal: AbortSignal
  log: (text: string) => void
  escaped: boolean
  dockerPrefix?: string[]
}) {
  const {
    model,
    file,
    directory,
    project,
    job,
    connector,
    context,
    signal,
    log,
  } = options
  const rules = context.policy.compose?.services
  if (!rules || !Object.keys(rules).length)
    throw new Error(
      'Select the replaceable Compose services and review their watch paths before enabling selective releases',
    )
  const bluegreen = context.policy.strategy === 'blue-green'
  if (bluegreen && !context.policy.compatibilityReviewed)
    throw new Error(
      'Review Compose candidate isolation and schema compatibility before blue/green',
    )
  const current = job.compose_state ?? {}
  let changes: Record<string, string[] | null> = {}
  try {
    changes = JSON.parse(
      await readFile(join(directory, 'output', 'changes.json'), 'utf8'),
    )
  } catch {}
  const definitions =
    job.config?.source?.type === 'github'
      ? [job.config.source.config.build_file]
      : []
  const selected = Object.keys(rules).filter((name) =>
    affected(rules[name]!, changes[name], definitions, !!job.manual),
  )
  if (!selected.length)
    throw new SkippedDeployment(
      'No selected Compose service matched changed repository paths',
    )
  const docker = options.dockerPrefix ?? [
    '--host',
    dockerHost(connector.dockerSocket),
  ]
  const prefix = [
    ...docker,
    'compose',
    '--project-name',
    project,
    '--file',
    file,
  ]
  const run = (args: string[]) =>
    runCommand('docker', args, directory, signal, log)
  const inspect = async (name: string) => {
    try {
      const runtime = await engine(
        connector.dockerSocket,
        'GET',
        `/containers/${encodeURIComponent(name)}/json`,
      )
      if (
        runtime.Config.Labels?.['kloud.project'] !== job.project ||
        runtime.Config.Labels?.['kloud.application'] !==
          (job.service ?? job.application) ||
        runtime.Config.Labels?.['kloud.internal'] === 'true'
      )
        throw new Error('Compose target ownership changed')
      return runtime
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Docker GET failed (404):')
      )
        return null
      throw error
    }
  }
  const hashes: Record<string, string> = {},
    images: Record<string, string> = {}
  for (const [name, service] of Object.entries(model.services) as [
    string,
    any,
  ][]) {
    const image = await engine(
      connector.dockerSocket,
      'GET',
      `/images/${encodeURIComponent(service.image)}/json`,
    )
    images[name] = image.Id
    hashes[name] = protectedConfigHash(
      { ...service, image: image.Id },
      connector.token,
    )
  }
  const dependencies = Object.keys(model.services).filter(
    (name) =>
      !Object.hasOwn(rules, name) && current.hashes?.[name] !== hashes[name],
  )
  const targets: NonNullable<RolloutContext['compose']>['targets'] = {}
  for (const name of selected) {
    const service = model.services[name]
    if (!service)
      throw new Error(
        `Selected Compose service ${name} is missing from this revision`,
      )
    const original = service.container_name ?? `${project}-${name}-1`
    const previousName = current.targets?.[name] ?? original
    const previous = await inspect(previousName)
    if (
      previous &&
      (previous.Config.Labels?.['kloud.project'] !== job.project ||
        previous.Config.Labels?.['kloud.application'] !==
          (job.service ?? job.application))
    )
      throw new Error(`Compose target ${name} belongs to another app`)
    const action = rules[name]!.action
    if (action === 'restart' && !context.policy.allowDowntime)
      throw new Error(
        `Restart watch action for ${name} requires the app downtime setting`,
      )
    if (action === 'restart' && !previous)
      throw new Error(`Cannot restart ${name} before its first deployment`)
    const candidate =
      action === 'restart'
        ? previousName
        : bluegreen
          ? `kloud-release-${job.id}-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`
          : original
    targets[name] = {
      candidate,
      previous: previous ? previousName : null,
      original,
      action,
      stopGraceSeconds: stopGraceSeconds(
        service.stop_grace_period,
        context.policy.stopGraceSeconds,
      ),
    }
  }
  const candidateNames = Object.fromEntries(
    Object.entries(targets)
      .filter(([, target]) => target.action === 'redeploy')
      .map(([name, target]) => [name, target.candidate]),
  )
  const candidateModel = bluegreen
    ? composeCandidateModel(model, candidateNames)
    : null
  const commits: Record<string, string> = {}
  for (const [name, target] of Object.entries(targets))
    if (target.action === 'redeploy' && job.commit) commits[name] = job.commit
  context.compose = {
    targets,
    commits,
    hashes,
    images,
    dependencies,
    directory,
    project,
  }
  const identity = `kloud-${job.project}-${job.service ?? job.application}-release-${job.id}`
  const previousIdentity = job.serving ?? null
  await context.progress('prepared', identity, previousIdentity)
  let switching = false,
    dependenciesInFlight = false
  const candidateFile = join(directory, 'candidate-compose.json')
  const escape = (v: any): any =>
    typeof v === 'string'
      ? v.replaceAll('$', () => '$$')
      : Array.isArray(v)
        ? v.map(escape)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, escape(x)]),
            )
          : v
  try {
    if (!bluegreen) {
      for (const [name, target] of Object.entries(targets))
        if (target.action === 'redeploy')
          model.services[name].labels = {
            ...model.services[name].labels,
            'kloud.run': job.id,
          }
      await writeFile(
        file,
        JSON.stringify(options.escaped ? model : escape(model)),
        { mode: 0o600 },
      )
      switching = true
    }
    if (dependencies.length) {
      await context.progress('dependency-restart', identity, previousIdentity)
      dependenciesInFlight = true
      log(
        `Required dependency configuration restarts: ${dependencies.join(', ')}. These may interrupt the app.\n`,
      )
      await run([
        ...prefix,
        'up',
        '--detach',
        '--no-deps',
        '--no-build',
        '--wait',
        '--wait-timeout',
        String(context.policy.readiness.timeoutSeconds),
        ...dependencies,
      ])
      dependenciesInFlight = false
      await context.progress('dependencies', identity, previousIdentity)
    }
    if (bluegreen && Object.keys(candidateNames).length) {
      for (const [key, value] of Object.entries(candidateModel.networks) as [
        string,
        any,
      ][]) {
        try {
          await engine(
            connector.dockerSocket,
            'GET',
            `/networks/${encodeURIComponent(value.name)}`,
          )
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.startsWith('Docker GET failed (404):')
          )
            throw error
          const spec = model.networks[key]
          if (spec.external)
            throw new Error(`External network ${value.name} is unavailable`)
          await engine(connector.dockerSocket, 'POST', '/networks/create', {
            Name: value.name,
            Driver: spec.driver ?? 'bridge',
            Internal: spec.internal ?? false,
            Attachable: spec.attachable ?? false,
            Options: spec.driver_opts ?? {},
            Labels: {
              'kloud.project': job.project,
              'kloud.application': job.service ?? job.application,
            },
          })
        }
      }
      for (const service of Object.values(candidateModel.services) as any[])
        service.labels = { ...service.labels, 'kloud.run': job.id }
      await writeFile(
        candidateFile,
        JSON.stringify(
          options.escaped ? candidateModel : escape(candidateModel),
        ),
        { mode: 0o600 },
      )
      await run([
        ...docker,
        'compose',
        '--project-name',
        `kloud-release-${job.id}`,
        '--file',
        candidateFile,
        'up',
        '--detach',
        '--no-deps',
        '--no-build',
      ])
    } else if (!bluegreen) {
      if (!context.policy.allowDowntime)
        throw new Error(
          'Stop-first Compose requires explicit downtime permission',
        )
      for (const target of Object.values(targets))
        if (
          target.action === 'redeploy' &&
          target.previous &&
          target.previous !== target.original
        ) {
          const previous = await inspect(target.previous)
          if (previous?.State.Running)
            await engine(
              connector.dockerSocket,
              'POST',
              `/containers/${previous.Id}/stop?t=${target.stopGraceSeconds ?? context.policy.stopGraceSeconds}`,
            )
        }
      const redeploy = Object.keys(targets).filter(
        (name) => targets[name]!.action === 'redeploy',
      )
      if (redeploy.length)
        await run([
          ...prefix,
          'up',
          '--detach',
          '--no-deps',
          '--no-build',
          '--force-recreate',
          ...redeploy,
        ])
    }
    for (const target of Object.values(targets))
      if (target.action === 'restart')
        await engine(
          connector.dockerSocket,
          'POST',
          `/containers/${encodeURIComponent(target.candidate)}/restart?t=${target.stopGraceSeconds ?? context.policy.stopGraceSeconds}`,
        )
    await context.progress('started', identity, previousIdentity)
    const deadline = Date.now() + context.policy.readiness.timeoutSeconds * 1000
    while (true) {
      signal.throwIfAborted()
      await context.progress('started', identity, previousIdentity)
      let ready = true
      for (const [name, target] of Object.entries(targets)) {
        const runtime = await inspect(target.candidate)
        if (!runtime?.State.Running)
          throw new Error(`Compose candidate ${name} stopped before readiness`)
        if (
          target.action === 'redeploy' &&
          runtime.Config.Labels?.['kloud.run'] !== job.id
        )
          throw new Error('Candidate release identity changed before readiness')
        const http = rules[name]!.http ?? context.policy.readiness.http
        if (
          context.policy.readiness.dockerHealth &&
          runtime.State.Health?.Status !== 'healthy'
        )
          ready = false
        if (
          http &&
          !(await context.httpProbe(
            runtime.Id,
            http,
            AbortSignal.any([
              signal,
              AbortSignal.timeout(http.timeoutSeconds * 1000),
            ]),
          ))
        )
          ready = false
        if (!context.policy.readiness.dockerHealth && !http)
          throw new Error(`Configure at least one readiness check for ${name}`)
      }
      if (ready && Date.now() <= deadline) break
      if (Date.now() > deadline)
        throw new Error(
          'Compose rollout-unit readiness timed out; previous web/API releases were preserved',
        )
      await delay(context.policy.readiness.intervalSeconds * 1000, undefined, {
        signal,
      })
    }
    await context.progress('ready', identity, previousIdentity)
    switching = true
    const cutoverDeadline =
      Date.now() + context.policy.readiness.timeoutSeconds * 1000
    while (
      !(await context.progress('cutover', identity, previousIdentity)).applied
    ) {
      if (Date.now() > cutoverDeadline)
        throw new Error('Compose proxy cutover requires reconciliation')
      await delay(1000, undefined, { signal })
    }
    await context.progress('serving', identity, previousIdentity)
    for (const target of Object.values(targets))
      if (
        target.action === 'redeploy' &&
        target.previous &&
        target.previous !== target.candidate
      ) {
        const previous = await inspect(target.previous)
        if (previous) {
          await engine(
            connector.dockerSocket,
            'POST',
            `/containers/${previous.Id}/stop?t=${target.stopGraceSeconds ?? context.policy.stopGraceSeconds}`,
          )
          await engine(
            connector.dockerSocket,
            'DELETE',
            `/containers/${previous.Id}`,
          )
        }
      }
    await context.progress('retired', identity, previousIdentity)
    return images
  } catch (error) {
    if (switching || dependenciesInFlight) {
      await context
        .progress('uncertain', identity, previousIdentity)
        .catch(() => {})
      throw new UncertainRolloutError(
        'Compose cutover outcome is uncertain; candidates and prior releases were retained',
      )
    }
    if (bluegreen)
      for (const target of Object.values(targets))
        if (target.action === 'redeploy') {
          const candidate = await inspect(target.candidate).catch(() => null)
          if (candidate?.Config.Labels?.['kloud.run'] === job.id)
            await engine(
              connector.dockerSocket,
              'DELETE',
              `/containers/${candidate.Id}?force=true`,
            ).catch(() => {})
        }
    await context.progress('failed', identity, previousIdentity).catch(() => {})
    throw error
  } finally {
    await rm(candidateFile, { force: true })
  }
}
export async function reconcileComposeRelease(
  job: any,
  connector: ConnectorConfig,
  context: RolloutContext,
  signal: AbortSignal,
  log: (text: string) => void,
) {
  const details = context.compose!
  const progress = job.reconcile
  if (progress.stage === 'dependency-restart')
    throw new UncertainRolloutError(
      'A required dependency restart was interrupted; inspect its configuration and health before repairing the app serving state',
    )
  const inspect = async (name: string | null) => {
    if (!name) return null
    try {
      const runtime = await engine(
        connector.dockerSocket,
        'GET',
        `/containers/${encodeURIComponent(name)}/json`,
      )
      if (
        runtime.Config.Labels?.['kloud.project'] !== job.project ||
        runtime.Config.Labels?.['kloud.application'] !== job.service
      )
        throw new Error('Compose release ownership changed')
      return runtime
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Docker GET failed (404):')
      )
        return null
      throw error
    }
  }
  const state: Record<string, { candidate: any; previous: any }> = {}
  for (const [name, target] of Object.entries(details.targets)) {
    let candidate = await inspect(target.candidate)
    if (
      target.action === 'redeploy' &&
      candidate?.Config.Labels?.['kloud.run'] !== job.id
    )
      candidate = null
    state[name] = {
      candidate,
      previous:
        target.previous !== target.candidate
          ? await inspect(target.previous)
          : null,
    }
  }
  const artifacts = () =>
    details.directory
      ? {
          directory: details.directory,
          project: details.project ?? '',
          commit: job.commit ?? '0'.repeat(40),
        }
      : details.images
  if (
    progress.stage === 'retired' &&
    Object.values(state).every((v) => v.candidate?.State.Running)
  )
    return artifacts()
  if (progress.stage === 'failed') {
    for (const [name, target] of Object.entries(details.targets))
      if (
        target.action === 'redeploy' &&
        state[name]?.candidate?.Config.Labels?.['kloud.run'] === job.id
      )
        await engine(
          connector.dockerSocket,
          'DELETE',
          `/containers/${state[name]!.candidate.Id}?force=true`,
        )
    throw new Error('Interrupted Compose candidate failed before cutover')
  }
  const deadline = Date.now() + context.policy.readiness.timeoutSeconds * 1000
  let ready = false
  while (Date.now() <= deadline) {
    signal.throwIfAborted()
    ready = true
    for (const [name, target] of Object.entries(details.targets)) {
      const runtime = await inspect(target.candidate)
      state[name]!.candidate = runtime
      if (!runtime?.State.Running) {
        ready = false
        break
      }
      const http =
        context.policy.compose?.services[name]?.http ??
        context.policy.readiness.http
      if (
        context.policy.readiness.dockerHealth &&
        runtime.State.Health?.Status !== 'healthy'
      )
        ready = false
      if (
        http &&
        !(await context.httpProbe(
          runtime.Id,
          http,
          AbortSignal.any([
            signal,
            AbortSignal.timeout(http.timeoutSeconds * 1000),
          ]),
        ))
      )
        ready = false
    }
    if (ready) break
    await delay(context.policy.readiness.intervalSeconds * 1000, undefined, {
      signal,
    })
  }
  if (ready) {
    if (['prepared', 'dependencies'].includes(progress.stage))
      await context.progress('started', progress.candidate, progress.previous)
    if (['prepared', 'dependencies', 'started'].includes(progress.stage))
      await context.progress('ready', progress.candidate, progress.previous)
    const switchDeadline =
      Date.now() + context.policy.readiness.timeoutSeconds * 1000
    while (
      !(
        await context.progress('cutover', progress.candidate, progress.previous)
      ).applied
    ) {
      if (Date.now() > switchDeadline)
        throw new UncertainRolloutError(
          'Compose proxy reconciliation timed out',
        )
      await delay(1000, undefined, { signal })
    }
    await context.progress('serving', progress.candidate, progress.previous)
    for (const [name, target] of Object.entries(details.targets))
      if (
        target.action === 'redeploy' &&
        target.previous &&
        target.previous !== target.candidate
      ) {
        const previous = await inspect(target.previous)
        if (previous) {
          await engine(
            connector.dockerSocket,
            'POST',
            `/containers/${previous.Id}/stop?t=${target.stopGraceSeconds ?? context.policy.stopGraceSeconds}`,
          )
          await engine(
            connector.dockerSocket,
            'DELETE',
            `/containers/${previous.Id}`,
          )
        }
      }
    await context.progress('retired', progress.candidate, progress.previous)
    return artifacts()
  }
  if (
    ['prepared', 'dependencies', 'started', 'ready'].includes(progress.stage) &&
    context.policy.strategy === 'blue-green'
  ) {
    for (const [name, target] of Object.entries(details.targets))
      if (
        target.action === 'redeploy' &&
        state[name]?.candidate?.Config.Labels?.['kloud.run'] === job.id
      )
        await engine(
          connector.dockerSocket,
          'DELETE',
          `/containers/${state[name]!.candidate.Id}?force=true`,
        )
    await context.progress('failed', progress.candidate, progress.previous)
    throw new Error(
      'Interrupted Compose candidate failed readiness; previous services were retained',
    )
  }
  if (!Object.values(state).every((v) => v.previous?.State.Running))
    throw new UncertainRolloutError(
      'Compose serving state remains uncertain; preserve all owned runtimes',
    )
  const restoreDeadline =
    Date.now() + context.policy.readiness.timeoutSeconds * 1000
  while (true) {
    const response = await fetch(
      new URL(`connectors/platform/${job.id}/reconcile`, connector.apiUrl),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connector.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          previous_running: true,
          candidate_running: false,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      },
    )
    if (!response.ok)
      throw new UncertainRolloutError(
        'Compose previous-route restoration requires manual repair',
      )
    if (((await response.json()) as any).applied) break
    if (Date.now() > restoreDeadline)
      throw new UncertainRolloutError(
        'Compose previous-route restoration timed out',
      )
    await delay(1000, undefined, { signal })
  }
  for (const [name, target] of Object.entries(details.targets))
    if (
      target.action === 'redeploy' &&
      state[name]?.candidate?.Config.Labels?.['kloud.run'] === job.id
    )
      await engine(
        connector.dockerSocket,
        'DELETE',
        `/containers/${state[name]!.candidate.Id}?force=true`,
      )
  log(
    'Restored all previous Compose service routes after failed candidate reconciliation.\n',
  )
  throw new Error(
    'Compose candidate failed; all previous service routes were restored',
  )
}
