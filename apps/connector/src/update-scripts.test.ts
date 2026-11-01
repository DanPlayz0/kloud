import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const dockerScript = new URL(
  '../../../scripts/update-connector-docker.sh',
  import.meta.url,
).pathname
const pm2Script = new URL(
  '../../../scripts/update-connector-pm2.sh',
  import.meta.url,
).pathname

test('Docker updater schedules independent internal Compose helper with operator-selected configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kloud-update-'))
  const log = join(directory, 'calls')
  try {
    await writeFile(
      join(directory, 'docker'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_LOG"\nif [ "$1" = inspect ]; then exit 1; fi\n',
      { mode: 0o755 },
    )
    execFileSync('/bin/sh', [dockerScript], {
      env: {
        ...process.env,
        PATH: directory + ':' + process.env.PATH,
        TEST_LOG: log,
        HOSTNAME: 'connector-id',
        KLOUD_UPDATE_DIRECTORY: '/opt/connector',
        KLOUD_UPDATE_PROJECT: 'existing-project',
        KLOUD_UPDATE_COMPOSE_FILES:
          'compose.connector.yaml:compose.connector.pm2.yaml:compose.connector.updates.yaml',
      },
    })
    const calls = await readFile(log, 'utf8')
    assert.match(
      calls,
      /run --detach --init --name kloud-update-existing-project --label kloud.internal=true/,
    )
    assert.match(
      calls,
      /type=bind,src=\/opt\/connector,dst=\/opt\/connector,readonly/,
    )
    assert.match(calls, /KLOUD_UPDATE_PROJECT=existing-project/)
    assert.match(calls, /compose.connector.pm2.yaml/)
    assert.match(calls, /--no-deps --wait --wait-timeout 120 connector/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('PM2 updater retries failed builds and restarts only after locked installation and compilation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kloud-update-'))
  const bin = join(directory, 'bin'),
    log = join(directory, 'calls')
  await mkdir(bin)
  await mkdir(join(directory, 'apps/connector'), { recursive: true })
  await writeFile(
    join(directory, 'apps/connector/package.json'),
    '{"version":"1.2.3"}',
  )
  const revision = 'a'.repeat(40)
  try {
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh\nprintf '%s\\n' "git $*" >> "$TEST_LOG"\ncase "$1" in symbolic-ref) echo main;; rev-parse) echo ${revision};; status) :;; esac\n`,
      { mode: 0o755 },
    )
    await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await writeFile(
      join(bin, 'pnpm'),
      '#!/bin/sh\nprintf "%s\\n" "pnpm $*" >> "$TEST_LOG"\nif [ "${TEST_BUILD_FAILURE:-}" = true ] && [ "$1" = --filter ]; then exit 1; fi\n',
      { mode: 0o755 },
    )
    await writeFile(
      join(bin, 'pm2'),
      '#!/bin/sh\nprintf "%s\\n" "pm2 $* revision=$CONNECTOR_REVISION version=$CONNECTOR_VERSION" >> "$TEST_LOG"\n',
      { mode: 0o755 },
    )
    const env = {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      TEST_LOG: log,
      KLOUD_UPDATE_DIRECTORY: directory,
      KLOUD_UPDATE_PM2_NAME: 'connector',
      CONNECTOR_REVISION: 'b'.repeat(40),
    }
    assert.throws(() =>
      execFileSync('/bin/sh', [pm2Script], {
        env: { ...env, TEST_BUILD_FAILURE: 'true' },
      }),
    )
    assert.ok(!(await readFile(log, 'utf8')).includes('pm2 restart'))
    await writeFile(log, '')
    execFileSync('/bin/sh', [pm2Script], { env })
    const calls = await readFile(log, 'utf8')
    assert.match(calls, /git merge --ff-only FETCH_HEAD/)
    assert.match(calls, /pnpm install --frozen-lockfile/)
    assert.match(calls, /pnpm --filter @kloud\/connector exec tsc/)
    assert.match(
      calls,
      new RegExp(
        `pm2 restart connector --update-env revision=${revision} version=1.2.3`,
      ),
    )
    await writeFile(log, '')
    execFileSync('/bin/sh', [pm2Script], {
      env: { ...env, CONNECTOR_REVISION: revision },
    })
    assert.ok(!(await readFile(log, 'utf8')).includes('pnpm install'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
