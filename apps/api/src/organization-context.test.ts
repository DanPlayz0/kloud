import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import {
  bindOrganization,
  currentOrganization,
  runWithOrganization,
} from './organization-context.js'
import {
  acceptRpc,
  connectorRpc,
  disconnectConnector,
  registerRpc,
} from './connector-rpc.js'

const first = { slug: 'first', schema: 'org_first' }
const second = { slug: 'second', schema: 'org_second' }

test('bound event callbacks keep the originating organization even when emitted from another context', async () => {
  const defaultCallback = bindOrganization(() => currentOrganization())
  const emitter = new EventEmitter()
  let observed: string | undefined
  runWithOrganization(first, () => {
    emitter.on(
      'message',
      bindOrganization(() => {
        observed = currentOrganization()?.slug
      }),
    )
  })
  runWithOrganization(second, () => {
    assert.equal(defaultCallback(), undefined)
    emitter.emit('message')
    assert.equal(currentOrganization()?.slug, 'second')
  })
  assert.equal(observed, 'first')
  assert.equal(currentOrganization(), undefined)
})

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
    terminate() {
      this.emit('close')
    },
  })
}

test("connectors sharing an identifier in different organizations cannot receive or complete each other's RPCs", async () => {
  const a = socket(),
    b = socket()
  const connector = 'same-connector-id'
  runWithOrganization(first, () => registerRpc(connector, a as any))
  runWithOrganization(second, () => registerRpc(connector, b as any))
  const aResult = runWithOrganization(first, () =>
    connectorRpc(connector, { action: 'inspect' }),
  )
  const bResult = runWithOrganization(second, () =>
    connectorRpc(connector, { action: 'logs' }),
  )
  assert.throws(() => connectorRpc(connector, {}), /disconnected/)
  runWithOrganization(second, () =>
    acceptRpc(connector, { id: a.message().id, result: 'wrong organization' }),
  )
  runWithOrganization(first, () =>
    acceptRpc(connector, { id: a.message().id, result: 'first result' }),
  )
  runWithOrganization(second, () =>
    acceptRpc(connector, { id: b.message().id, result: 'second result' }),
  )
  assert.equal(await aResult, 'first result')
  assert.equal(await bResult, 'second result')
  runWithOrganization(first, () => disconnectConnector(connector))
  assert.throws(
    () => runWithOrganization(first, () => connectorRpc(connector, {})),
    /disconnected/,
  )
  const stillConnected = runWithOrganization(second, () =>
    connectorRpc(connector, { action: 'inspect' }),
  )
  runWithOrganization(second, () =>
    acceptRpc(connector, { id: b.message().id, result: 'still connected' }),
  )
  assert.equal(await stillConnected, 'still connected')
  runWithOrganization(second, () => disconnectConnector(connector))
})
