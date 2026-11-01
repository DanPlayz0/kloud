import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import {
  repositoryFromUrl,
  providerOrigin,
  appJwt,
  canonicalRepository,
} from './git-provider.js'
import { suggestDockerfile } from './repository-suggestions.js'

test('direct repository URLs accept canonical HTTPS without credentials or extra paths', () => {
  assert.equal(
    repositoryFromUrl(
      'https://github.com/owner/repo.git',
      'https://github.com',
    ),
    'owner/repo',
  )
  for (const value of [
    'https://token@github.com/owner/repo',
    'http://github.com/owner/repo',
    'https://evil.example/owner/repo',
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo?token=secret',
    'https://github.com/owner/repo#main',
  ])
    assert.throws(() => repositoryFromUrl(value, 'https://github.com'))
  assert.deepEqual(
    canonicalRepository(
      {
        id: 12,
        full_name: 'owner/repo',
        default_branch: 'main',
        private: true,
        clone_url: 'https://secret@evil.example',
      },
      'https://github.com',
    ),
    {
      id: '12',
      name: 'owner/repo',
      url: 'https://github.com/owner/repo',
      default_branch: 'main',
      private: true,
    },
  )
})
test('self-hosted credentials are sent only to explicitly administrator-authorized origins', () => {
  const previous = process.env.GIT_PROVIDER_ORIGINS
  process.env.GIT_PROVIDER_ORIGINS = 'https://git.example.com'
  try {
    assert.equal(
      providerOrigin('forgejo', 'https://git.example.com'),
      'https://git.example.com',
    )
    for (const value of [
      'https://127.0.0.1',
      'https://git.example.com/api',
      'https://user:token@git.example.com',
    ])
      assert.throws(() => providerOrigin('forgejo', value))
  } finally {
    if (previous === undefined) delete process.env.GIT_PROVIDER_ORIGINS
    else process.env.GIT_PROVIDER_ORIGINS = previous
  }
})
test('GitHub App JWT is signed and expires within GitHub’s ten-minute maximum', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwt = appJwt({
    app_id: '123',
    private_key: pair.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
  })
  const [header, payload, signature] = jwt.split('.')
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
  assert.equal(claims.iss, '123')
  assert.ok(claims.exp - claims.iat <= 600)
  assert.ok(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      pair.publicKey,
      Buffer.from(signature!, 'base64url'),
    ),
  )
})
test('suggestions infer framework from app evidence and preserve monorepo root context', () => {
  const files = {
    'package.json': '{"packageManager":"pnpm@12.16.1"}',
    'pnpm-lock.yaml': 'lockfileVersion: 9',
    'pnpm-workspace.yaml': 'packages: [apps/*]',
    'apps/web/package.json':
      '{"dependencies":{"next":"16"},"scripts":{"build":"next build","start":"next start"}}',
  }
  const suggestion = suggestDockerfile(files, 'apps/web', '.')
  assert.match(suggestion.dockerfile!, /pnpm --filter .\/apps\/web run build/)
  assert.match(suggestion.dockerfile!, /type=secret,id=npmrc/)
  assert.ok(suggestion.evidence.some((value) => value.includes('Next.js')))
  assert.equal(
    suggestDockerfile(files, 'apps/web', 'apps/web').dockerfile,
    null,
  )
  const noNext = suggestDockerfile(
    {
      ...files,
      'apps/web/package.json':
        '{"dependencies":{"hono":"1"},"scripts":{"build":"tsc","start":"node dist/index.js"}}',
    },
    'apps/web',
    '.',
  )
  assert.ok(
    !noNext.evidence.some((value) => value.includes('Next.js detected')),
  )
})
