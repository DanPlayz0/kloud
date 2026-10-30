import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'

export function commandEnvironment(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (command !== 'docker') return { ...env }
  // Compose must never interpolate connector credentials from its parent's env.
  const allowed = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'DOCKER_CONFIG',
    'DOCKER_API_VERSION',
    'DOCKER_CLI_PLUGIN_EXTRA_DIRS',
  ])
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase())),
  )
}

export async function repositoryPath(root: string, path: string) {
  const base = await realpath(root)
  const target = await realpath(resolve(base, path))
  const rel = relative(base, target)
  if (
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  )
    throw new Error('Build paths must stay inside the repository')
  return target
}

export function engine(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  return new Promise((resolveRequest, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        timeout: 30000,
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString()
          if (!res.statusCode || res.statusCode >= 300)
            reject(
              new Error(
                `Docker ${method} failed (${res.statusCode}): ${text.slice(0, 1000)}`,
              ),
            )
          else resolveRequest(text ? JSON.parse(text) : null)
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('Docker request timed out')))
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

// No shell interpolation. Repository contents never become command-line options.
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  log: (s: string) => void,
): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd,
      signal,
      killSignal: 'SIGKILL',
      windowsHide: true,
      env: {
        ...commandEnvironment(command),
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT ?? '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2 * 1024 * 1024)
      log(chunk.toString())
    })
    child.stderr.on('data', (chunk: Buffer) => log(chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolveCommand(output)
        : reject(new Error(`${command} exited with code ${code}`)),
    )
  })
}

export const dockerHost = (socket: string) =>
  process.platform === 'win32' ? `npipe://${socket}` : `unix://${socket}`
