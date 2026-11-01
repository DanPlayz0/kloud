interface Package {
  packageManager?: string
  workspaces?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}
export function suggestDockerfile(
  files: Record<string, string | null>,
  appRoot = '.',
  context = '.',
) {
  const parse = (path: string): Package => {
    try {
      return JSON.parse(files[path] ?? '{}')
    } catch {
      return {}
    }
  }
  const prefix = appRoot === '.' ? '' : `${appRoot}/`
  const root = parse('package.json'),
    app = parse(`${prefix}package.json`)
  const dependencies = { ...app.dependencies, ...app.devDependencies }
  const pnpm =
    root.packageManager?.startsWith('pnpm@') ||
    files['pnpm-lock.yaml'] != null ||
    files[`${prefix}pnpm-lock.yaml`] != null
  const npm =
    root.packageManager?.startsWith('npm@') ||
    files['package-lock.json'] != null ||
    files[`${prefix}package-lock.json`] != null
  const manager = pnpm ? 'pnpm' : npm ? 'npm' : null
  const framework = dependencies.next
    ? 'Next.js'
    : dependencies.vite
      ? 'Vite'
      : dependencies['@sveltejs/kit']
        ? 'SvelteKit'
        : null
  const workspace = Boolean(
    root.workspaces || files['pnpm-workspace.yaml'] != null,
  )
  const evidence = [
    manager
      ? `${manager} detected from packageManager/lockfile evidence.`
      : 'No supported npm/pnpm lockfile detected.',
    framework
      ? `${framework} detected in the selected app dependencies.`
      : 'No framework inferred from the package manager.',
    workspace
      ? 'Root workspace metadata detected.'
      : 'No root workspace metadata detected.',
  ]
  const warnings = [
    'Review and commit this file yourself. Kloud never commits a suggestion or uses it as an override.',
    'Commit a .dockerignore excluding .git, node_modules, .env files, local credentials, and build output.',
    'Private package credentials must be provided as the npmrc BuildKit secret, never ARG/ENV token literals.',
  ]
  if (!manager || !files[`${prefix}package.json`])
    return { evidence, warnings, dockerfile: null }
  if (context !== '.' && workspace) {
    warnings.push(
      'A monorepo workspace normally needs repository-root build context. Select context “.” before using this suggestion.',
    )
    return { evidence, warnings, dockerfile: null }
  }
  if (context !== '.' && context !== appRoot) {
    warnings.push(
      'The selected context does not match the app root or repository root. Configure it explicitly before generating a Dockerfile.',
    )
    return { evidence, warnings, dockerfile: null }
  }
  const relativeApp = context === appRoot ? '.' : appRoot
  const selector =
    relativeApp === '.'
      ? ''
      : manager === 'pnpm'
        ? ` --filter ./${relativeApp}`
        : ` --workspace=${relativeApp}`
  const build =
    manager === 'pnpm'
      ? `pnpm${selector} run build`
      : `npm run build${selector}`
  const start =
    manager === 'pnpm'
      ? [
          'pnpm',
          ...(relativeApp === '.' ? [] : ['--filter', `./${relativeApp}`]),
          'start',
        ]
      : [
          'npm',
          'start',
          ...(relativeApp === '.' ? [] : [`--workspace=${relativeApp}`]),
        ]
  if (!app.scripts?.build)
    warnings.push(
      'No build script was detected. Edit the build step to match this application.',
    )
  if (!app.scripts?.start && framework !== 'Vite')
    warnings.push(
      'No start script was detected. Add or edit the production start command before committing.',
    )
  const install =
    manager === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'npm ci'
  const preamble = `# syntax=docker/dockerfile:1\n# Paths are relative to build context: ${context}\nFROM node:22-alpine AS build\nWORKDIR /app\n${manager === 'pnpm' ? 'RUN corepack enable\n' : ''}COPY . .\nRUN --mount=type=secret,id=npmrc,target=/root/.npmrc ${install}\n# Declare and use public build ARG values here if your framework needs them.\nRUN ${build}\n`
  const dockerfile =
    framework === 'Vite'
      ? `${preamble}\nFROM nginx:alpine\nCOPY --from=build /app/${relativeApp === '.' ? '' : `${relativeApp}/`}dist /usr/share/nginx/html\nEXPOSE 80\n`
      : `${preamble}\nFROM node:22-alpine AS runtime\nWORKDIR /app\nENV NODE_ENV=production\n${manager === 'pnpm' ? 'RUN corepack enable\n' : ''}COPY --from=build --chown=node:node /app /app\nUSER node\nEXPOSE 3000\nCMD ${JSON.stringify(start)}\n`
  return { evidence, warnings, dockerfile }
}
