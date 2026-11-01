/** Executed only by the disposable build-helper image, never by the connector. */
import { secretOutput } from './secret-output.js'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { buildInputsSchema } from '@kloud/protocol/platform'
import { deploymentJobSchema, type DeploymentJob } from '@kloud/protocol'
import { repositoryPath, runCommand } from './deployment-process.js'

export function imageTag(job: DeploymentJob, index?: number) {
  return `kloud/${job.deployment_id}:${job.commit}${index === undefined ? '' : `-${index}`}`
}

export function runtimeCompose(
  model: any,
  job: DeploymentJob,
  tags: Record<string, string>,
) {
  const result = structuredClone(model)
  for (const [name, service] of Object.entries(result.services ?? {}) as [
    string,
    any,
  ][]) {
    // All host-side operations consume an image-only runtime manifest.
    delete service.build
    delete service.develop
    if (tags[name]) {
      service.image = tags[name]
      service.pull_policy = 'never'
    }
    service.labels = {
      ...service.labels,
      'kloud.project': job.project,
      'kloud.application': job.application,
    }
  }
  return result
}

export function changedPaths(diff: string): string[] | null {
  // runCommand returns a bounded suffix. A potentially truncated diff cannot exclude work.
  if (Buffer.byteLength(diff) >= 2 * 1024 * 1024 - 4 || diff.includes('\uFFFD'))
    return null
  const tokens = diff.split('\0')
  if (tokens.pop() !== '') return null
  const paths = new Set<string>()
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++]!
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) return null
    const path = tokens[i++]
    if (!path) return null
    paths.add(path)
    if (/^[RC]/.test(status)) {
      const renamed = tokens[i++]
      if (!renamed) return null
      paths.add(renamed)
    }
  }
  return [...paths]
}

export async function buildHelper() {
  const job = deploymentJobSchema.parse(
    JSON.parse(process.env.DEPLOYMENT_JOB ?? ''),
  )
  const sourceAuth = process.env.DEPLOYMENT_SOURCE_AUTH
    ? (JSON.parse(process.env.DEPLOYMENT_SOURCE_AUTH) as {
        token: string
        url: string
        username?: string
      })
    : undefined
  const token = sourceAuth?.token ?? process.env.DEPLOYMENT_GITHUB_TOKEN
  const buildInputs = process.env.DEPLOYMENT_BUILD_INPUTS
    ? buildInputsSchema.parse(JSON.parse(process.env.DEPLOYMENT_BUILD_INPUTS))
    : undefined
  const phase = process.env.DEPLOYMENT_PHASE ?? 'build'
  if (phase === 'checkout' && buildInputs)
    throw new Error('Build credentials must not be supplied to source checkout')
  if (phase !== 'checkout' && token)
    throw new Error(
      'Source credentials must not be supplied to the build phase',
    )
  const project = process.env.COMPOSE_PROJECT_NAME!
  // Child processes receive only the helper's tools and per-build settings.
  // In particular: no connector API token, host Docker configuration or Git token.
  const path = process.env.PATH
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, {
    PATH: path,
    HOME: '/tmp',
    DOCKER_CONFIG: '/tmp/docker',
    GIT_TERMINAL_PROMPT: '0',
    COMPOSE_PROJECT_NAME: project,
  })
  const signal = AbortSignal.timeout(29 * 60 * 1000)
  const root = '/workspace/repository',
    output = '/workspace/output'
  await mkdir(root, { recursive: true })
  await mkdir(output, { recursive: true })
  const username = sourceAuth?.username ?? 'x-access-token'
  const sensitive = [
    ...(token
      ? [token, Buffer.from(`${username}:${token}`).toString('base64')]
      : []),
    ...Object.values(buildInputs?.secrets ?? {}),
    ...(buildInputs?.registries ?? []).flatMap((registry) => [
      registry.password,
      Buffer.from(`${registry.username}:${registry.password}`).toString(
        'base64',
      ),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const outputLog = secretOutput(sensitive, (text) =>
    process.stdout.write(text),
  )
  const log = (text: string) => outputLog.write(text)
  const run = (args: string[], cwd = root, quiet = false) =>
    runCommand('docker', args, cwd, signal, quiet ? () => {} : log)
  if (phase === 'checkout') {
    console.log(`Checking out ${job.config.repository} at ${job.commit}.`)
    const sourceUrl =
      sourceAuth?.url ?? `https://github.com/${job.config.repository}.git`
    const parsedUrl = new URL(sourceUrl)
    if (
      parsedUrl.protocol !== 'https:' ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.search ||
      parsedUrl.hash ||
      parsedUrl.pathname !== `/${job.config.repository}.git`
    )
      throw new Error('Invalid canonical source URL')
    // Environment-only Git settings never persist the credential in a checkout.
    process.env.GIT_CONFIG_COUNT = token ? '3' : '2'
    process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
    process.env.GIT_CONFIG_VALUE_0 = '/dev/null'
    process.env.GIT_CONFIG_KEY_1 = 'http.followRedirects'
    process.env.GIT_CONFIG_VALUE_1 = 'false'
    if (token) {
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = '/dev/null'
      process.env.GIT_CONFIG_KEY_2 = `http.${sourceUrl}.extraheader`
      process.env.GIT_CONFIG_VALUE_2 = `AUTHORIZATION: basic ${Buffer.from(`${username}:${token}`).toString('base64')}`
    }
    await runCommand('git', ['init', '--quiet'], root, signal, log)
    await runCommand(
      'git',
      [
        'fetch',
        job.watch_baselines ? '--depth=1000' : '--depth=1',
        '--no-tags',
        sourceUrl,
        job.commit,
      ],
      root,
      signal,
      log,
    )
    await runCommand(
      'git',
      ['-c', 'advice.detachedHead=false', 'checkout', '--detach', 'FETCH_HEAD'],
      root,
      signal,
      log,
    )
    const changes: Record<string, string[] | null> = {}
    for (const [service, baseline] of Object.entries(
      job.watch_baselines ?? {},
    )) {
      changes[service] = null
      try {
        await runCommand(
          'git',
          ['fetch', '--depth=1000', '--no-tags', sourceUrl, baseline],
          root,
          signal,
          () => {},
        )
        await runCommand(
          'git',
          ['merge-base', '--is-ancestor', baseline, job.commit],
          root,
          signal,
          () => {},
        )
        const diff = await runCommand(
          'git',
          [
            'diff',
            '--name-status',
            '-z',
            '-M',
            '--no-ext-diff',
            '--no-textconv',
            baseline,
            job.commit,
            '--',
          ],
          root,
          signal,
          () => {},
        )
        changes[service] = changedPaths(diff)
      } catch {
        signal.throwIfAborted()
        // Missing/rewritten history is conservatively treated as all paths changed.
      }
    }
    await writeFile(join(output, 'changes.json'), JSON.stringify(changes))
    outputLog.flush()
    console.log('Source checkout completed.')
    return
  }
  const appRoot = await repositoryPath(root, job.config.app_root ?? '.')
  if (!(await stat(appRoot)).isDirectory())
    throw new Error(
      'Application root must be a directory inside the repository',
    )
  let file: string
  try {
    file = await repositoryPath(root, job.config.build_file)
  } catch {
    throw new Error(
      `Commit ${job.commit} is missing the configured build file ${job.config.build_file}, or it escapes the repository. Commit the Dockerfile/Compose definition before deploying.`,
    )
  }
  const context = await repositoryPath(root, job.config.context)
  if (!(await stat(file)).isFile() || !(await stat(context)).isDirectory())
    throw new Error('Invalid build file or context')
  await run(
    [
      'buildx',
      'create',
      '--name',
      'isolated',
      '--driver',
      'remote',
      'tcp://buildkit:1234',
    ],
    root,
    true,
  )
  let ready = false
  for (let i = 0; i < 30; i++) {
    try {
      await run(['buildx', 'inspect', 'isolated', '--bootstrap'], root, true)
      ready = true
      break
    } catch {
      await delay(1000, undefined, { signal })
    }
  }
  if (!ready)
    throw new Error(
      'Rootless BuildKit could not start; this host must support unprivileged user namespaces',
    )
  if (buildInputs?.registries.length) {
    await mkdir('/tmp/docker', { mode: 0o700, recursive: true })
    await writeFile(
      '/tmp/docker/config.json',
      JSON.stringify({
        auths: Object.fromEntries(
          buildInputs.registries.map((registry) => [
            registry.server,
            {
              auth: Buffer.from(
                `${registry.username}:${registry.password}`,
              ).toString('base64'),
            },
          ]),
        ),
      }),
      { mode: 0o600 },
    )
  }
  const secretFlags: string[] = []
  await mkdir('/tmp/build-secrets', { mode: 0o700, recursive: true })
  for (const [key, value] of Object.entries(buildInputs?.secrets ?? {})) {
    const path = `/tmp/build-secrets/${key}`
    await writeFile(path, value, { mode: 0o600 })
    secretFlags.push('--secret', `id=${key},src=${path}`)
  }
  const images: { tag: string; file: string }[] = []
  if (job.config.kind === 'dockerfile') {
    const tag = imageTag(job),
      artifact = 'image-0.tar'
    console.log('Building Dockerfile inside rootless BuildKit.')
    await run([
      'buildx',
      'build',
      '--builder',
      'isolated',
      '--progress',
      'plain',
      '--file',
      file,
      ...Object.entries(job.config.build_arguments ?? {}).flatMap(
        ([key, value]) => ['--build-arg', `${key}=${value}`],
      ),
      ...secretFlags,
      '--tag',
      tag,
      '--output',
      `type=docker,dest=${join(output, artifact)}`,
      context,
    ])
    images.push({ tag, file: artifact })
  } else {
    if (Object.keys(job.config.build_arguments ?? {}).length)
      throw new Error(
        'For Compose sources, declare nonsecret build arguments in the committed Compose definition.',
      )
    const args = [
      'compose',
      '--project-name',
      project,
      '--project-directory',
      context,
      '--file',
      file,
    ]
    const model = JSON.parse(
      await run(
        [
          ...args,
          'config',
          '--no-interpolate',
          '--no-env-resolution',
          '--format',
          'json',
        ],
        root,
        true,
      ),
    )
    const services = Object.entries(model.services ?? {}) as [string, any][]
    if (!services.length) throw new Error('Compose file must define services')
    if (!job.config.managed && !model.services[job.config.service]?.build)
      throw new Error('The configured Compose service must declare a build')
    const tags: Record<string, string> = {}
    const buildModel = {
      secrets: {
        ...(model.secrets ?? {}),
        ...Object.fromEntries(
          Object.keys(buildInputs?.secrets ?? {}).map((key) => [
            key,
            { file: `/tmp/build-secrets/${key}` },
          ]),
        ),
      },
      services: Object.fromEntries(
        services
          .filter(([, s]) => s.build)
          .map(([name, s], i) => {
            tags[name] = imageTag(job, i)
            const build = { ...s.build }
            const existingSecrets = build.secrets ?? []
            build.secrets = [
              ...existingSecrets,
              ...Object.keys(buildInputs?.secrets ?? {})
                .filter(
                  (key) =>
                    !existingSecrets.some(
                      (secret: any) =>
                        (typeof secret === 'string'
                          ? secret
                          : secret.source) === key,
                    ),
                )
                .map((key) => ({ source: key, target: key })),
            ]
            // Export and cache policy belong to the worker, not a repository extension.
            delete build['x-bake']
            delete build.cache_to
            delete build.tags
            return [
              name,
              { build, ...(s.platform ? { platform: s.platform } : {}) },
            ]
          }),
      ),
    }
    // Bake recognizes YAML as Compose; .json would be parsed as Bake's own JSON format.
    const buildFile = '/workspace/compose.yaml'
    await writeFile(buildFile, JSON.stringify(buildModel))
    for (const [name, tag] of Object.entries(tags)) {
      if (!job.config.managed && name !== job.config.service) continue
      const artifact = `image-${images.length}.tar`
      console.log(`Building Compose service ${name} inside rootless BuildKit.`)
      await run(
        [
          'buildx',
          'bake',
          '--allow',
          'fs.read=/workspace/repository',
          ...(secretFlags.length
            ? ['--allow', 'fs.read=/tmp/build-secrets']
            : []),
          '--allow',
          `fs.write=${output}`,
          '--builder',
          'isolated',
          '--progress',
          'plain',
          '--file',
          buildFile,
          '--set',
          `${name}.tags=${tag}`,
          '--set',
          `${name}.output=type=docker,dest=${join(output, artifact)}`,
          name,
        ],
        context,
      )
      images.push({ tag, file: artifact })
    }
    // Resolve build inputs above without runtime credentials. Preserve runtime
    // interpolation for the host's isolated .env evaluation after artifacts exist.
    const runtimeModel = JSON.parse(
      await run(
        [
          ...args,
          'config',
          '--no-interpolate',
          '--no-env-resolution',
          '--format',
          'json',
        ],
        root,
        true,
      ),
    )
    await writeFile(
      join(output, 'compose.json'),
      JSON.stringify(runtimeCompose(runtimeModel, job, tags)),
    )
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ images }))
  outputLog.flush()
  console.log('Build finished; artifacts are ready for deployment.')
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  buildHelper().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Build failed')
    process.exitCode = 1
  })
}
