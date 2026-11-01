import { randomUUID } from 'node:crypto'
import { runtimeRequestSchema } from '@kloud/protocol/platform'
import {
  engine,
  dockerHost,
  commandEnvironment,
  runCommand,
} from './deployment-process.js'
import type { ConnectorConfig } from './config.js'
import { openTerminal } from './terminal.js'

export function runtimeOperations(config: ConnectorConfig) {
  const sessions = new Map<
    string,
    {
      terminal: Awaited<ReturnType<typeof openTerminal>>
      owner: string
      container: string
      touched: number
    }
  >()
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions)
      if (Date.now() - session.touched > 30000) {
        session.terminal.close()
        sessions.delete(id)
      }
  }, 5000)
  cleanup.unref()
  return {
    close() {
      clearInterval(cleanup)
      for (const session of sessions.values()) session.terminal.close()
      sessions.clear()
    },
    async execute(raw: any) {
      const request = runtimeRequestSchema.parse({
        action: raw.action,
        session: raw.session,
        input: raw.input,
        rows: raw.rows,
        cols: raw.cols,
        settings: raw.settings,
      })
      if (
        !/^[a-f0-9]{64}$/.test(raw.container) ||
        typeof raw.owner !== 'string'
      )
        throw new Error('Invalid runtime target')
      const container = await engine(
        config.dockerSocket,
        'GET',
        `/containers/${raw.container}/json`,
      )
      const labels = container.Config.Labels ?? {}
      if (labels['kloud.internal'] === 'true')
        throw new Error('Internal containers cannot be operated')
      // The API authorizes effective manual assignments; exact container IDs prevent name races.
      if (request.action === 'inspect')
        return {
          name: container.Name,
          image: container.Config.Image,
          state: container.State,
          ports: container.NetworkSettings.Ports,
          mounts: container.Mounts,
          networks: Object.keys(container.NetworkSettings.Networks ?? {}),
          settings: {
            cpus: container.HostConfig?.NanoCpus
              ? container.HostConfig.NanoCpus / 1e9
              : container.HostConfig?.CpuQuota > 0
                ? container.HostConfig.CpuQuota /
                  (container.HostConfig.CpuPeriod || 100000)
                : 0,
            memory_mib: Math.ceil(
              (container.HostConfig?.Memory ?? 0) / 1048576,
            ),
            restart_policy: container.HostConfig?.RestartPolicy?.Name || 'no',
            retry_count:
              container.HostConfig?.RestartPolicy?.MaximumRetryCount ?? 0,
          },
        }
      if (request.action === 'update') {
        const settings = request.settings!
        const result = await engine(
          config.dockerSocket,
          'POST',
          `/containers/${raw.container}/update`,
          {
            NanoCpus: Math.round(settings.cpus * 1e9),
            CpuPeriod: 0,
            CpuQuota: 0,
            Memory: settings.memory_mib * 1048576,
            RestartPolicy: {
              Name: settings.restart_policy,
              MaximumRetryCount: settings.retry_count,
            },
          },
        )
        return {
          ok: true,
          warnings: Array.isArray(result?.Warnings) ? result.Warnings : [],
        }
      }
      if (request.action === 'logs') {
        let text = ''
        await runCommand(
          'docker',
          [
            '--host',
            dockerHost(config.dockerSocket),
            'logs',
            '--tail',
            '200',
            '--timestamps',
            raw.container,
          ],
          process.cwd(),
          AbortSignal.timeout(10000),
          (chunk) => {
            text = (text + chunk).slice(-48000)
          },
        )
        return { output: text.slice(-48000) }
      }
      if (['start', 'stop', 'restart'].includes(request.action)) {
        await engine(
          config.dockerSocket,
          'POST',
          `/containers/${raw.container}/${request.action}${request.action === 'start' ? '' : '?t=20'}`,
        )
        return { ok: true }
      }
      if (request.action === 'terminal-open') {
        if (sessions.size >= 20) throw new Error('Host terminal limit reached')
        const id = randomUUID()
        const terminal = await openTerminal(config.dockerSocket, raw.container)
        const session = {
          terminal,
          owner: raw.owner,
          container: raw.container,
          touched: Date.now(),
        }
        sessions.set(id, session)
        return { session: id }
      }
      const session = sessions.get(request.session ?? '')
      if (
        !session ||
        session.owner !== raw.owner ||
        session.container !== raw.container
      )
        throw new Error('Terminal session expired')
      session.touched = Date.now()
      if (request.action === 'terminal-close') {
        session.terminal.close()
        sessions.delete(request.session!)
        return { ok: true }
      }
      if (request.action === 'terminal-write') {
        session.terminal.write(request.input ?? '')
        return { ok: true }
      }
      if (request.action === 'terminal-resize') {
        await session.terminal.resize(request.rows ?? 24, request.cols ?? 80)
        return { ok: true }
      }
      return session.terminal.read()
    },
  }
}
