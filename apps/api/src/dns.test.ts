import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dnsFields,
  dnsTypes,
  dnsRecordSchema,
  dnsRuleSchema,
  type DnsRule,
} from '@dedi-dash/protocol/dns'
import {
  allowsDns,
  dnsName,
  normalizeDnsRule,
  matchesDnsRule,
  intersectDnsRules,
} from './dns-permissions.js'
import {
  CloudflareDns,
  encryptDnsToken,
  decryptDnsToken,
  serializeDnsRecord,
} from './dns-provider.js'

const rule = (kind: DnsRule['kind'], target: string | null): DnsRule => ({
  kind,
  target,
  types: ['A', 'TXT'],
  actions: ['read', 'create', 'update', 'delete'],
})
test('DNS normalization and scope matching respect labels, ID, type and literal wildcards', () => {
  assert.equal(dnsName('BÜCHER.example.'), 'xn--bcher-kva.example')
  assert.equal(dnsName('_sip._tcp.example.com'), '_sip._tcp.example.com')
  for (const name of ['bad..com', 'example.com/path', 'example.com:80'])
    assert.throws(() => dnsName(name))
  const subtree = rule('subtree', 'voice.example.com')
  for (const name of ['voice.example.com', 'a.voice.example.com'])
    assert.equal(matchesDnsRule(subtree, 'read', { name, type: 'A' }), true)
  for (const name of ['evilvoice.example.com', 'voice.example.com.evil'])
    assert.equal(matchesDnsRule(subtree, 'read', { name, type: 'A' }), false)
  assert.equal(
    matchesDnsRule(rule('name', '*.example.com'), 'read', {
      name: 'a.example.com',
      type: 'A',
    }),
    false,
  )
  assert.equal(
    matchesDnsRule(rule('name', '*.example.com'), 'read', {
      name: '*.example.com',
      type: 'A',
    }),
    true,
  )
  const record = {
    ...rule('record', 'abc'),
    actions: ['read', 'update'] as DnsRule['actions'],
  }
  assert.equal(
    matchesDnsRule(record, 'update', {
      id: 'abc',
      name: 'a.example.com',
      type: 'A',
    }),
    true,
  )
  assert.equal(
    matchesDnsRule(record, 'update', {
      id: 'abc',
      name: 'a.example.com',
      type: 'MX',
    }),
    false,
  )
  assert.equal(
    matchesDnsRule(record, 'read', {
      id: 'new',
      name: 'a.example.com',
      type: 'A',
    }),
    false,
  )
  assert.equal(dnsRuleSchema.safeParse(rule('record', 'abc')).success, false)
  assert.deepEqual(
    normalizeDnsRule(
      { ...rule('name', 'A.Example.Com.'), actions: ['update'] },
      'example.com',
    ).actions,
    ['update', 'read'],
  )
  assert.throws(() =>
    normalizeDnsRule(rule('subtree', 'evil.com'), 'example.com'),
  )
})
test('member/project intersection prevents escalation and name/type escapes', () => {
  const project = [rule('subtree', 'voice.example.com')],
    member = [{ ...rule('zone', null), types: ['A'] }]
  assert.equal(
    allowsDns(project, member, 'update', {
      name: 'voice.example.com',
      type: 'A',
    }),
    true,
  )
  assert.equal(
    allowsDns(project, member, 'update', {
      name: 'mail.example.com',
      type: 'A',
    }),
    false,
  )
  assert.equal(
    allowsDns(project, member, 'update', {
      name: 'voice.example.com',
      type: 'TXT',
    }),
    false,
  )
  assert.equal(
    allowsDns(project, [], 'read', { name: 'voice.example.com', type: 'A' }),
    false,
  )
  assert.equal(
    allowsDns(project, null, 'update', {
      name: 'voice.example.com',
      type: 'TXT',
    }),
    true,
  )
  assert.equal(
    intersectDnsRules(project[0]!, member[0]!)?.target,
    'voice.example.com',
  )
  assert.equal(
    intersectDnsRules(project[0]!, rule('subtree', 'mail.example.com')),
    null,
  )
})
test('DNS encryption uses authenticated randomized ciphertext and fails closed', () => {
  const before = process.env.DNS_ENCRYPTION_KEY
  try {
    process.env.DNS_ENCRYPTION_KEY = '12'.repeat(32)
    const a = encryptDnsToken('super-secret-token'),
      b = encryptDnsToken('super-secret-token')
    assert.notEqual(a, b)
    assert.ok(!a.includes('super-secret'))
    assert.equal(decryptDnsToken(a), 'super-secret-token')
    const parts = a.split('.')
    parts[1] = Buffer.alloc(16).toString('base64url')
    assert.throws(() => decryptDnsToken(parts.join('.')))
    process.env.DNS_ENCRYPTION_KEY = '34'.repeat(32)
    assert.throws(() => decryptDnsToken(a))
    delete process.env.DNS_ENCRYPTION_KEY
    assert.throws(() => encryptDnsToken('token'))
  } finally {
    if (before === undefined) delete process.env.DNS_ENCRYPTION_KEY
    else process.env.DNS_ENCRYPTION_KEY = before
  }
})
test('all Cloudflare record types validate and serialize; invalid forms are rejected', () => {
  assert.equal(dnsTypes.length, 21)
  for (const type of dnsTypes) {
    const fields = Object.fromEntries(
      Object.entries(dnsFields[type]!).map(([key, spec]) => [
        key,
        type === 'A'
          ? '192.0.2.1'
          : type === 'AAAA'
            ? '2001:db8::1'
            : key === 'lat_direction'
              ? 'N'
              : key === 'long_direction'
                ? 'W'
                : typeof spec === 'number' ||
                    (type === 'LOC' &&
                      [
                        'altitude',
                        'size',
                        'precision_horz',
                        'precision_vert',
                      ].includes(key))
                  ? 0
                  : 'example.com',
      ]),
    )
    const parsed = dnsRecordSchema.parse({
      type,
      name: 'example.com',
      ttl: 1,
      ...(Object.hasOwn(fields, 'content') ? fields : { data: fields }),
    })
    const serialized = serializeDnsRecord(parsed)
    if (type === 'URI') {
      assert.equal(serialized.priority, 0)
      assert.ok(!Object.hasOwn(serialized.data!, 'priority'))
    }
    assert.equal(serialized.type, type)
  }
  assert.equal(
    dnsRecordSchema.safeParse({
      type: 'A',
      name: 'x',
      ttl: 1,
      content: 'invalid',
    }).success,
    false,
  )
  assert.equal(
    dnsRecordSchema.safeParse({
      type: 'TXT',
      name: 'x',
      ttl: 1,
      content: 'hello',
      proxied: true,
    }).success,
    false,
  )
})
test('Cloudflare pagination and provider errors never expose raw provider text or tokens', async () => {
  let calls = 0
  const request: typeof fetch = async (_url, init) => {
    assert.equal(new URL(String(_url)).searchParams.get('per_page'), '50')
    calls++
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer secret',
    )
    return Response.json({
      success: true,
      result: [{ id: String(calls), name: 'example.com' }],
      result_info: { total_pages: 2 },
    })
  }
  assert.equal((await new CloudflareDns('secret', request).zones()).length, 2)
  assert.equal(calls, 2)
  for (const status of [400, 403, 404, 429, 500]) {
    const client = new CloudflareDns('secret', async () =>
      Response.json(
        { success: false, errors: [{ message: 'secret-private-error' }] },
        { status },
      ),
    )
    await assert.rejects(
      client.zones(),
      (e) => e instanceof Error && !e.message.includes('secret-private-error'),
    )
  }
  const client = new CloudflareDns('secret', async () => {
    throw new Error('secret')
  })
  await assert.rejects(
    client.create('zone', {
      type: 'TXT',
      name: 'example.com',
      ttl: 1,
      content: 'hello',
    }),
    /Refresh records before retrying/,
  )
})
