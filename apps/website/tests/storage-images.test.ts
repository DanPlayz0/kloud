import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storageEngine } from '../src/storage-images.ts'

test('recognizes database and cache image repositories with tags, registries and digests', () => {
  for (const image of [
    'postgres:17-alpine',
    'docker.io/library/postgres:17.6-alpine',
    'registry.example:5000/bitnami/postgresql:17',
    'postgres@sha256:' + 'a'.repeat(64),
    'ghcr.io/pgvector/pgvector:pg17',
  ])
    assert.deepEqual(storageEngine(image), {
      name: 'PostgreSQL',
      kind: 'database',
    })
  assert.deepEqual(storageEngine('mysql:8'), {
    name: 'MySQL',
    kind: 'database',
  })
  assert.deepEqual(storageEngine('mongo:8'), {
    name: 'MongoDB',
    kind: 'database',
  })
  assert.deepEqual(storageEngine('redis:7'), { name: 'Redis', kind: 'cache' })
  assert.deepEqual(storageEngine('valkey/valkey:8'), {
    name: 'Valkey',
    kind: 'cache',
  })
  assert.deepEqual(storageEngine('eqalpha/keydb:latest'), {
    name: 'KeyDB',
    kind: 'cache',
  })
})

test('unknown images and database tooling are not classified by substring', () => {
  for (const image of [
    undefined,
    '',
    'nginx:alpine',
    'my-postgres-app:latest',
    'postgres-exporter:latest',
    'redisinsight:latest',
    'dpage/pgadmin4:latest',
    'sha256:' + 'b'.repeat(64),
    'constructor',
    'toString',
  ]) {
    assert.equal(storageEngine(image), null, image)
  }
})
