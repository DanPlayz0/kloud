import { forwardingWorker } from './forwarding.js'
import { databaseWorker } from './postgres-recovery.js'
import { publicAddressDiscovery } from './public-addresses.js'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { readConfig } from './config.js'
import { createCollector } from './docker.js'
import { deploymentWorker } from './deployments.js'
import { serviceWorker } from './platform.js'
import { runtimeOperations } from './runtime.js'
import { hostTerminalOperations } from './host-terminal.js'
import { proxyWorker } from './proxy.js'
import { pm2Operations, socketTransport } from './pm2.js'

const config = readConfig()
const pm2 = config.pm2Enabled
  ? pm2Operations(socketTransport(config.pm2Home))
  : undefined
const collectSnapshot = createCollector(config.dockerSocket, config.host)
if (!/^[A-Za-z0-9_-]{43}$/.test(config.token))
  throw new Error(
    'CONNECTOR_TOKEN must be a credential created in the dashboard',
  )
const shutdown = new AbortController()
const addresses = publicAddressDiscovery(shutdown.signal)
const runtimeEnabled =
  config.dockerEnabled && process.env.RUNTIME_ENABLED === 'true'
const forwardingEnabled =
  config.dockerEnabled && process.env.FORWARDING_ENABLED === 'true'
const forwarding = forwardingEnabled
  ? forwardingWorker(config, shutdown.signal)
  : Promise.resolve()
const databasesEnabled =
  config.dockerEnabled && process.env.DATABASES_ENABLED === 'true'
const databases = databasesEnabled
  ? databaseWorker(config, shutdown.signal)
  : Promise.resolve()
const proxyEnabled =
  config.dockerEnabled && process.env.PROXY_ENABLED === 'true'
const runtime = runtimeOperations(config)
const hostTerminal = hostTerminalOperations(config)
const services =
  config.dockerEnabled && config.deploymentsEnabled
    ? serviceWorker(config, shutdown.signal)
    : Promise.resolve()
const proxy = proxyEnabled
  ? proxyWorker(config, shutdown.signal)
  : Promise.resolve()
const worker =
  config.dockerEnabled && config.deploymentsEnabled
    ? deploymentWorker(config, shutdown.signal)
    : Promise.resolve()
let apiReachable = false,
  dockerReachable = false,
  pm2Reachable = false,
  current: WebSocket | undefined
const health = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/health') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      status: 'ok',
      apiReachable,
      dockerReachable,
      pm2Reachable,
    }),
  )
})
health.listen(config.healthPort, '127.0.0.1')
health.on('error', (error) => {
  console.error(error.message)
  shutdown.abort()
  current?.terminate()
  process.exitCode = 1
})
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    shutdown.abort()
    current?.terminate()
  })
const url = new URL('connectors/ws', config.apiUrl)
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
let backoff = 1000
try {
  while (!shutdown.signal.aborted) {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${config.token}` },
        handshakeTimeout: 5000,
        maxPayload: 65536,
      })
      current = ws
      let timer: NodeJS.Timeout | undefined,
        awaiting = false
      let pm2Timer: NodeJS.Timeout | undefined,
        pm2Awaiting = false
      const sendPm2 = async () => {
        if (!pm2 || shutdown.signal.aborted) return
        if (pm2Awaiting) {
          ws.terminate()
          return
        }
        let workers: Awaited<ReturnType<typeof pm2.collect>> = []
        try {
          workers = await pm2.collect()
          pm2Reachable = true
        } catch {
          pm2Reachable = false
        }
        if (ws.readyState !== WebSocket.OPEN) return
        const data = JSON.stringify({
          version: 1,
          type: 'pm2-snapshot',
          host: config.host,
          available: pm2Reachable,
          workers,
        })
        if (Buffer.byteLength(data) > 2 * 1024 * 1024) {
          ws.terminate()
          return
        }
        pm2Awaiting = true
        ws.send(data)
        pm2Timer = setTimeout(() => void sendPm2(), config.pollIntervalMs)
      }
      const send = async () => {
        if (awaiting) {
          ws.terminate()
          return
        }
        try {
          const snapshot = await collectSnapshot()
          dockerReachable = true
          if (ws.readyState === WebSocket.OPEN) {
            const data = JSON.stringify({
              ...snapshot,
              public_addresses: addresses.snapshot(),
            })
            if (Buffer.byteLength(data) > 2 * 1024 * 1024)
              throw new Error('Snapshot exceeds protocol limit')
            awaiting = true
            ws.send(data)
          }
        } catch (error) {
          dockerReachable = false
          console.error(
            'Collection failed:',
            error instanceof Error ? error.message : 'Unknown error',
          )
        }
        if (ws.readyState === WebSocket.OPEN)
          timer = setTimeout(() => {
            void send()
          }, config.pollIntervalMs)
      }
      let heartbeat: NodeJS.Timeout | undefined
      const touch = () => {
        clearTimeout(heartbeat)
        heartbeat = setTimeout(() => ws.terminate(), 30000)
      }
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'capabilities',
            capabilities: [
              ...(runtimeEnabled ? ['runtime'] : []),
              ...(config.dockerEnabled && config.deploymentsEnabled
                ? ['deploy', 'rollout-v1']
                : []),
              ...(proxyEnabled ? ['proxy'] : []),
              ...(databasesEnabled ? ['postgres'] : []),
              ...(forwardingEnabled ? ['forwarding'] : []),
              ...(pm2 ? ['pm2'] : []),
              ...(config.hostTerminal ? ['host-terminal'] : []),
            ],
          }),
        )
        touch()
        if (config.dockerEnabled) void send()
        if (pm2) void sendPm2()
      })
      ws.on('ping', touch)
      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString())
          if (message.type === 'operation') {
            if (message.operation?.kind === 'host-terminal') {
              void hostTerminal
                .execute(message.operation)
                .then((result) => {
                  if (ws.readyState === WebSocket.OPEN)
                    ws.send(
                      JSON.stringify({
                        type: 'operation-result',
                        id: message.id,
                        result,
                      }),
                    )
                })
                .catch(() => {
                  if (ws.readyState === WebSocket.OPEN)
                    ws.send(
                      JSON.stringify({
                        type: 'operation-result',
                        id: message.id,
                        error:
                          'Host SSH terminal unavailable; check connector SSH configuration and host access',
                      }),
                    )
                })
              return
            }
            if (message.operation?.kind === 'pm2') {
              void (
                pm2
                  ? pm2.execute(message.operation)
                  : Promise.reject(new Error('PM2 disabled'))
              )
                .then((result) => {
                  if (ws.readyState === WebSocket.OPEN)
                    ws.send(
                      JSON.stringify({
                        type: 'operation-result',
                        id: message.id,
                        result,
                      }),
                    )
                })
                .catch(() => {
                  if (ws.readyState === WebSocket.OPEN)
                    ws.send(
                      JSON.stringify({
                        type: 'operation-result',
                        id: message.id,
                        error:
                          'PM2 operation unavailable or failed; inspect host state before retrying',
                      }),
                    )
                })
              return
            }
            if (!runtimeEnabled || message.operation?.kind !== 'runtime') {
              ws.send(
                JSON.stringify({
                  type: 'operation-result',
                  id: message.id,
                  error: 'Runtime operations are disabled',
                }),
              )
              return
            }
            void runtime
              .execute(message.operation)
              .then((result) => {
                if (ws.readyState === WebSocket.OPEN)
                  ws.send(
                    JSON.stringify({
                      type: 'operation-result',
                      id: message.id,
                      result,
                    }),
                  )
              })
              .catch(() => {
                if (ws.readyState === WebSocket.OPEN)
                  ws.send(
                    JSON.stringify({
                      type: 'operation-result',
                      id: message.id,
                      error:
                        'Runtime operation failed; inspect host state before retrying',
                    }),
                  )
              })
            return
          }
          if (JSON.parse(raw.toString()).type === 'accepted') {
            if (message.runtime === 'pm2') pm2Awaiting = false
            else awaiting = false
            apiReachable = true
            backoff = 1000
            touch()
          }
        } catch {
          ws.terminate()
        }
      })
      ws.on('error', (error) =>
        console.error('Connector connection failed:', error.message),
      )
      ws.on('close', () => {
        hostTerminal.close()
        runtime.close()
        pm2?.close()
        clearTimeout(timer)
        clearTimeout(pm2Timer)
        clearTimeout(heartbeat)
        apiReachable = false
        resolve()
      })
    })
    if (!shutdown.signal.aborted) {
      await delay(backoff + Math.random() * 500, undefined, {
        signal: shutdown.signal,
      }).catch(() => {})
      backoff = Math.min(30000, backoff * 2)
    }
  }
} finally {
  shutdown.abort()
  await worker
  await services
  await databases
  await forwarding
  await proxy
  await addresses.work
  runtime.close()
  hostTerminal.close()
  pm2?.close()
  health.close()
}
