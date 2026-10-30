import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { readConfig } from './config.js'
import { collect } from './docker.js'

const config = readConfig()
if (!/^[A-Za-z0-9_-]{43}$/.test(config.token))
  throw new Error(
    'CONNECTOR_TOKEN must be a credential created in the dashboard',
  )
const shutdown = new AbortController()
let apiReachable = false,
  dockerReachable = false,
  current: WebSocket | undefined
const health = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/health') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ status: 'ok', apiReachable, dockerReachable }))
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
        maxPayload: 1024,
      })
      current = ws
      let timer: NodeJS.Timeout | undefined,
        awaiting = false
      const send = async () => {
        if (awaiting) {
          ws.terminate()
          return
        }
        try {
          const snapshot = await collect(config.dockerSocket, config.host)
          dockerReachable = true
          if (ws.readyState === WebSocket.OPEN) {
            const data = JSON.stringify(snapshot)
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
        touch()
        void send()
      })
      ws.on('ping', touch)
      ws.on('message', (raw) => {
        try {
          if (JSON.parse(raw.toString()).type === 'accepted') {
            awaiting = false
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
        clearTimeout(timer)
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
  health.close()
}
