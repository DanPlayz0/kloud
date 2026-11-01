import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retentionPlan, signedS3Request } from './postgres-storage.js'
import { archiveVersions } from './postgres-recovery.js'

test('retention preserves minimum points and rejects storage-cap conflicts without pruning protected points', () => {
  const points = [1, 2, 3].map((n) => ({
    id: String(n),
    metadata: { size: 100 },
    created: String(n),
  }))
  assert.deepEqual(
    retentionPlan(points, 100, 300, 2).map((p) => p.id),
    ['1'],
  )
  assert.throws(() => retentionPlan(points, 100, 200, 2), /minimum retained/)
  assert.throws(() => retentionPlan(points, 100, 200, 3), /minimum retained/)
  assert.deepEqual(retentionPlan(points, 0, 300, 3), [])
  assert.throws(() => retentionPlan(points, 1, 100, 0), /Invalid/)
})
test('S3 signing scopes HTTPS requests to bucket/key and keeps raw credentials out of URLs', () => {
  const config = {
    kind: 's3' as const,
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'backups',
    prefix: 'kloud',
    accessKey: 'ACCESS',
    secretKey: 'secret',
  }
  const signed = signedS3Request(
    config,
    'PUT',
    'policy/file.dump',
    '0'.repeat(64),
    new Date('2026-11-01T12:00:00Z'),
  )
  assert.equal(
    signed.url.href,
    'https://s3.example.com/backups/policy/file.dump',
  )
  assert.equal(signed.headers['x-amz-date'], '20261101T120000Z')
  assert.match(
    signed.headers.authorization,
    /Credential=ACCESS\/20261101\/us-east-1\/s3\/aws4_request/,
  )
  assert.ok(!JSON.stringify(signed).includes('secret'))
  assert.throws(() =>
    signedS3Request(
      { ...config, endpoint: 'http://example.com' },
      'GET',
      'x',
      '0'.repeat(64),
    ),
  )
})
test('PostgreSQL archive preflight derives actual versions and extensions from archive listing', () => {
  assert.deepEqual(
    archiveVersions(
      '; Dumped from database version: 16.10\n; Dumped by pg_dump version: 17.6\n2; 3079 16422 EXTENSION - pgcrypto\n3; 3079 16423 EXTENSION - plpgsql',
    ),
    {
      sourceVersion: '16.10',
      dumpClientVersion: '17.6',
      extensions: ['pgcrypto', 'plpgsql'],
    },
  )
  assert.throws(
    () =>
      archiveVersions(
        '; Dumped from database version: 18.1\n; Dumped by pg_dump version: 18.1',
      ),
    /newer/,
  )
  assert.throws(
    () => archiveVersions('not a versioned archive listing'),
    /versions/,
  )
})
