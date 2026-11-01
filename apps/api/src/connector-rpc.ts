import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import type { WebSocket } from 'ws'
import { organizationResourceKey } from './organization-context.js'
const connections = new Map<string, WebSocket>()
export function disconnectConnector(connector: string) {
  connector = organizationResourceKey(connector)
  const socket = connections.get(connector)
  connections.delete(connector)
  socket?.terminate()
}
const pending = new Map<
  string,
  {
    connector: string
    socket: WebSocket
    resolve: (value: any) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }
>()
export function registerRpc(connector: string, socket: WebSocket) {
  connector = organizationResourceKey(connector)
  connections.set(connector, socket)
  socket.once('close', () => {
    if (connections.get(connector) === socket) connections.delete(connector)
    for (const [id, entry] of pending)
      if (entry.connector === connector && entry.socket === socket) {
        clearTimeout(entry.timer)
        pending.delete(id)
        entry.reject(
          new HTTPException(503, {
            message: 'Host disconnected; operation outcome may be unknown',
          }),
        )
      }
  })
}
export function acceptRpc(connector: string, message: any) {
  connector = organizationResourceKey(connector)
  const entry = pending.get(message.id)
  if (!entry || entry.connector !== connector) return
  pending.delete(message.id)
  clearTimeout(entry.timer)
  if (message.error)
    entry.reject(
      new HTTPException(502, { message: String(message.error).slice(0, 500) }),
    )
  else entry.resolve(message.result)
}
export function connectorRpc(
  connector: string,
  operation: unknown,
  timeout = 35000,
): Promise<any> {
  connector = organizationResourceKey(connector)
  const socket = connections.get(connector)
  if (!socket || socket.readyState !== 1)
    throw new HTTPException(503, { message: 'Host is disconnected' })
  if (pending.size >= 200)
    throw new HTTPException(429, { message: 'Too many host operations' })
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(
        new HTTPException(504, {
          message:
            'Host operation timed out; check runtime state before retrying',
        }),
      )
    }, timeout)
    pending.set(id, { connector, socket, resolve, reject, timer })
    socket.send(JSON.stringify({ type: 'operation', id, operation }))
  })
}
