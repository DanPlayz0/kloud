import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  connectorUpdateSchema,
  type ConnectorStatus,
} from '@kloud/protocol/connector'

export function updateConfig(env: NodeJS.ProcessEnv = process.env) {
  const command = env.CONNECTOR_UPDATE_COMMAND || undefined
  if (command && (!isAbsolute(command) || command.includes('\0')))
    throw new Error(
      'CONNECTOR_UPDATE_COMMAND must be an absolute executable path',
    )
  const interval = Number(env.CONNECTOR_UPDATE_INTERVAL_MS ?? 900000)
  if (!Number.isInteger(interval) || interval < 60000 || interval > 86400000)
    throw new Error(
      'CONNECTOR_UPDATE_INTERVAL_MS must be between 60000 and 86400000',
    )
  if (env.CONNECTOR_AUTO_UPDATE === 'true' && !command)
    throw new Error('Automatic updates require CONNECTOR_UPDATE_COMMAND')
  return {
    command,
    enabled: !!command && env.CONNECTOR_AUTO_UPDATE !== 'false',
    interval,
  }
}

export function runningVersion(env: NodeJS.ProcessEnv = process.env) {
  const declared = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ).version
  const revision = env.CONNECTOR_REVISION ?? env.GIT_COMMIT ?? 'unknown'
  return {
    version: (env.CONNECTOR_VERSION || declared).slice(0, 100),
    revision: /^[a-f0-9]{7,64}$/.test(revision) ? revision : 'unknown',
  }
}

function run(command: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Only a locally configured executable can run. Dashboard operations never
    // supply command text, arguments, repository URLs, images, or environment.
    execFile(
      command,
      [],
      { signal, timeout: 10 * 60000, maxBuffer: 65536 },
      (error) => {
        if (error)
          reject(
            new Error(
              'Update command failed; inspect the connector host update log.',
            ),
          )
        else resolve()
      },
    )
  })
}

export function connectorUpdater(
  signal: AbortSignal,
  config = updateConfig(),
  execute = run,
  release = runningVersion(),
) {
  const status: ConnectorStatus = {
    type: 'connector-status',
    ...release,
    started_at: new Date().toISOString(),
    updater: {
      configured: !!config.command,
      enabled: config.enabled,
      state: 'idle',
      checked_at: null,
      completed_at: null,
      error: null,
    },
  }
  let active: Promise<void> | undefined
  async function check() {
    if (!config.command)
      throw new Error('Updates are not configured on the connector host')
    if (signal.aborted) throw new Error('Connector is stopping')
    if (active) return
    status.updater.state = 'checking'
    status.updater.checked_at = new Date().toISOString()
    status.updater.error = null
    active = execute(config.command, signal)
      .then(() => {
        status.updater.state = 'idle'
        status.updater.completed_at = new Date().toISOString()
      })
      .catch(() => {
        status.updater.state = 'failed'
        status.updater.error =
          'Update command failed; inspect the connector host update log.'
      })
      .finally(() => {
        active = undefined
      })
    await active
  }
  const timer = setInterval(() => {
    if (status.updater.enabled) void check().catch(() => {})
  }, config.interval)
  timer.unref()
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  return {
    snapshot: (): ConnectorStatus => structuredClone(status),
    configure(enabled: boolean) {
      if (enabled && !config.command)
        throw new Error('Updates are not configured on the connector host')
      status.updater.enabled = enabled
    },
    execute(raw: unknown) {
      const operation = connectorUpdateSchema.parse(raw)
      if (operation.action === 'configure') this.configure(operation.enabled)
      else {
        if (!config.command)
          throw new Error('Updates are not configured on the connector host')
        // Acknowledge before the updater can restart this connector.
        setTimeout(() => void check().catch(() => {}), 250).unref()
      }
      return { accepted: true }
    },
    check,
  }
}
