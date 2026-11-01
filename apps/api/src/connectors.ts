import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { snapshotSchema } from '@kloud/protocol'
import { pool, transaction } from './db.js'
import { digest } from './security.js'
import { registerRpc, acceptRpc } from './connector-rpc.js'
import { acceptPm2Snapshot } from './pm2-inventory.js'

export async function acceptSnapshot(
  connector: string,
  raw: unknown,
  isCurrent = () => true,
) {
  const snapshot = snapshotSchema.parse(raw)
  return transaction(async (db) => {
    // A replaced connection may already be waiting on this lock. Check ownership
    // after acquiring it so an old snapshot cannot overwrite its replacement.
    const active = await db.query(
      'SELECT id FROM connectors WHERE id=$1 AND NOT revoked FOR UPDATE',
      [connector],
    )
    if (!active.rowCount || !isCurrent()) return false
    const result = await db.query(
      'UPDATE connectors SET host=$1,seen=now(),docker_seen=now() WHERE id=$2 AND NOT revoked RETURNING discovery',
      [snapshot.host, connector],
    )
    if (!result.rowCount) return false
    if (snapshot.public_addresses)
      await db.query('UPDATE connectors SET public_addresses=$2 WHERE id=$1', [
        connector,
        snapshot.public_addresses,
      ])
    const discovery = result.rows[0].discovery
    await db.query('DELETE FROM inventory WHERE connector_id=$1', [connector])
    const assigned = new Set(
      (
        await db.query(
          'SELECT container_id FROM assignments WHERE connector_id=$1',
          [connector],
        )
      ).rows.map((r) => r.container_id),
    )
    const containers = snapshot.containers.filter(
      (item) =>
        discovery ||
        assigned.has(item.id) ||
        (item.project && item.application),
    )
    if (containers.length)
      await db.query(
        `INSERT INTO inventory(connector_id,container_id,data) SELECT $1,x->>'id',x FROM jsonb_array_elements($2::jsonb) x`,
        [connector, JSON.stringify(containers)],
      )
    await db.query(
      'DELETE FROM assignments WHERE connector_id=$1 AND container_id NOT IN (SELECT container_id FROM inventory WHERE connector_id=$1)',
      [connector],
    )
    return true
  })
}

export function attachConnectors(server: Server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
  })
  const connections = new Map<string, import('ws').WebSocket>()
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      if (request.url !== '/connectors/ws') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        return
      }
      const value = request.headers.authorization?.match(
        /^Bearer ([A-Za-z0-9_-]{43})$/,
      )?.[1]
      const connector = value
        ? (
            await pool.query(
              'SELECT id FROM connectors WHERE token=$1 AND NOT revoked',
              [digest(value)],
            )
          ).rows[0]
        : null
      if (!connector) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        connections.get(connector.id)?.terminate()
        connections.set(connector.id, ws)
        registerRpc(connector.id, ws)
        let alive = true
        const busy = new Set<string>()
        ws.on('pong', () => {
          alive = true
        })
        ws.on('error', () => ws.terminate())
        const heartbeat = setInterval(() => {
          void (async () => {
            if (
              !alive ||
              !(
                await pool.query(
                  'SELECT 1 FROM connectors WHERE id=$1 AND token=$2 AND NOT revoked',
                  [connector.id, digest(value!)],
                )
              ).rowCount
            ) {
              ws.terminate()
              return
            }
            alive = false
            ws.ping()
          })().catch(() => ws.terminate())
        }, 10000)
        // Recheck after registration to cover rotation during the upgrade query.
        void pool
          .query(
            'SELECT 1 FROM connectors WHERE id=$1 AND token=$2 AND NOT revoked',
            [connector.id, digest(value!)],
          )
          .then((result) => {
            if (!result.rowCount) ws.terminate()
          })
          .catch(() => ws.terminate())
        ws.on('close', () => {
          clearInterval(heartbeat)
          if (connections.get(connector.id) === ws)
            connections.delete(connector.id)
        })
        ws.on('message', (data, binary) => {
          if (
            binary ||
            connections.get(connector.id) !== ws ||
            ws.readyState !== WebSocket.OPEN
          ) {
            ws.close(1008, 'Invalid message')
            return
          }
          let message: any
          try {
            message = JSON.parse(data.toString())
          } catch {
            ws.close(1008)
            return
          }
          if (
            !message ||
            typeof message !== 'object' ||
            Array.isArray(message)
          ) {
            ws.close(1008, 'Invalid message')
            return
          }
          if (message.type === 'operation-result') {
            acceptRpc(connector.id, message)
            return
          }
          if (message.type === 'capabilities') {
            const allowed = [
              'runtime',
              'deploy',
              'rollout-v1',
              'proxy',
              'pm2',
              'host-terminal',
              'postgres',
              'forwarding',
            ]
            if (
              !Array.isArray(message.capabilities) ||
              message.capabilities.some(
                (v: unknown) => !allowed.includes(String(v)),
              )
            ) {
              ws.close(1008)
              return
            }
            void pool
              .query(
                'UPDATE connectors SET capabilities=$2 WHERE id=$1 AND token=$3 AND NOT revoked',
                [connector.id, message.capabilities, digest(value!)],
              )
              .catch(() => ws.terminate())
            return
          }
          if (
            !['snapshot', 'pm2-snapshot'].includes(message.type) ||
            busy.has(message.type)
          ) {
            ws.close(1008, 'Invalid message')
            return
          }
          const type: string = message.type
          busy.add(type)
          void (async () => {
            const accepted = await (
              message.type === 'pm2-snapshot'
                ? acceptPm2Snapshot
                : acceptSnapshot
            )(
              connector.id,
              message,
              () =>
                connections.get(connector.id) === ws &&
                ws.readyState === WebSocket.OPEN,
            )
            if (!accepted) ws.close(1008, 'Credential revoked')
            else if (ws.readyState === WebSocket.OPEN)
              ws.send(
                JSON.stringify({
                  type: 'accepted',
                  version: 1,
                  ...(message.type === 'pm2-snapshot'
                    ? { runtime: 'pm2' }
                    : {}),
                }),
              )
          })()
            .catch(() => ws.close(1008, 'Snapshot rejected'))
            .finally(() => {
              busy.delete(type)
            })
        })
      })
    })().catch(() => socket.destroy())
  })
  return () => {
    for (const ws of wss.clients) ws.terminate()
    wss.close()
  }
}
