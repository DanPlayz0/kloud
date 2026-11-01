import { createHmac } from 'node:crypto'
export interface WatchRule {
  include: string[]
  exclude: string[]
  action: 'redeploy' | 'restart'
}
export function glob(pattern: string) {
  if (
    !pattern ||
    pattern.startsWith('/') ||
    pattern.split('/').includes('..') ||
    pattern.includes('\\')
  )
    throw new Error('Watch paths must be repository-relative POSIX globs')
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*' && pattern[i + 1] === '*') {
      i++
      if (pattern[i + 1] === '/') {
        i++
        source += '(?:.*/)?'
      } else source += '.*'
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(source + '$')
}
export function affected(
  rule: WatchRule,
  paths: string[] | null | undefined,
  definitions: string[],
  manual = false,
) {
  if (manual || paths == null) return true
  if (paths.some((path) => definitions.includes(path))) return true
  const include = rule.include.map(glob),
    exclude = rule.exclude.map(glob)
  return paths.some(
    (path) =>
      (!include.length || include.some((re) => re.test(path))) &&
      !exclude.some((re) => re.test(path)),
  )
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}
export function protectedConfigHash(value: any, key: string) {
  return createHmac('sha256', key)
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
export function composeCandidateModel(
  model: any,
  selected: Record<string, string>,
) {
  const result: any = { services: {}, networks: {}, volumes: {} }
  for (const [service, candidate] of Object.entries(selected)) {
    const spec = structuredClone(model.services[service])
    if (!spec) throw new Error(`Unknown selected Compose service ${service}`)
    if (
      (spec.ports ?? []).length ||
      spec.network_mode ||
      spec.pid === 'host' ||
      spec.ipc === 'host'
    )
      throw new Error(
        `Service ${service} cannot overlap host ports or namespaces`,
      )
    if ((spec.volumes ?? []).some((v: any) => !v.read_only))
      throw new Error(
        `Service ${service} has writable volumes; resolve exclusive writers before blue/green`,
      )
    if (
      Object.keys(spec.depends_on ?? {}).some((dep) =>
        Object.hasOwn(selected, dep),
      )
    )
      throw new Error(
        `Service ${service} depends on another candidate; verify release-specific internal discovery before blue/green`,
      )
    if (spec.deploy?.replicas && spec.deploy.replicas !== 1)
      throw new Error(
        `Service ${service} must use one candidate on the selected host`,
      )
    delete spec.depends_on
    delete spec.build
    delete spec.develop
    delete spec.links
    delete spec.external_links
    if (
      (model.services[service].links ?? []).length ||
      (model.services[service].external_links ?? []).length
    )
      throw new Error(
        `Service ${service} uses unsupported shared discovery links`,
      )
    spec.container_name = candidate
    spec.hostname = candidate
    spec.labels = { ...spec.labels, 'kloud.release': candidate }
    const networks = spec.networks ?? { default: null }
    spec.networks = {}
    for (const [network, raw] of Object.entries(networks)) {
      const endpoint = raw as any
      if (endpoint?.ipv4_address || endpoint?.ipv6_address)
        throw new Error(`Service ${service} has a fixed address`)
      const configured = model.networks?.[network]
      if (!configured?.name)
        throw new Error(
          `Service ${service} requires an explicit stable Compose network`,
        )
      result.networks[network] = { external: true, name: configured.name }
      spec.networks[network] = { aliases: [candidate] }
    }
    for (const volume of spec.volumes ?? []) {
      if (volume.type === 'volume') {
        const configured = model.volumes?.[volume.source]
        if (!configured?.name)
          throw new Error(
            `Service ${service} requires an existing named read-only volume`,
          )
        result.volumes[volume.source] = {
          external: true,
          name: configured.name,
        }
      }
    }
    // The Compose service key itself becomes a Docker DNS alias; keep it release-specific too.
    result.services[candidate] = spec
  }
  return result
}
export function stopGraceSeconds(value: unknown, fallback: number) {
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    return Math.ceil(value / 1e9)
  if (typeof value !== 'string')
    throw new Error('Invalid Compose stop_grace_period')
  const units: Record<string, number> = {
    h: 3600,
    m: 60,
    s: 1,
    ms: 0.001,
    us: 0.000001,
    ns: 0.000000001,
  }
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|h|m|s)/g)]
  if (!matches.length || matches.map((match) => match[0]).join('') !== value)
    throw new Error('Invalid Compose stop_grace_period')
  return Math.ceil(
    matches.reduce(
      (total, match) => total + Number(match[1]) * units[match[2]!]!,
      0,
    ),
  )
}
