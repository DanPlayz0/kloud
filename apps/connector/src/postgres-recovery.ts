import { spawn } from 'node:child_process'
import { createWriteStream, createReadStream } from 'node:fs'
import {
  mkdir,
  writeFile,
  realpath,
  stat,
  statfs,
  rename,
  rm,
  copyFile,
  open,
  rmdir,
} from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ConnectorConfig } from './config.js'
import { commandEnvironment, dockerHost, engine } from './deployment-process.js'
import {
  fileChecksum,
  retentionPlan,
  s3Transfer,
  type S3Destination,
  type RetainedPoint,
} from './postgres-storage.js'

type Credentials = {
  username: string
  password: string
  adminPassword: string
  database: string
}
type Job = {
  id: string
  resource: string
  project: string
  slug: string
  version: string
  kind: string
  credentials: Credentials
  backup: any
  archive: any
  upload: any
  reconciliation?: { unknown_job: string; unknown_kind: string }
  destination?: any
}
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function identifiers(job: Job) {
  if (
    !uuidPattern.test(job.id) ||
    !uuidPattern.test(job.resource) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(job.project) ||
    job.version !== '17.6'
  )
    throw new Error('Invalid database job identity')
  return {
    container: `kloud-postgres-${job.resource}`,
    volume: `kloud-postgres-${job.resource}`,
    network: `kloud-db-${job.project}`,
  }
}
function docker(
  config: ConnectorConfig,
  args: string[],
  signal: AbortSignal,
  options: { password?: string; output?: string; input?: string } = {},
) {
  return new Promise<string>((resolveCommand, reject) => {
    const child = spawn(
      'docker',
      ['--host', dockerHost(config.dockerSocket), ...args],
      {
        signal,
        killSignal: 'SIGKILL',
        env: {
          ...commandEnvironment('docker'),
          ...(options.password ? { PGPASSWORD: options.password } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let output = '',
      error = '',
      failed = false
    const fail = (e: unknown) => {
      if (!failed) {
        failed = true
        reject(e)
        child.kill('SIGKILL')
      }
    }
    const file = options.output
      ? createWriteStream(options.output, { flags: 'wx', mode: 0o600 })
      : null
    file?.on('error', fail)
    if (file) child.stdout.pipe(file)
    else
      child.stdout.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-1024 * 1024)
      })
    child.stderr.on('data', (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-2000)
      if (args[0] === 'logs') output = (output + chunk.toString()).slice(-15000)
    })
    if (options.input) {
      const input = createReadStream(options.input)
      input.on('error', fail)
      input.pipe(child.stdin)
    } else child.stdin.end()
    child.on('error', fail)
    child.on('close', (code) => {
      if (code !== 0) {
        file?.destroy()
        fail(
          new Error(
            `PostgreSQL/Docker command failed (${code}). ${args.includes('pg_restore') || args.includes('psql') ? 'Inspect PostgreSQL version, extension support, permissions and target state.' : error.replaceAll(options.password ?? '\u0000', '[redacted]')}`,
          ),
        )
        return
      }
      if (file) {
        if (file.writableFinished) resolveCommand('')
        else file.once('finish', () => resolveCommand(''))
      } else resolveCommand(output)
    })
  })
}
async function ownedContainer(job: Job, config: ConnectorConfig) {
  const { container } = identifiers(job)
  const data = await engine(
    config.dockerSocket,
    'GET',
    `/containers/${container}/json`,
  )
  if (
    data.Config.Labels?.['kloud.database'] !== job.resource ||
    data.Config.Labels?.['kloud.project'] !== job.project
  )
    throw new Error('Database container ownership does not match this resource')
  return data
}
async function provision(
  job: Job,
  config: ConnectorConfig,
  signal: AbortSignal,
) {
  const { container, volume, network } = identifiers(job)
  try {
    await engine(config.dockerSocket, 'GET', `/containers/${container}/json`)
    throw new Error(
      'Restore/create refuses to adopt or overwrite an existing container',
    )
  } catch (e) {
    if (
      !(e instanceof Error) ||
      !e.message.startsWith('Docker GET failed (404):')
    )
      throw e
  }
  // Named data volumes are never reused by a new operation or deleted on failure.
  try {
    await engine(config.dockerSocket, 'GET', `/volumes/${volume}`)
    throw new Error('Target data volume already exists; choose a new resource')
  } catch (e) {
    if (
      !(e instanceof Error) ||
      !e.message.startsWith('Docker GET failed (404):')
    )
      throw e
  }
  try {
    await engine(config.dockerSocket, 'GET', `/networks/${network}`)
  } catch (e) {
    if (
      !(e instanceof Error) ||
      !e.message.startsWith('Docker GET failed (404):')
    )
      throw e
    await engine(config.dockerSocket, 'POST', '/networks/create', {
      Name: network,
      Internal: false,
      Labels: {
        'kloud.project': job.project,
        'kloud.database-network': 'true',
      },
    })
  }
  const image = 'postgres:17.6-alpine'
  await docker(config, ['pull', image], signal)
  await engine(config.dockerSocket, 'POST', '/volumes/create', {
    Name: volume,
    Labels: { 'kloud.database': job.resource, 'kloud.project': job.project },
  })
  const result = await engine(
    config.dockerSocket,
    'POST',
    `/containers/create?name=${container}`,
    {
      Image: image,
      Env: [
        `POSTGRES_PASSWORD=${job.credentials.adminPassword}`,
        'POSTGRES_USER=postgres',
        'POSTGRES_DB=postgres',
      ],
      Labels: {
        'kloud.project': job.project,
        'kloud.application': `database-${job.slug}`,
        'kloud.database': job.resource,
      },
      Healthcheck: {
        Test: ['CMD-SHELL', 'pg_isready -U postgres -d postgres'],
        Interval: 5e9,
        Timeout: 5e9,
        Retries: 12,
      },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        Mounts: [
          {
            Type: 'volume',
            Source: volume,
            Target: '/var/lib/postgresql/data',
          },
        ],
        LogConfig: {
          Type: 'json-file',
          Config: { 'max-size': '10m', 'max-file': '3' },
        },
      },
      NetworkingConfig: {
        EndpointsConfig: { [network]: { Aliases: [container] } },
      },
    },
  )
  await engine(config.dockerSocket, 'POST', `/containers/${result.Id}/start`)
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const data = await ownedContainer(job, config)
    if (data.State.Health?.Status === 'healthy') break
    if (!data.State.Running) throw new Error('PostgreSQL did not start')
    await delay(1000, undefined, { signal })
  }
  const healthy = await ownedContainer(job, config)
  if (healthy.State.Health?.Status !== 'healthy')
    throw new Error('PostgreSQL readiness timed out')
  if (!/^[A-Za-z0-9_-]{43}$/.test(job.credentials.password))
    throw new Error('Invalid generated database password')
  await docker(
    config,
    [
      'exec',
      '-e',
      'PGPASSWORD',
      container,
      'psql',
      '--username=postgres',
      '--dbname=postgres',
      '--set=ON_ERROR_STOP=1',
      '--command',
      `CREATE ROLE kloud LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${job.credentials.password}';`,
    ],
    signal,
    { password: job.credentials.adminPassword },
  )
  await docker(
    config,
    [
      'exec',
      '-e',
      'PGPASSWORD',
      container,
      'createdb',
      '--username=postgres',
      '--owner=kloud',
      '--template=template0',
      'app',
    ],
    signal,
    { password: job.credentials.adminPassword },
  )
}
async function stopFailedTarget(job: Job, config: ConnectorConfig) {
  try {
    const data = await ownedContainer(job, config)
    if (data.State.Running)
      await engine(
        config.dockerSocket,
        'POST',
        `/containers/${data.Id}/stop?t=10`,
      )
  } catch {}
}
export function archiveVersions(list: string) {
  const source = /Dumped from database version:\s*([\d.]+)/.exec(list)?.[1],
    client = /Dumped by pg_dump version:\s*([\d.]+)/.exec(list)?.[1]
  if (!source || !client)
    throw new Error(
      'Archive does not expose its source and dump-client versions',
    )
  if (Number(source.split('.')[0]) > 17 || Number(client.split('.')[0]) > 17)
    throw new Error(
      'This archive requires a newer PostgreSQL target/client; target version is 17.6',
    )
  const extensions = [
    ...list.matchAll(/\bEXTENSION\s+-\s+([A-Za-z_][A-Za-z0-9_-]*)/g),
  ].map((m) => m[1]!)
  return {
    sourceVersion: source,
    dumpClientVersion: client,
    extensions: [...new Set(extensions)],
  }
}
async function restoreArchive(
  job: Job,
  config: ConnectorConfig,
  path: string,
  signal: AbortSignal,
) {
  const handle = await open(path, 'r')
  const signature = Buffer.alloc(5)
  try {
    await handle.read(signature, 0, 5, 0)
  } finally {
    await handle.close()
  }
  const header = signature.toString()
  if (header !== 'PGDMP')
    throw new Error('Only PostgreSQL custom-format archives are supported')
  await provision(job, config, signal)
  const { container } = identifiers(job),
    remote = `/tmp/kloud-import-${job.id}.dump`
  try {
    await docker(config, ['cp', path, `${container}:${remote}`], signal)
    const list = await docker(
      config,
      ['exec', container, 'pg_restore', '--list', remote],
      signal,
    )
    const metadata = archiveVersions(list)
    const available = (
      await docker(
        config,
        [
          'exec',
          '-e',
          'PGPASSWORD',
          container,
          'psql',
          '--username=postgres',
          '--dbname=app',
          '--tuples-only',
          '--no-align',
          '--command',
          'SELECT name FROM pg_available_extensions',
        ],
        signal,
        { password: job.credentials.adminPassword },
      )
    )
      .trim()
      .split('\n')
    const missing = metadata.extensions.filter((e) => !available.includes(e))
    if (missing.length)
      throw new Error(`Target lacks required extensions: ${missing.join(', ')}`)
    // Extension installation is explicit and identifier-validated, before restricted-role restore.
    for (const extension of metadata.extensions)
      await docker(
        config,
        [
          'exec',
          '-e',
          'PGPASSWORD',
          container,
          'psql',
          '--username=postgres',
          '--dbname=app',
          '--set=ON_ERROR_STOP=1',
          '--command',
          `CREATE EXTENSION IF NOT EXISTS "${extension}";`,
        ],
        signal,
        { password: job.credentials.adminPassword },
      )
    await docker(
      config,
      [
        'exec',
        '-e',
        'PGPASSWORD',
        container,
        'pg_restore',
        '--username=kloud',
        '--dbname=app',
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '--single-transaction',
        remote,
      ],
      signal,
      { password: job.credentials.password },
    )
    const tables = await docker(
      config,
      [
        'exec',
        '-e',
        'PGPASSWORD',
        container,
        'psql',
        '--username=kloud',
        '--dbname=app',
        '--tuples-only',
        '--no-align',
        '--command',
        "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
      ],
      signal,
      { password: job.credentials.password },
    )
    return {
      ...metadata,
      tables: Number(tables.trim()),
      ownership: 'remapped to kloud; ACLs omitted',
    }
  } catch (e) {
    await stopFailedTarget(job, config)
    throw e
  } finally {
    await docker(
      config,
      ['exec', container, 'rm', '-f', remote],
      AbortSignal.timeout(10000),
    ).catch(() => {})
  }
}
async function diskDirectory(root: string, policy: string) {
  if (!uuidPattern.test(policy))
    throw new Error('Invalid backup policy identity')
  const allowed = process.env.BACKUP_DISK_ROOT
  if (!allowed)
    throw new Error(
      'Set administrator-controlled BACKUP_DISK_ROOT before using disk backups',
    )
  const base = await realpath(allowed),
    target = await realpath(root)
  const rel = relative(base, target)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    throw new Error('Backup destination escapes BACKUP_DISK_ROOT')
  const directory = join(target, 'kloud', policy)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const actual = await realpath(directory),
    containment = relative(target, actual)
  if (
    containment === '..' ||
    containment.startsWith('../') ||
    isAbsolute(containment)
  )
    throw new Error('Backup directory symlink escapes destination')
  return actual
}
async function backup(
  job: Job,
  config: ConnectorConfig,
  path: string,
  signal: AbortSignal,
) {
  const { container } = identifiers(job)
  await ownedContainer(job, config)
  const estimated = Number(
    (
      await docker(
        config,
        [
          'exec',
          '-e',
          'PGPASSWORD',
          container,
          'psql',
          '--username=kloud',
          '--dbname=app',
          '--tuples-only',
          '--no-align',
          '--command',
          'SELECT pg_database_size(current_database())',
        ],
        signal,
        { password: job.credentials.password },
      )
    ).trim(),
  )
  const stage = await statfs(resolve(path, '..'))
  if (stage.bavail * stage.bsize < estimated + 64 * 1024 * 1024)
    throw new Error('Insufficient temporary staging space for database backup')
  await docker(
    config,
    [
      'exec',
      '-e',
      'PGPASSWORD',
      container,
      'pg_dump',
      '--username=kloud',
      '--dbname=app',
      '--format=custom',
      '--no-owner',
      '--no-acl',
    ],
    signal,
    { password: job.credentials.password, output: path },
  )
  const size = (await stat(path)).size,
    checksum = await fileChecksum(path)
  // Check archive readability with the same versioned client before completing any artifact.
  await docker(
    config,
    ['exec', '-i', container, 'pg_restore', '--list'],
    signal,
    { input: path },
  )
  const sourceVersion = (
    await docker(
      config,
      [
        'exec',
        '-e',
        'PGPASSWORD',
        container,
        'psql',
        '--username=kloud',
        '--dbname=app',
        '--tuples-only',
        '--no-align',
        '--command',
        'SHOW server_version',
      ],
      signal,
      { password: job.credentials.password },
    )
  ).trim()
  const artifacts: any[] = [],
    pruned: string[] = []
  for (const destination of job.backup.destinations) {
    const metadata: any = {
      kind: destination.config.kind,
      size,
      checksum,
      sourceVersion,
      dumpClientVersion: '17.6',
      format: 'custom',
      policy: job.backup.id,
      job: job.id,
    }
    try {
      const points = destination.points as RetainedPoint[]
      // Never prune protected restore points to force a new backup under its cap.
      const plan = retentionPlan(
        points,
        size,
        destination.maxBytes,
        destination.minimumPoints,
      )
      if (destination.config.kind === 'disk') {
        const directory = await diskDirectory(
            destination.config.root,
            job.backup.id,
          ),
          free = await statfs(directory)
        if (free.bavail * free.bsize < size + destination.reserveBytes)
          throw new Error(
            'Insufficient destination space including free-space reserve; no protected points were removed',
          )
        const temporary = join(directory, `${job.id}.partial`),
          complete = join(directory, `${job.id}.dump`)
        await new Promise<void>((ok, fail) => {
          const input = createReadStream(path),
            output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
          input.on('error', fail)
          output.on('error', fail)
          output.on('finish', ok)
          input.pipe(output)
        })
        if ((await fileChecksum(temporary)) !== checksum) {
          await rm(temporary, { force: true })
          throw new Error('Backup checksum verification failed')
        }
        metadata.path = complete
        await rename(temporary, complete)
        for (const point of plan) {
          const p = point.metadata.path
          if (
            !p ||
            resolve(p) !==
              join(directory, `${point.metadata.job ?? point.id}.dump`)
          )
            continue
          await rm(p)
          pruned.push(point.id)
        }
      } else {
        const s3 = destination.config as S3Destination,
          key =
            `${s3.prefix.replace(/\/$/, '')}/${job.backup.id}/${job.id}.dump`.replace(
              /^\//,
              '',
            )
        metadata.key = key
        await s3Transfer(s3, 'PUT', key, path, signal, checksum)
        // S3's successful durable PUT and content length are separately verified before manifest completion.
        const remote = await s3Transfer(s3, 'HEAD', key, undefined, signal)
        if (
          Number(remote['content-length']) !== size ||
          remote['x-amz-meta-sha256'] !== checksum
        )
          throw new Error('Uploaded S3 archive metadata verification failed')
        for (const point of plan) {
          const key = point.metadata.key
          if (
            !key ||
            !key.startsWith(
              `${s3.prefix.replace(/\/$/, '')}/${job.backup.id}/`.replace(
                /^\//,
                '',
              ),
            )
          )
            continue
          await s3Transfer(s3, 'DELETE', key, undefined, signal)
          pruned.push(point.id)
        }
      }
      artifacts.push({
        destination: destination.destination,
        state: 'complete',
        metadata,
      })
    } catch (e) {
      if (destination.config.kind === 'disk') {
        try {
          const directory = await diskDirectory(
            destination.config.root,
            job.backup.id,
          )
          await rm(join(directory, `${job.id}.partial`), { force: true })
        } catch {}
      }
      artifacts.push({
        destination: destination.destination,
        state: 'failed',
        metadata: {
          ...metadata,
          error: e instanceof Error ? e.message : 'Destination failed',
        },
      })
    }
  }
  const completed = artifacts.filter((a) => a.state === 'complete').length
  return {
    state:
      completed === artifacts.length
        ? 'succeeded'
        : completed
          ? 'partial'
          : 'failed',
    result: { size, checksum, sourceVersion, dumpClientVersion: '17.6' },
    artifacts,
    pruned,
  }
}
export async function executeDatabaseJob(
  job: Job,
  config: ConnectorConfig,
  signal: AbortSignal,
  fetchArchive: () => Promise<Uint8Array>,
) {
  const { container } = identifiers(job)
  const stage = resolve(
    process.env.BACKUP_STAGING_ROOT ??
      join(config.deploymentsDir, 'database-staging'),
    job.id,
  )
  await mkdir(stage, { recursive: true, mode: 0o700 })
  const archive = join(stage, 'archive.dump')
  try {
    if (job.kind === 'reconcile') {
      if (
        !job.reconciliation ||
        !uuidPattern.test(job.reconciliation.unknown_job)
      )
        throw new Error('Invalid reconciliation target')
      let actual: any
      try {
        actual = await ownedContainer(job, config)
      } catch (e) {
        if (
          e instanceof Error &&
          e.message.startsWith('Docker GET failed (404):')
        )
          return {
            state: 'succeeded',
            result: {
              quiescent: true,
              container_exists: false,
              running: false,
            },
          }
        throw e
      }
      if (actual.State.Running) {
        if (actual.State.Health?.Status !== 'healthy')
          throw new Error(
            'Database startup or health is unresolved; inspect the host before releasing the pause',
          )
        const active = Number(
          (
            await docker(
              config,
              [
                'exec',
                '-e',
                'PGPASSWORD',
                container,
                'psql',
                '--username=postgres',
                '--dbname=postgres',
                '--tuples-only',
                '--no-align',
                '--command',
                "SELECT count(*) FROM pg_stat_activity WHERE application_name IN ('pg_restore','pg_dump','createdb')",
              ],
              signal,
              { password: job.credentials.adminPassword },
            )
          ).trim(),
        )
        if (active)
          throw new Error(
            'PostgreSQL recovery commands remain active; the pause is retained',
          )
        if (
          ['create', 'restore', 'import'].includes(
            job.reconciliation.unknown_kind,
          )
        )
          await engine(
            config.dockerSocket,
            'POST',
            `/containers/${container}/stop?t=10`,
          )
      }
      const final = await ownedContainer(job, config)
      return {
        state: 'succeeded',
        result: {
          quiescent: true,
          container_exists: true,
          running: !!final.State.Running,
          previous_operation:
            'failed after explicit inspection; never automatically repeated',
        },
      }
    }
    if (job.kind === 'test-destination') {
      if (!job.destination) throw new Error('Destination unavailable')
      const contents = Buffer.from(`kloud-backup-test-${job.id}`)
      await writeFile(archive, contents, { flag: 'wx', mode: 0o600 })
      const checksum = await fileChecksum(archive)
      if (job.destination.kind === 'disk') {
        const directory = await diskDirectory(job.destination.root, job.id),
          test = join(directory, 'connection-test')
        try {
          await writeFile(test, contents, { flag: 'wx', mode: 0o600 })
          if ((await fileChecksum(test)) !== checksum)
            throw new Error('Disk destination readback failed')
        } finally {
          await rm(test, { force: true })
          await rmdir(directory).catch(() => {})
        }
      } else {
        const s3 = job.destination as S3Destination,
          key = `${s3.prefix.replace(/\/$/, '')}/tests/${job.id}`.replace(
            /^\//,
            '',
          )
        try {
          await s3Transfer(s3, 'PUT', key, archive, signal, checksum)
          const download = join(stage, 'test-readback')
          await s3Transfer(s3, 'GET', key, download, signal)
          if ((await fileChecksum(download)) !== checksum)
            throw new Error('S3 destination readback failed')
        } finally {
          await s3Transfer(s3, 'DELETE', key, undefined, signal).catch(() => {})
        }
      }
      return {
        state: 'succeeded',
        result: { destination: 'write/read/delete verified' },
      }
    }
    if (job.kind === 'create') {
      await provision(job, config, signal)
      return { state: 'succeeded', result: { container, private: true } }
    }
    if (job.kind === 'backup') return await backup(job, config, archive, signal)
    if (job.kind === 'import' || job.kind === 'restore') {
      if (job.kind === 'import') {
        const bytes = await fetchArchive()
        await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 })
        if ((await fileChecksum(archive)) !== job.upload.checksum)
          throw new Error('Uploaded archive checksum mismatch')
      } else if (job.archive.kind === 'disk') {
        const directory = await diskDirectory(
          job.archive.destination.root,
          job.archive.policy,
        )
        if (
          !uuidPattern.test(job.archive.job) ||
          resolve(job.archive.path) !==
            join(directory, `${job.archive.job}.dump`)
        )
          throw new Error('Backup path is not owned by this policy')
        const available = await statfs(stage)
        if (
          available.bavail * available.bsize <
          job.archive.size + 64 * 1024 * 1024
        )
          throw new Error('Insufficient restore staging space')
        await copyFile(job.archive.path, archive, 1)
      } else {
        const prefix =
          `${job.archive.destination.prefix.replace(/\/$/, '')}/${job.archive.policy}/`.replace(
            /^\//,
            '',
          )
        if (!job.archive.key?.startsWith(prefix))
          throw new Error('Backup key is not owned by this policy')
        await s3Transfer(
          job.archive.destination,
          'GET',
          job.archive.key,
          archive,
          signal,
        )
      }
      if (job.archive && (await fileChecksum(archive)) !== job.archive.checksum)
        throw new Error('Restore source checksum mismatch')
      return {
        state: 'succeeded',
        result: await restoreArchive(job, config, archive, signal),
      }
    }
    await ownedContainer(job, config)
    if (job.kind === 'logs')
      return {
        state: 'succeeded',
        result: {},
        log: (
          await docker(config, ['logs', '--tail', '100', container], signal)
        ).slice(-15000),
      }
    const action =
      job.kind === 'restart'
        ? 'restart'
        : job.kind === 'start'
          ? 'start'
          : 'stop'
    await engine(
      config.dockerSocket,
      'POST',
      `/containers/${container}/${action}${action === 'start' ? '' : '?t=10'}`,
    )
    return { state: 'succeeded', result: { container } }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
export async function databaseWorker(
  config: ConnectorConfig,
  signal: AbortSignal,
) {
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(
      new URL(`connectors/recovery/${path}`, config.apiUrl),
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      },
    )
    if (!response.ok)
      throw new Error(`Recovery API returned ${response.status}`)
    return response
  }
  while (!signal.aborted) {
    try {
      const { job } = (await (await request('claim', {})).json()) as {
        job: Job | null
      }
      if (job) {
        let result: any
        try {
          result = await executeDatabaseJob(
            job,
            config,
            AbortSignal.any([signal, AbortSignal.timeout(60 * 60 * 1000)]),
            async () =>
              new Uint8Array(
                await (await request(`${job.id}/archive`)).arrayBuffer(),
              ),
          )
        } catch (e) {
          const error =
            e instanceof Error ? e.message : 'Database operation failed'
          const uncertain =
            signal.aborted ||
            /timed out|aborted|signal|Docker.*failed \((?:5\d\d|undefined)/i.test(
              error,
            )
          result = {
            state: uncertain ? 'unknown' : 'failed',
            result: {},
            log: error,
          }
          if (['create', 'restore', 'import'].includes(job.kind) && !uncertain)
            await stopFailedTarget(job, config)
        }
        for (const value of Object.values(job.credentials))
          if (typeof value === 'string' && value.length > 4) {
            result.log = (result.log ?? '').split(value).join('[redacted]')
          }
        // Retrying only the idempotent result acknowledgement, never the database operation.
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await request(`${job.id}/result`, {
              log: '',
              artifacts: [],
              pruned: [],
              ...result,
            })
            break
          } catch (e) {
            if (attempt === 4) throw e
            await delay(2000, undefined, { signal })
          }
        }
      }
    } catch (e) {
      if (!signal.aborted)
        console.error(
          'Database worker unavailable:',
          e instanceof Error ? e.message : 'Unavailable',
        )
    }
    await delay(5000, undefined, { signal }).catch(() => {})
  }
}
