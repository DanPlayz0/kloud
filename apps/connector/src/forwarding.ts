import net from 'node:net'
import dgram from 'node:dgram'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  listenerSchema,
  sourceAllowed,
  type ListenerConfig,
} from '@kloud/protocol/forwarding'
import { engine } from './deployment-process.js'
import type { ConnectorConfig } from './config.js'

export async function startListener(
  config: ListenerConfig,
  address: string,
): Promise<{ close: () => void }> {
  const clients = new Set<net.Socket>()
  if (config.protocol === 'tcp') {
    const server = net.createServer((client) => {
      if (
        !client.remoteAddress ||
        !sourceAllowed(client.remoteAddress, config.sources) ||
        clients.size >= 2048
      ) {
        client.destroy()
        return
      }
      clients.add(client)
      const upstream = net.createConnection({
        host: address,
        port: config.target_port,
      })
      clients.add(upstream)
      upstream.setTimeout(10000, () => {
        if (upstream.connecting) upstream.destroy()
      })
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      client.on('close', () => {
        clients.delete(client)
        upstream.destroy()
      })
      upstream.on('close', () => {
        clients.delete(upstream)
        client.destroy()
      })
      upstream.on('connect', () => {
        upstream.setTimeout(0)
        client.pipe(upstream)
        upstream.pipe(client)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(
        { host: config.bind_address, port: config.port, ipv6Only: true },
        () => {
          server.removeListener('error', reject)
          resolve()
        },
      )
    })
    server.on('error', () => {
      for (const socket of clients) socket.destroy()
    })
    return {
      close: () => {
        for (const socket of clients) socket.destroy()
        server.close()
      },
    }
  }
  const server = dgram.createSocket({
    type: config.bind_address.includes(':') ? 'udp6' : 'udp4',
    ...(config.bind_address.includes(':') ? { ipv6Only: true } : {}),
  })
  const sessions = new Map<string, { socket: dgram.Socket; last: number }>()
  const reap = setInterval(() => {
    for (const [key, session] of sessions)
      if (Date.now() - session.last > 60000) {
        session.socket.close()
        sessions.delete(key)
      }
  }, 10000)
  server.on('message', (message, peer) => {
    if (!sourceAllowed(peer.address, config.sources)) return
    const key = `${peer.address}:${peer.port}`
    let session = sessions.get(key)
    if (!session) {
      if (sessions.size >= 1024) return
      const socket = dgram.createSocket(address.includes(':') ? 'udp6' : 'udp4')
      session = { socket, last: Date.now() }
      sessions.set(key, session)
      socket.on('error', () => {
        if (sessions.delete(key)) socket.close()
      })
      socket.on('message', (reply) => {
        if (sessions.has(key))
          server.send(reply, peer.port, peer.address, () => {})
      })
      socket.connect(config.target_port, address, () =>
        socket.send(message, () => {}),
      )
    } else {
      try {
        session.socket.send(message, () => {})
      } catch {
        return
      }
    }
    session.last = Date.now()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.bind({ address: config.bind_address, port: config.port }, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    clearInterval(reap)
    try {
      server.close()
    } catch {}
    throw error
  }
  server.on('error', () => {})
  return {
    close: () => {
      clearInterval(reap)
      for (const session of sessions.values()) session.socket.close()
      sessions.clear()
      server.close()
    },
  }
}
export async function forwardingWorker(
  config: ConnectorConfig,
  signal: AbortSignal,
) {
  const allowedBindings = (process.env.FORWARDING_BIND_ADDRESSES ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  if (
    !allowedBindings.length ||
    allowedBindings.some((value) => !net.isIP(value))
  )
    throw new Error(
      'Configure FORWARDING_BIND_ADDRESSES with administrator-approved local IP addresses',
    )
  const active = new Map<
    string,
    { generation: string; hash: string; close: () => void }
  >()
  let report: {
    id: string
    generation: string
    applied: boolean
    error: string | null
  }[] = []
  const closeAll = () => {
    for (const listener of active.values()) listener.close()
    active.clear()
  }
  try {
    while (!signal.aborted) {
      try {
        const response = await fetch(
          new URL('connectors/forwarding/sync', config.apiUrl),
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ listeners: report }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          },
        )
        if (!response.ok)
          throw new Error('Forwarding authorization unavailable')
        const { listeners } = (await response.json()) as { listeners: any[] }
        if (!Array.isArray(listeners) || listeners.length > 500)
          throw new Error('Invalid listener inventory')
        const desired = new Set(listeners.map((row) => row.id))
        for (const [id, listener] of active)
          if (!desired.has(id)) {
            listener.close()
            active.delete(id)
          }
        report = []
        for (const row of listeners) {
          try {
            const rule = listenerSchema.parse(row.config)
            if (!allowedBindings.includes(rule.bind_address))
              throw new Error(
                'Bind address is not approved by the server administrator',
              )
            const target = await engine(
              config.dockerSocket,
              'GET',
              `/containers/${encodeURIComponent(row.target)}/json`,
            )
            if (
              !target.State?.Running ||
              target.Config.Labels?.['kloud.project'] !== row.project ||
              target.Config.Labels?.['kloud.application'] !== row.service ||
              target.Config.Labels?.['kloud.internal'] === 'true'
            )
              throw new Error(
                'Listener target is unavailable or no longer belongs to this app',
              )
            if (
              rule.compose_service &&
              target.Config.Labels?.['com.docker.compose.service'] !==
                rule.compose_service
            )
              throw new Error(
                'Target does not match the configured Compose service',
              )
            if (
              /postgres/i.test(target.Config.Image ?? '') ||
              /postgres/i.test((target.Config.Cmd ?? []).join(' ')) ||
              target.Config.Labels?.['kloud.database']
            )
              throw new Error(
                'PostgreSQL public forwarding is blocked until native TLS and certificate renewal are verified',
              )
            const address =
              target.NetworkSettings.Networks?.[rule.network]?.IPAddress
            if (!address || !net.isIP(address))
              throw new Error(
                'Target is not attached to the configured Docker network',
              )
            const hash = createHash('sha256')
              .update(JSON.stringify([rule, address, row.generation]))
              .digest('hex')
            const prior = active.get(row.id)
            if (prior?.hash !== hash) {
              prior?.close()
              active.delete(row.id)
              const listener = await startListener(rule, address)
              active.set(row.id, {
                ...listener,
                hash,
                generation: row.generation,
              })
            }
            report.push({
              id: row.id,
              generation: row.generation,
              applied: true,
              error: null,
            })
          } catch (error) {
            active.get(row.id)?.close()
            active.delete(row.id)
            report.push({
              id: row.id,
              generation: row.generation,
              applied: false,
              error:
                error instanceof Error
                  ? error.message.slice(0, 256)
                  : 'Listener reconciliation failed',
            })
          }
        }
      } catch {
        closeAll()
        report = []
      }
      await delay(5000, undefined, { signal }).catch(() => {})
    }
  } finally {
    closeAll()
  }
}
