import { HTTPException } from 'hono/http-exception'
import type { PlatformConfig } from '@kloud/protocol/platform'

export function maskBuildInputs(config: PlatformConfig) {
  if (!config.build_inputs) return
  for (const key of Object.keys(config.build_inputs.secrets))
    config.build_inputs.secrets[key] = '********'
  for (const registry of config.build_inputs.registries)
    registry.password = '********'
}
export function preserveBuildInputs(
  next: PlatformConfig,
  previous: PlatformConfig,
) {
  if (!next.build_inputs) return
  for (const [key, value] of Object.entries(next.build_inputs.secrets)) {
    if (value !== '********') continue
    if (
      !previous.build_inputs ||
      !Object.hasOwn(previous.build_inputs.secrets, key)
    )
      throw new HTTPException(400, {
        message: 'Masked build secret has no previous value.',
      })
    next.build_inputs.secrets[key] = previous.build_inputs.secrets[key]!
  }
  for (const registry of next.build_inputs.registries) {
    if (registry.password !== '********') continue
    const old = previous.build_inputs?.registries.find(
      (value) =>
        value.server === registry.server &&
        value.username === registry.username,
    )
    if (!old)
      throw new HTTPException(400, {
        message: 'Masked registry credential has no previous value.',
      })
    registry.password = old.password
  }
}
export function getBuildSecrets(config: PlatformConfig): string[] {
  return [
    ...Object.values(config.build_inputs?.secrets ?? {}),
    ...(config.build_inputs?.registries ?? []).flatMap((registry) => [
      registry.password,
      Buffer.from(`${registry.username}:${registry.password}`).toString(
        'base64',
      ),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
}

export function dispatchSecrets(
  config: PlatformConfig,
  source?: { token: string; username?: string },
) {
  return [
    ...getBuildSecrets(config),
    ...(source
      ? [
          source.token,
          Buffer.from(
            `${source.username ?? 'x-access-token'}:${source.token}`,
          ).toString('base64'),
        ]
      : []),
  ]
}
