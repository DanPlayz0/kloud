import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPublicIPv4,
  isPublicIPv6,
  publicAddressesSchema,
} from '@kloud/protocol/addresses'
import { publicAddressDiscovery } from './public-addresses.js'

test('address discovery excludes local, documentation, multicast and transition ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '100.64.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '999.1.1.1',
  ])
    assert.equal(isPublicIPv4(address), false, address)
  assert.equal(isPublicIPv4('1.1.1.1'), true)
  for (const address of [
    '::',
    '::1',
    '::ffff:1.1.1.1',
    'fc00::1',
    'fe80::1',
    'ff00::1',
    '2001:db8::1',
    '2002::1',
    '3fff::1',
  ])
    assert.equal(isPublicIPv6(address), false, address)
  assert.equal(isPublicIPv6('2606:4700:4700::1111'), true)
  assert.equal(isPublicIPv6('2001:4860:4860::8888'), true)
})
test('independent family failures leave ordinary discovery usable and support missing IPv6', async () => {
  const stop = new AbortController()
  const discovery = publicAddressDiscovery(
    stop.signal,
    async (_url, family) => {
      if (family === 6) throw new Error('network failure')
      return '1.1.1.1'
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  const snapshot = discovery.snapshot()
  assert.equal(snapshot.ipv4.status, 'ready')
  assert.equal(snapshot.ipv6.status, 'error')
  assert.equal(snapshot.ipv6.address, null)
  assert.equal(publicAddressesSchema.safeParse(snapshot).success, true)
  stop.abort()
  await discovery.work
})
