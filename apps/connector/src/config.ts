import { homedir } from 'node:os'
import { resolve } from 'node:path'

export interface ConnectorConfig {
  hostTerminal?: {
    host: string
    port: number
    username: string
    privateKeyPath: string
    fingerprint: string
  }
  dockerEnabled: boolean
  pm2Enabled: boolean
  pm2Home: string
  apiUrl: URL
  pollIntervalMs: number
  healthPort: number
  token: string
  dockerSocket: string
  host: string
  deploymentsEnabled: boolean
  deploymentsDir: string
  buildHelperImage: string
  buildkitImage: string
  buildMemoryMb: number
  githubToken: string | undefined
}

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  max: number,
): number {
  const result = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(result) || result < 1 || result > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`)
  }
  return result
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConnectorConfig {
  const apiUrl = new URL(env.API_URL ?? 'http://localhost:3000')
  if (
    !['http:', 'https:'].includes(apiUrl.protocol) ||
    apiUrl.username ||
    apiUrl.password
  ) {
    throw new Error(
      'API_URL must be an HTTP(S) URL without embedded credentials',
    )
  }
  if (apiUrl.search || apiUrl.hash) {
    throw new Error('API_URL must not contain a query string or fragment')
  }
  if (!apiUrl.pathname.endsWith('/')) apiUrl.pathname += '/'

  let hostTerminal: ConnectorConfig['hostTerminal']
  if (env.HOST_TERMINAL_ENABLED === 'true') {
    if (
      !env.HOST_SSH_HOST ||
      !env.HOST_SSH_USER ||
      !env.HOST_SSH_PRIVATE_KEY_PATH ||
      !/^SHA256:[A-Za-z0-9+/]{43}$/.test(env.HOST_SSH_FINGERPRINT ?? '')
    )
      throw new Error(
        'Host terminal requires HOST_SSH_HOST, HOST_SSH_USER, HOST_SSH_PRIVATE_KEY_PATH and a SHA256 HOST_SSH_FINGERPRINT',
      )
    hostTerminal = {
      host: env.HOST_SSH_HOST,
      port: integer(env.HOST_SSH_PORT, 22, 'HOST_SSH_PORT', 65535),
      username: env.HOST_SSH_USER,
      privateKeyPath: env.HOST_SSH_PRIVATE_KEY_PATH,
      fingerprint: env.HOST_SSH_FINGERPRINT!,
    }
  }

  return {
    hostTerminal,
    dockerEnabled: env.DOCKER_ENABLED !== 'false',
    pm2Enabled: env.PM2_ENABLED === 'true',
    pm2Home: resolve(env.PM2_HOME ?? `${homedir()}/.pm2`),
    deploymentsEnabled: env.DEPLOYMENTS_ENABLED === 'true',
    deploymentsDir: env.DEPLOYMENTS_DIR ?? './deployments',
    buildHelperImage:
      env.DEPLOYMENTS_HELPER_IMAGE ?? 'kloud-build-helper:local',
    buildkitImage:
      env.DEPLOYMENTS_BUILDKIT_IMAGE ?? 'moby/buildkit:v0.28.0-rootless',
    buildMemoryMb: integer(
      env.DEPLOYMENTS_BUILD_MEMORY_MB,
      2048,
      'DEPLOYMENTS_BUILD_MEMORY_MB',
      65536,
    ),
    githubToken: env.DEPLOYMENTS_GITHUB_TOKEN,
    apiUrl,
    pollIntervalMs: integer(
      env.POLL_INTERVAL_MS,
      5_000,
      'POLL_INTERVAL_MS',
      2_147_483_647,
    ),
    healthPort: integer(env.HEALTH_PORT, 3001, 'HEALTH_PORT', 65535),
    token: env.CONNECTOR_TOKEN ?? '',
    dockerSocket:
      env.DOCKER_SOCKET ??
      (process.platform === 'win32'
        ? '//./pipe/docker_engine'
        : '/var/run/docker.sock'),
    host: env.CONNECTOR_HOST ?? env.HOSTNAME ?? 'docker-host',
  }
}
