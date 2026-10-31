/** Executed only by the disposable build-helper image, never by the connector. */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
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

export async function buildHelper() {
  const job = deploymentJobSchema.parse(
    JSON.parse(process.env.DEPLOYMENT_JOB ?? ''),
  )
  const token = process.env.DEPLOYMENT_GITHUB_TOKEN
  const phase = process.env.DEPLOYMENT_PHASE ?? 'build'
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
  const sensitive = token
    ? [token, Buffer.from(`x-access-token:${token}`).toString('base64')]
    : []
  const log = (s: string) =>
    process.stdout.write(
      sensitive.reduce(
        (text, secret) => text.replaceAll(secret, '[redacted]'),
        s,
      ),
    )
  const run = (args: string[], cwd = root, quiet = false) =>
    runCommand('docker', args, cwd, signal, quiet ? () => {} : log)
  if (phase === 'checkout') {
    console.log(`Checking out ${job.config.repository} at ${job.commit}.`)
    if (token) {
      process.env.GIT_CONFIG_COUNT = '2'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = '/dev/null'
      process.env.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader'
      process.env.GIT_CONFIG_VALUE_1 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    }
    await runCommand('git', ['init', '--quiet'], root, signal, log)
    await runCommand(
      'git',
      [
        'fetch',
        '--depth=1',
        '--no-tags',
        `https://github.com/${job.config.repository}.git`,
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
    console.log('Source checkout completed.')
    return
  }
  const file = await repositoryPath(root, job.config.build_file)
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
      '--tag',
      tag,
      '--output',
      `type=docker,dest=${join(output, artifact)}`,
      context,
    ])
    images.push({ tag, file: artifact })
  } else {
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
        [...args, 'config', '--no-env-resolution', '--format', 'json'],
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
      services: Object.fromEntries(
        services
          .filter(([, s]) => s.build)
          .map(([name, s], i) => {
            tags[name] = imageTag(job, i)
            const build = { ...s.build }
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
    await writeFile(
      join(output, 'compose.json'),
      JSON.stringify(runtimeCompose(model, job, tags)),
    )
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ images }))
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
