import { request } from 'node:http'
import {
  slug,
  snapshotSchema,
  type Snapshot,
  type Container,
} from '@dedi-dash/protocol'

interface CPUStats {
  cpu_usage?: { total_usage?: number; percpu_usage?: number[] }
  system_cpu_usage?: number
  online_cpus?: number
}

export function dockerGet(
  socketPath: string,
  path: string,
  signal?: AbortSignal,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, signal, method: 'GET', timeout: 4000 },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 8 * 1024 * 1024)
            req.destroy(new Error('Docker response too large'))
          else chunks.push(chunk)
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Docker returned ${response.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()))
          } catch (error) {
            reject(error)
          }
        })
        response.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('Docker request timed out')))
    req.on('error', reject)
    req.end()
  })
}
export function metrics(
  stats: any,
  previous?: CPUStats,
): Pick<Container, 'cpu' | 'memory' | 'memoryLimit'> {
  const prior = previous ?? stats.precpu_stats
  const cpuDelta =
    stats.cpu_stats?.cpu_usage?.total_usage - prior?.cpu_usage?.total_usage
  const systemDelta =
    stats.cpu_stats?.system_cpu_usage - prior?.system_cpu_usage
  const cpus =
    stats.cpu_stats?.online_cpus ??
    stats.cpu_stats?.cpu_usage?.percpu_usage?.length ??
    1
  const cpu =
    prior?.system_cpu_usage > 0 && systemDelta > 0 && cpuDelta >= 0
      ? (cpuDelta / systemDelta) * cpus * 100
      : null
  const usage = stats.memory_stats?.usage,
    limit = stats.memory_stats?.limit
  const cache =
    stats.memory_stats?.stats?.inactive_file ??
    stats.memory_stats?.stats?.total_inactive_file ??
    0
  return {
    cpu: cpu !== null && Number.isFinite(cpu) ? cpu : null,
    memory: Number.isFinite(usage) ? Math.max(0, usage - cache) : null,
    memoryLimit: Number.isFinite(limit) && limit > 0 ? limit : null,
  }
}
export async function collect(
  socket: string,
  host: string,
  get = dockerGet,
  previous = new Map<string, CPUStats>(),
): Promise<Snapshot> {
  const signal = AbortSignal.timeout(10000)
  const list = await get(socket, '/containers/json?all=true', signal)
  if (!Array.isArray(list) || list.length > 5000)
    throw new Error('Invalid Docker inventory')
  const output: Container[] = []
  const samples = new Map<string, CPUStats>()
  const eligible = list.filter(
    (item) => item.Labels?.['dedi-dash.internal'] !== 'true',
  )
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(8, eligible.length) }, async () => {
      while (cursor < eligible.length) {
        signal.throwIfAborted()
        const item = eligible[cursor++]
        let usage: Pick<Container, 'cpu' | 'memory' | 'memoryLimit'> = {
          cpu: null,
          memory: null,
          memoryLimit: null,
        }
        if (item.State === 'running') {
          try {
            const stats = await get(
              socket,
              `/containers/${item.Id}/stats?stream=false&one-shot=true`,
              signal,
            )
            usage = metrics(stats, previous.get(item.Id))
            if (stats.cpu_stats) samples.set(item.Id, stats.cpu_stats)
          } catch {
            /* Container may disappear during collection. */
          }
        }
        const project = slug.safeParse(item.Labels?.['dedi-dash.project']),
          application = slug.safeParse(item.Labels?.['dedi-dash.application'])
        output.push({
          id: item.Id,
          name: item.Names?.[0]?.replace(/^\//, '') ?? item.Id.slice(0, 12),
          state: item.State,
          ...(/\((healthy|unhealthy|health: starting)\)/.test(item.Status ?? '')
            ? {
                health: item.Status.includes('(unhealthy)')
                  ? ('unhealthy' as const)
                  : item.Status.includes('(healthy)')
                    ? ('healthy' as const)
                    : ('starting' as const),
              }
            : {}),
          project: project.success ? project.data : null,
          application: application.success ? application.data : null,
          ...usage,
        })
      }
    }),
  )
  signal.throwIfAborted()
  const snapshot = snapshotSchema.parse({
    version: 1,
    type: 'snapshot',
    host,
    containers: output,
  })
  previous.clear()
  for (const [id, sample] of samples) previous.set(id, sample)
  return snapshot
}

/** One-shot responses omit precpu_stats; retain samples per host between polls. */
export function createCollector(socket: string, host: string, get = dockerGet) {
  const previous = new Map<string, CPUStats>()
  return () => collect(socket, host, get, previous)
}
