import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import dgram from 'node:dgram'
import {
  listenerSchema,
  sourceAllowed,
  validCidr,
  type ListenerConfig,
} from '@kloud/protocol/forwarding'
import { startListener } from './forwarding.js'

const rule: ListenerConfig = {
  protocol: 'tcp',
  bind_address: '127.0.0.1',
  port: 15000,
  container: 'app',
  network: 'app',
  target_port: 15001,
  sources: [],
  enabled: false,
  application_protocol: 'generic',
}
test('CIDRs validate without discarding bad entries and match both address families', () => {
  for (const value of [
    '10.0.0.0/8',
    '0.0.0.0/0',
    '::/0',
    '2001:db8::/32',
    '::1/128',
  ])
    assert.ok(validCidr(value), value)
  for (const value of [
    '',
    '10.0.0.1',
    '10.0.0.0/-1',
    '10.0.0.0/33',
    '::/129',
    'bad/0',
    '::/0/0',
  ])
    assert.ok(!validCidr(value), value)
  assert.ok(sourceAllowed('203.0.113.2', []))
  assert.ok(sourceAllowed('::ffff:10.2.3.4', ['10.0.0.0/8']))
  assert.ok(sourceAllowed('2001:db8::abcd', ['2001:db8::/32']))
  assert.ok(!sourceAllowed('2001:db9::1', ['2001:db8::/32']))
  assert.ok(!sourceAllowed('10.1.2.3', ['10.0.0.0/8', 'INVALID']))
  assert.ok(!sourceAllowed('not-an-ip', []))
})
test('listeners default disabled and reject protected ports, invalid allowlists and PostgreSQL without native TLS', () => {
  const { enabled, ...input } = rule
  assert.equal(listenerSchema.parse(input).enabled, false)
  assert.ok(!listenerSchema.safeParse({ ...rule, port: 3000 }).success)
  assert.ok(
    !listenerSchema.safeParse({ ...rule, sources: ['invalid'] }).success,
  )
  assert.ok(
    !listenerSchema.safeParse({ ...rule, enabled: true, target_port: 5432 })
      .success,
  )
  assert.ok(
    !listenerSchema.safeParse({
      ...rule,
      enabled: true,
      application_protocol: 'postgresql',
    }).success,
  )
})
async function port() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return value
}
function tcp(port: number) {
  return new Promise<string>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let data = ''
    socket.setTimeout(1000, () => socket.destroy())
    socket.on('connect', () => socket.write('hello'))
    socket.on('data', (chunk) => {
      data += chunk.toString()
      socket.destroy()
    })
    socket.on('error', () => resolve(data))
    socket.on('close', () => resolve(data))
  })
}
test('real TCP listener forwards allowed sources, rejects denied sources and frees its port on removal', async () => {
  const backend = net.createServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const target_port = (backend.address() as net.AddressInfo).port
  const publicPort = await port()
  let listener = await startListener(
    {
      ...rule,
      enabled: true,
      port: publicPort,
      target_port,
      sources: ['127.0.0.1/32'],
    },
    '127.0.0.1',
  )
  try {
    assert.equal(await tcp(publicPort), 'hello')
    listener.close()
    listener = await startListener(
      {
        ...rule,
        enabled: true,
        port: publicPort,
        target_port,
        sources: ['10.0.0.0/8'],
      },
      '127.0.0.1',
    )
    assert.equal(await tcp(publicPort), '')
  } finally {
    listener.close()
    await new Promise<void>((resolve) => backend.close(() => resolve()))
  }
})
test('real UDP listener checks source before proxying and can share a numeric TCP port', async () => {
  const backend = dgram.createSocket('udp4')
  backend.on('message', (data, peer) =>
    backend.send(data, peer.port, peer.address),
  )
  await new Promise<void>((resolve) => backend.bind(0, '127.0.0.1', resolve))
  const target_port = backend.address().port,
    publicPort = await port()
  const occupiedTcp = net.createServer()
  await new Promise<void>((resolve) =>
    occupiedTcp.listen(publicPort, '127.0.0.1', resolve),
  )
  const send = () =>
    new Promise<string>((resolve) => {
      const client = dgram.createSocket('udp4')
      const timer = setTimeout(() => {
        client.close()
        resolve('')
      }, 300)
      client.once('message', (value) => {
        clearTimeout(timer)
        client.close()
        resolve(value.toString())
      })
      client.send(Buffer.from('hello'), publicPort, '127.0.0.1')
    })
  let listener = await startListener(
    { ...rule, protocol: 'udp', port: publicPort, target_port, sources: [] },
    '127.0.0.1',
  )
  try {
    assert.equal(await send(), 'hello')
    listener.close()
    listener = await startListener(
      {
        ...rule,
        protocol: 'udp',
        port: publicPort,
        target_port,
        sources: ['10.0.0.0/8'],
      },
      '127.0.0.1',
    )
    assert.equal(await send(), '')
  } finally {
    listener.close()
    backend.close()
    occupiedTcp.close()
  }
})
