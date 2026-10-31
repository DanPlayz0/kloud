import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerRpc, connectorRpc, acceptRpc } from './connector-rpc.js'
function socket() {
  let message: any
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    send(value: string) {
      message = JSON.parse(value)
    },
    message() {
      return message
    },
  })
}
test('runtime results cannot cross connectors and stale connections cannot cancel replacement operations', async () => {
  const old = socket(),
    replacement = socket()
  registerRpc('host-a', old as any)
  const first = connectorRpc('host-a', { action: 'logs' })
  acceptRpc('host-b', { id: old.message().id, result: 'wrong host' })
  acceptRpc('host-a', { id: old.message().id, result: 'correct host' })
  assert.equal(await first, 'correct host')
  registerRpc('host-a', replacement as any)
  const next = connectorRpc('host-a', { action: 'inspect' })
  old.emit('close')
  acceptRpc('host-a', {
    id: replacement.message().id,
    result: 'new connection',
  })
  assert.equal(await next, 'new connection')
  const disconnected = assert.rejects(
    connectorRpc('host-a', { action: 'restart' }),
    /disconnected/,
  )
  replacement.emit('close')
  await disconnected
  assert.throws(() => connectorRpc('host-a', {}), /disconnected/)
})
