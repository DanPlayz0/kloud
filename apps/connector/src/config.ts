export interface ConnectorConfig {
  apiUrl: URL
  pollIntervalMs: number
  healthPort: number
  token: string
  dockerSocket: string
  host: string
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

  return {
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
