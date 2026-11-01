import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { formatComposeEnvironment } from './compose-environment.js'

const docker = (process.env.PATH ?? '')
  .split(process.platform === 'win32' ? ';' : ':')
  .map((path) =>
    join(path, process.platform === 'win32' ? 'docker.exe' : 'docker'),
  )
  .find((path) => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
test('Compose dotenv writer keeps literal dollars and rejects invalid variable keys', () => {
  assert.match(
    formatComposeEnvironment({ VALUE: '${OTHER} $HOME $$' }),
    /\\\$\{OTHER\}/,
  )
  assert.throws(
    () => formatComposeEnvironment({ 'BAD-KEY': 'value' }),
    /Invalid Compose/,
  )
})
test(
  'actual Docker Compose config preserves runtime literals, multiline values, control names, and required variables without builds',
  { skip: !docker },
  async (t) => {
    const run = promisify(execFile)
    try {
      await run(docker!, ['compose', 'version'])
    } catch {
      t.skip('Docker Compose CLI is unavailable')
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'kloud-compose-env-'))
    const values = {
      VALUE: 'literal $HOME ${OTHER} $$ end',
      MULTI: 'one\ntwo\r\tthree',
      QUOTE: 'one\'two"three\\',
      EMPTY: '',
      REQUIRED: 'present',
      SLASHQUOTE: "a\\'b",
      HOME: 'literal-home-$HOME',
      PATH: 'literal-path',
      DOCKER_CONFIG: 'literal-docker-config',
      COMPOSE_FILE: 'literal-compose-file',
    }
    const inherited = { ...process.env }
    for (const key of Object.keys(values)) delete inherited[key]
    try {
      await writeFile(
        join(root, 'runtime.env'),
        formatComposeEnvironment(values),
        { mode: 0o600 },
      )
      const config = {
        services: {
          app: {
            image: 'alpine:latest',
            environment: Object.fromEntries(
              Object.keys(values).map((key) => [
                key,
                key === 'REQUIRED' ? '${REQUIRED:?required}' : `\${${key}}`,
              ]),
            ),
          },
        },
      }
      await writeFile(join(root, 'compose.json'), JSON.stringify(config))
      const { stdout } = await run(
        docker!,
        [
          'compose',
          '--env-file',
          join(root, 'runtime.env'),
          '--project-name',
          'kloud-env-fixture',
          '-f',
          join(root, 'compose.json'),
          'config',
          '--format',
          'json',
        ],
        { env: inherited, maxBuffer: 1024 * 1024 },
      )
      const model = JSON.parse(stdout)
      // Compose emits escaped dollars so this canonical model can be parsed once again by up.
      const actual = Object.fromEntries(
        Object.entries(model.services.app.environment).map(([key, value]) => [
          key,
          String(value).replaceAll('$$', () => '$'),
        ]),
      )
      assert.deepEqual(actual, values)
      assert.equal(model.services.app.build, undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
