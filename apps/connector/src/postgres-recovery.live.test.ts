import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig } from './config.js'
import { executeDatabaseJob } from './postgres-recovery.js'

test(
  'live private PostgreSQL creation, custom backup, restore-to-new and malformed import leave source data intact',
  { skip: process.env.RUN_POSTGRES_DOCKER !== '1', timeout: 240000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kloud-postgres-recovery-test-'))
    const databaseRoot = join(root, 'backups')
    await mkdir(databaseRoot)
    const oldRoot = process.env.BACKUP_DISK_ROOT,
      oldStage = process.env.BACKUP_STAGING_ROOT
    process.env.BACKUP_DISK_ROOT = databaseRoot
    process.env.BACKUP_STAGING_ROOT = join(root, 'staging')
    const config = readConfig({ ...process.env, DEPLOYMENTS_DIR: root })
    const project = `recovery-${randomUUID().slice(0, 8)}`
    const resources = [randomUUID(), randomUUID(), randomUUID()]
    const credentials = () => ({
      username: 'kloud',
      database: 'app',
      password: randomBytes(32).toString('base64url'),
      adminPassword: randomBytes(32).toString('base64url'),
    })
    const source: any = {
      id: randomUUID(),
      resource: resources[0],
      project,
      slug: 'source',
      version: '17.6',
      kind: 'create',
      credentials: credentials(),
    }
    const signal = AbortSignal.timeout(220000),
      unused = async () => {
        throw new Error('Archive fetch was not expected')
      }
    const docker = (...args: string[]) =>
      execFileSync(
        'docker',
        ['--host', `unix://${config.dockerSocket}`, ...args],
        { encoding: 'utf8', timeout: 60000 },
      ).trim()
    try {
      const created = await executeDatabaseJob(source, config, signal, unused)
      assert.equal(created.state, 'succeeded')
      const inspect = JSON.parse(
        docker('inspect', `kloud-postgres-${source.resource}`),
      )[0]
      assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0)
      docker(
        'exec',
        `kloud-postgres-${source.resource}`,
        'psql',
        '-U',
        'kloud',
        '-d',
        'app',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        "CREATE TABLE recovery_fixture(id integer PRIMARY KEY, value text); INSERT INTO recovery_fixture VALUES(1,'known fixture');",
      )
      const policy = randomUUID(),
        destination = randomUUID()
      const backup = (await executeDatabaseJob(
        {
          ...source,
          id: randomUUID(),
          kind: 'backup',
          backup: {
            id: policy,
            destinations: [
              {
                destination,
                config: { kind: 'disk', root: databaseRoot },
                maxBytes: 100000000,
                minimumPoints: 1,
                reserveBytes: 1000000,
                points: [],
              },
            ],
          },
        },
        config,
        signal,
        unused,
      )) as any
      assert.equal(backup.state, 'succeeded', JSON.stringify(backup))
      assert.equal(backup.artifacts[0].state, 'complete')
      const archive = backup.artifacts[0].metadata
      assert.equal(
        (await readFile(archive.path)).subarray(0, 5).toString(),
        'PGDMP',
      )
      const limited = (await executeDatabaseJob(
        {
          ...source,
          id: randomUUID(),
          kind: 'backup',
          backup: {
            id: policy,
            destinations: [
              {
                destination,
                config: { kind: 'disk', root: databaseRoot },
                maxBytes: archive.size,
                minimumPoints: 1,
                reserveBytes: 0,
                points: [
                  {
                    id: randomUUID(),
                    metadata: archive,
                    created: new Date().toISOString(),
                  },
                ],
              },
            ],
          },
        },
        config,
        signal,
        unused,
      )) as any
      assert.equal(limited.state, 'failed')
      assert.match(limited.artifacts[0].metadata.error, /minimum retained/)
      assert.equal(
        (await readFile(archive.path)).subarray(0, 5).toString(),
        'PGDMP',
      )
      const partial = (await executeDatabaseJob(
        {
          ...source,
          id: randomUUID(),
          kind: 'backup',
          backup: {
            id: policy,
            destinations: [
              {
                destination,
                config: { kind: 'disk', root: databaseRoot },
                maxBytes: 100000000,
                minimumPoints: 1,
                reserveBytes: 0,
                points: [
                  {
                    id: randomUUID(),
                    metadata: archive,
                    created: new Date().toISOString(),
                  },
                ],
              },
              {
                destination: randomUUID(),
                config: {
                  kind: 's3',
                  endpoint: 'https://127.0.0.1:1',
                  region: 'us-east-1',
                  bucket: 'backups',
                  prefix: 'kloud',
                  accessKey: 'test',
                  secretKey: 'test',
                },
                maxBytes: 100000000,
                minimumPoints: 1,
                reserveBytes: 0,
                points: [],
              },
            ],
          },
        },
        config,
        signal,
        unused,
      )) as any
      assert.equal(partial.state, 'partial')
      assert.equal(partial.artifacts[0].state, 'complete')
      assert.equal(partial.artifacts[1].state, 'failed')
      const restored: any = {
        ...source,
        id: randomUUID(),
        resource: resources[1],
        slug: 'restored',
        kind: 'restore',
        credentials: credentials(),
        archive: {
          ...archive,
          destination: { kind: 'disk', root: databaseRoot },
        },
      }
      const result = (await executeDatabaseJob(
        restored,
        config,
        signal,
        unused,
      )) as any
      assert.equal(result.state, 'succeeded', JSON.stringify(result))
      assert.equal(
        docker(
          'exec',
          `kloud-postgres-${restored.resource}`,
          'psql',
          '-U',
          'kloud',
          '-d',
          'app',
          '-Atc',
          'SELECT value FROM recovery_fixture',
        ),
        'known fixture',
      )
      assert.equal(
        docker(
          'exec',
          `kloud-postgres-${source.resource}`,
          'psql',
          '-U',
          'kloud',
          '-d',
          'app',
          '-Atc',
          'SELECT value FROM recovery_fixture',
        ),
        'known fixture',
      )
      await assert.rejects(
        executeDatabaseJob(
          { ...restored, id: randomUUID() },
          config,
          signal,
          unused,
        ),
        /overwrite|already exists/,
      )
      const reconciled = (await executeDatabaseJob(
        {
          ...restored,
          id: randomUUID(),
          kind: 'reconcile',
          reconciliation: {
            unknown_job: randomUUID(),
            unknown_kind: 'restore',
          },
        },
        config,
        signal,
        unused,
      )) as any
      assert.equal(reconciled.state, 'succeeded')
      assert.equal(reconciled.result.quiescent, true)
      assert.equal(reconciled.result.running, false)
      const bytes = Buffer.from('PGDMPinvalid archive')
      const { createHash } = await import('node:crypto')
      await assert.rejects(
        executeDatabaseJob(
          {
            ...source,
            id: randomUUID(),
            resource: resources[2],
            kind: 'import',
            credentials: credentials(),
            upload: {
              checksum: createHash('sha256').update(bytes).digest('hex'),
            },
          },
          config,
          signal,
          async () => bytes,
        ),
        /failed/,
      )
      assert.equal(
        docker(
          'exec',
          `kloud-postgres-${source.resource}`,
          'psql',
          '-U',
          'kloud',
          '-d',
          'app',
          '-Atc',
          'SELECT count(*) FROM recovery_fixture',
        ),
        '1',
      )
    } finally {
      for (const id of resources) {
        try {
          docker('rm', '-f', `kloud-postgres-${id}`)
        } catch {}
        try {
          docker('volume', 'rm', `kloud-postgres-${id}`)
        } catch {}
      }
      try {
        docker('network', 'rm', `kloud-db-${project}`)
      } catch {}
      await rm(root, { recursive: true, force: true })
      if (oldRoot === undefined) delete process.env.BACKUP_DISK_ROOT
      else process.env.BACKUP_DISK_ROOT = oldRoot
      if (oldStage === undefined) delete process.env.BACKUP_STAGING_ROOT
      else process.env.BACKUP_STAGING_ROOT = oldStage
    }
  },
)
