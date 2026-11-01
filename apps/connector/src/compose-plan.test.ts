import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  affected,
  composeCandidateModel,
  protectedConfigHash,
} from './compose-plan.js'
const rule = {
  include: ['apps/web/**', 'packages/**'],
  exclude: ['**/*.md'],
  action: 'redeploy' as const,
}
test('watch paths select web/API/shared changes with exclude precedence, deletion/rename names and manual overrides', () => {
  assert.equal(affected(rule, ['apps/web/src/index.ts'], []), true)
  assert.equal(affected(rule, ['apps/api/src/index.ts'], []), false)
  assert.equal(affected(rule, ['packages/shared/index.ts'], []), true)
  assert.equal(affected(rule, ['apps/web/README.md'], []), false)
  assert.equal(affected(rule, ['unrelated.txt'], ['unrelated.txt']), true)
  assert.equal(affected(rule, ['old/name.ts', 'apps/web/deleted.ts'], []), true)
  assert.equal(affected(rule, [], []), false)
  assert.equal(affected(rule, null, []), true)
  assert.equal(affected(rule, ['unrelated.txt'], [], true), true)
  assert.equal(
    affected({ include: [], exclude: [], action: 'restart' }, ['anything'], []),
    true,
  )
})
test('candidate Compose model includes selected services only and never copies database dependencies', () => {
  const source = {
    services: {
      web: {
        image: 'web',
        depends_on: { db: { condition: 'service_started' } },
        networks: { default: null },
        labels: { 'kloud.project': 'demo' },
      },
      db: {
        image: 'postgres:17',
        volumes: [{ type: 'volume', source: 'db-data', target: '/data' }],
      },
    },
    networks: { default: { name: 'stable_default' } },
    volumes: { 'db-data': { name: 'stable_db-data' } },
  }
  const model = composeCandidateModel(source, { web: 'release-web' })
  assert.deepEqual(Object.keys(model.services), ['release-web'])
  assert.equal(model.services['release-web'].container_name, 'release-web')
  assert.deepEqual(model.services['release-web'].networks.default.aliases, [
    'release-web',
  ])
  assert.deepEqual(model.networks.default, {
    external: true,
    name: 'stable_default',
  })
  assert.equal(model.services['release-web'].depends_on, undefined)
  assert.equal(source.services.web.depends_on.db.condition, 'service_started')
})
test('candidate Compose rejects fixed ports, writable volumes and ambiguous candidate dependencies', () => {
  const base = {
    services: { web: { image: 'web', networks: { default: null } } },
    networks: { default: { name: 'stable_default' } },
  }
  assert.throws(
    () =>
      composeCandidateModel(
        {
          ...base,
          services: {
            web: {
              ...base.services.web,
              ports: [{ published: 80, target: 80 }],
            },
          },
        },
        { web: 'candidate' },
      ),
    /ports/,
  )
  assert.throws(
    () =>
      composeCandidateModel(
        {
          ...base,
          services: {
            web: {
              ...base.services.web,
              volumes: [{ type: 'volume', read_only: false }],
            },
          },
        },
        { web: 'candidate' },
      ),
    /writable/,
  )
  assert.throws(
    () =>
      composeCandidateModel(
        {
          ...base,
          services: {
            web: { ...base.services.web, depends_on: { api: {} } },
            api: base.services.web,
          },
        },
        { web: 'web-new', api: 'api-new' },
      ),
    /another candidate/,
  )
})
test('dependency comparison is stable, protected, and detects secret input changes', () => {
  assert.equal(
    protectedConfigHash({ b: 2, a: { TOKEN: 'secret' } }, 'key'),
    protectedConfigHash({ a: { TOKEN: 'secret' }, b: 2 }, 'key'),
  )
  assert.notEqual(
    protectedConfigHash({ TOKEN: 'secret' }, 'key'),
    protectedConfigHash({ TOKEN: 'changed' }, 'key'),
  )
  assert.notEqual(
    protectedConfigHash({ TOKEN: 'secret' }, 'key'),
    protectedConfigHash({ TOKEN: 'secret' }, 'other-key'),
  )
})
