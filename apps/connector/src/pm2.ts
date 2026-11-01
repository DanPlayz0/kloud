import { createRequire } from 'node:module'
import { open, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import {
  pm2RequestSchema,
  pm2WorkerSchema,
  type Pm2Request,
  type Pm2Worker,
} from '@kloud/protocol/pm2'

export interface Pm2Transport {
  call(method: string, args: unknown, timeout?: number): Promise<any>
  subscribeLogs?(
    receive: (stream: 'stdout' | 'stderr', packet: unknown) => void,
    disconnected: () => void,
  ): Promise<() => void>
  close(): void
}

/** Use only PM2's pinned socket codec. The normal PM2 client can spawn a daemon. */
export function socketTransport(home: string): Pm2Transport {
  const require = createRequire(import.meta.url)
  const axon = require('pm2/modules/pm2-axon')
  const rpc = require('pm2/modules/pm2-axon-rpc')
  const active = new Set<() => void>()
  let generation = 0
  return {
    async subscribeLogs(receive, disconnected) {
      const version = generation
      const path = join(home, 'pub.sock')
      if (!(await stat(path)).isSocket() || generation !== version)
        throw new Error('PM2 log socket unavailable')
      return new Promise<() => void>((resolve, reject) => {
        const bus = axon.socket('sub-emitter')
        // Manage reconnection ourselves so a replaced socket is revalidated.
        bus.sock.set('retry timeout', 0)
        let done = false
        let connected = false
        const stop = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          active.delete(stop)
          bus.close()
          if (connected) disconnected()
          else reject(new Error('PM2 log socket unavailable'))
        }
        const timer = setTimeout(stop, 10000)
        active.add(stop)
        bus.sock.on('error', stop)
        bus.sock.on('socket error', stop)
        bus.sock.on('close', stop)
        bus.sock.once('connect', () => {
          if (done) return bus.close()
          if (generation !== version) return stop()
          connected = true
          clearTimeout(timer)
          resolve(stop)
        })
        bus.on('log:out', (packet: unknown) => {
          if (!done) receive('stdout', packet)
        })
        bus.on('log:err', (packet: unknown) => {
          if (!done) receive('stderr', packet)
        })
        bus.connect(path)
      })
    },
    async call(method, args, timeout = 10000) {
      const version = generation
      const path = join(home, 'rpc.sock')
      if (!(await stat(path)).isSocket())
        throw new Error('PM2 socket unavailable')
      if (generation !== version) throw new Error('Disconnected')
      return new Promise((resolve, reject) => {
        const socket = axon.socket('req')
        socket.set('retry timeout', 0)
        const client = new rpc.Client(socket)
        let done = false
        const finish = (error?: unknown, value?: unknown) => {
          if (done) return
          done = true
          clearTimeout(timer)
          active.delete(cancel)
          socket.close()
          if (error)
            reject(
              new Error(
                'PM2 request failed; inspect host state before retrying',
              ),
            )
          else resolve(value)
        }
        const cancel = () => finish(new Error('Disconnected'))
        const timer = setTimeout(cancel, timeout)
        active.add(cancel)
        socket.on('error', finish)
        socket.once('close', cancel)
        socket.once('connect', () => {
          if (done) socket.close()
          else
            client.call(
              method,
              ...(Array.isArray(args) ? args : [args]),
              finish,
            )
        })
        socket.connect(path)
      })
    },
    close() {
      generation++
      for (const cancel of active) cancel()
    },
  }
}

export function publicWorker(raw: any): Pm2Worker {
  const env = raw.pm2_env ?? {}
  const number = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  return pm2WorkerSchema.parse({
    id: raw.pm_id,
    name: env.name ?? raw.name,
    namespace: env.namespace ?? 'default',
    status: [
      'online',
      'stopping',
      'stopped',
      'launching',
      'errored',
      'one-launch-status',
      'waiting restart',
    ].includes(env.status)
      ? env.status
      : 'unknown',
    mode: ['fork_mode', 'cluster_mode'].includes(env.exec_mode)
      ? env.exec_mode
      : 'unknown',
    pid: number(raw.pid) ?? 0,
    uptime: number(env.pm_uptime),
    restarts: number(env.restart_time) ?? 0,
    cpu: number(raw.monit?.cpu),
    memory: number(raw.monit?.memory),
  })
}

async function tail(path: string, limit: number) {
  // Stat first to avoid blocking on special files such as FIFOs.
  if (!(await stat(path)).isFile()) return ''
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) return ''
    const start = Math.max(0, info.size - limit)
    const buffer = Buffer.alloc(Math.min(info.size, limit))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    if (start && text.includes('\n')) text = text.slice(text.indexOf('\n') + 1)
    return text.split('\n').slice(-201).join('\n')
  } finally {
    await file.close()
  }
}

export function pm2Operations(transport: Pm2Transport) {
  const locks = new Set<string>()
  let generation = 0
  // A single subscription preserves PM2 bus order across both output channels.
  // Retention is bounded across the whole host, including very noisy apps.
  const logs: {
    name: string
    namespace: string
    worker: number
    output: string
    bytes: number
  }[] = []
  let logBytes = 0
  let stopLogs: (() => void) | undefined
  let connectingLogs: Promise<void> | undefined
  const clearLogs = () => {
    logs.length = 0
    logBytes = 0
  }
  const connectLogs = () => {
    if (stopLogs) return Promise.resolve()
    if (connectingLogs) return connectingLogs
    if (!transport.subscribeLogs) return Promise.resolve()
    const version = generation
    let connected = true
    const connecting = transport
      .subscribeLogs(
        (stream, raw) => {
          if (generation !== version || !raw || typeof raw !== 'object') return
          const packet = raw as {
            process?: { pm_id?: unknown; name?: unknown; namespace?: unknown }
            data?: unknown
          }
          const process = packet.process
          if (
            !process ||
            !Number.isSafeInteger(process.pm_id) ||
            Number(process.pm_id) < 0 ||
            typeof process.name !== 'string' ||
            !process.name ||
            process.name.length > 256 ||
            typeof process.namespace !== 'string' ||
            !process.namespace ||
            process.namespace.length > 256 ||
            typeof packet.data !== 'string'
          )
            return
          // Limit individual chunks before retaining them. Keep multiline errors intact.
          const data = Buffer.from(packet.data)
            .subarray(-12000)
            .toString('utf8')
          const output = `[${stream} #${process.pm_id}] ${data}${data.endsWith('\n') ? '' : '\n'}`
          const bytes = Buffer.byteLength(output)
          logs.push({
            name: process.name,
            namespace: process.namespace,
            worker: Number(process.pm_id),
            output,
            bytes,
          })
          logBytes += bytes
          while (logs.length > 10000 || logBytes > 4 * 1024 * 1024)
            logBytes -= logs.shift()!.bytes
        },
        () => {
          if (generation !== version) return
          connected = false
          stopLogs = undefined
          // Never present output spanning a known connection gap as uninterrupted.
          clearLogs()
        },
      )
      .then((stop) => {
        if (generation !== version || !connected) stop()
        else stopLogs = stop
      })
      .catch(() => {
        // File tails and inventory remain available when the bus cannot connect.
      })
      .finally(() => {
        if (connectingLogs === connecting) connectingLogs = undefined
      })
    connectingLogs = connecting
    return connecting
  }
  const list = async (timeout = 10000) => {
    const data = await transport.call('getMonitorData', {}, timeout)
    if (!Array.isArray(data) || data.length > 5000)
      throw new Error('Invalid PM2 inventory')
    const workers = data.filter((p) => !p.pm2_env?.pmx_module)
    // Validate IDs before any action; PM2's special name "all" must never be a target ID.
    for (const worker of workers) publicWorker(worker)
    return workers
  }
  const matches = (p: any, request: Pm2Request) =>
    (p.pm2_env?.name ?? p.name) === request.name &&
    (p.pm2_env?.namespace ?? 'default') === request.namespace
  return {
    close: () => {
      generation++
      stopLogs?.()
      stopLogs = undefined
      connectingLogs = undefined
      clearLogs()
      transport.close()
    },
    async collect() {
      const workers = (await list()).map(publicWorker)
      await connectLogs()
      return workers
    },
    async execute(raw: unknown) {
      const request = pm2RequestSchema.parse(raw)
      const version = generation
      const key = JSON.stringify([request.namespace, request.name])
      if (request.action !== 'logs') {
        if (locks.has(key))
          throw new Error('PM2 app operation already in progress')
        locks.add(key)
      }
      const deadline = Date.now() + 30000
      try {
        const workers = (await list()).filter((p) => matches(p, request))
        if (!workers.length) throw new Error('PM2 app no longer exists')
        if (request.action === 'logs') {
          const selected = workers.filter(
            (p) => request.worker === undefined || p.pm_id === request.worker,
          )
          if (!selected.length) throw new Error('Worker no longer exists')
          if (request.stream === 'combined') {
            await connectLogs()
            if (generation !== version) throw new Error('Disconnected')
            const ids = new Set(selected.map((p) => p.pm_id))
            const output = logs
              .filter(
                (entry) =>
                  entry.name === request.name &&
                  entry.namespace === request.namespace &&
                  ids.has(entry.worker),
              )
              .map((entry) => entry.output)
              .join('')
            return {
              output: Buffer.from(output)
                .subarray(-47996)
                .toString('utf8')
                .split('\n')
                .slice(-200)
                .join('\n'),
              unavailable: !stopLogs,
            }
          }
          const files = new Map<string, number[]>()
          for (const p of selected) {
            const path =
              p.pm2_env?.[
                request.stream === 'stderr'
                  ? 'pm_err_log_path'
                  : 'pm_out_log_path'
              ]
            if (typeof path === 'string')
              files.set(path, [...(files.get(path) ?? []), p.pm_id])
          }
          let output = '',
            unavailable = !files.size || files.size > 200
          const selectedFiles = [...files].slice(0, 200)
          const fileBudget = Math.floor(
            48000 / Math.max(1, selectedFiles.length),
          )
          for (const [path, ids] of selectedFiles) {
            try {
              output += `[workers ${ids.join(', ')}]\n${await tail(path, fileBudget)}\n`
            } catch {
              unavailable = true
            }
            // Leave room for a replacement character if the byte boundary splits UTF-8.
            output = Buffer.from(output).subarray(-47996).toString('utf8')
          }
          return {
            output: output.split('\n').slice(-200).join('\n'),
            unavailable,
          }
        }
        const results: { id: number; ok: boolean }[] = []
        for (const worker of workers) {
          let ok = false
          try {
            if (generation !== version || Date.now() >= deadline)
              throw new Error('Disconnected or deadline exceeded')
            const current = (
              await list(Math.max(1, Math.min(10000, deadline - Date.now())))
            ).find((p) => p.pm_id === worker.pm_id)
            if (generation !== version || Date.now() >= deadline)
              throw new Error('Disconnected or deadline exceeded')
            if (
              !current ||
              !matches(current, request) ||
              current.pm2_env?.created_at !== worker.pm2_env?.created_at
            )
              throw new Error('PM2 target changed')
            if (
              request.action === 'start' &&
              current.pm2_env.status === 'online'
            )
              ok = true
            else {
              const method = {
                start: 'startProcessId',
                stop: 'stopProcessId',
                restart: 'restartProcessId',
                reload: 'reloadProcessId',
                delete: 'deleteProcessId',
              }[request.action]
              const args = ['restart', 'reload'].includes(request.action)
                ? { id: worker.pm_id, env: {} }
                : worker.pm_id
              if (request.action === 'stop' || request.action === 'delete') {
                await transport.call(
                  'stopWatch',
                  [method, worker.pm_id],
                  Math.max(1, Math.min(10000, deadline - Date.now())),
                )
                if (generation !== version || Date.now() >= deadline)
                  throw new Error('Disconnected or deadline exceeded')
              }
              await transport.call(
                method,
                args,
                Math.max(1, Math.min(20000, deadline - Date.now())),
              )
              ok = true
            }
          } catch {
            /* Other workers still receive an explicit result; never retry mutations. */
          }
          results.push({ id: worker.pm_id, ok })
        }
        return { results }
      } finally {
        if (request.action !== 'logs') locks.delete(key)
      }
    },
  }
}
