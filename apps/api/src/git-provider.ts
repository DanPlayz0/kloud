import { createSign } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

export const repositoryName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .max(201)
export const providerSchema = z.enum([
  'github',
  'github_app',
  'forgejo',
  'gitea',
])
export type Provider = z.infer<typeof providerSchema>
export interface Credentials {
  username?: string
  token?: string
  app_id?: string
  private_key?: string
  installation_id?: number
}
export interface GitConnection {
  project_access?: boolean
  id: string
  provider: Provider
  origin: string
  encrypted_credentials: string
  owner: string | null
}
export interface Repository {
  id: string
  name: string
  url: string
  default_branch: string
  private: boolean
}
export interface SourceAuth {
  token: string
  url: string
  username?: string
}

export function providerOrigin(provider: Provider, raw?: string) {
  if (provider === 'github' || provider === 'github_app')
    return 'https://github.com'
  let url: URL
  try {
    url = new URL(raw ?? '')
  } catch {
    throw new HTTPException(400, {
      message: 'Enter a canonical HTTPS Forgejo/Gitea origin.',
    })
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new HTTPException(400, {
      message:
        'Use an HTTPS provider origin without a path, credentials, query, or fragment.',
    })
  // Administrators explicitly authorize self-hosted origins, including private-network origins.
  const allowed = (process.env.GIT_PROVIDER_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (!allowed.includes(url.origin))
    throw new HTTPException(400, {
      message:
        'An administrator must add this self-hosted origin to GIT_PROVIDER_ORIGINS before it can receive credentials.',
    })
  return url.origin
}
export function repositoryFromUrl(raw: string, origin: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HTTPException(400, {
      message: 'Enter a canonical HTTPS repository URL.',
    })
  }
  if (
    url.origin !== origin ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[^/]+\/[^/]+(?:\.git)?\/?$/.test(url.pathname)
  )
    throw new HTTPException(400, {
      message:
        'Use the selected provider’s HTTPS repository URL without credentials or extra paths.',
    })
  return repositoryName.parse(
    url.pathname
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, ''),
  )
}
function apiOrigin(connection: Pick<GitConnection, 'provider' | 'origin'>) {
  return connection.provider.startsWith('github')
    ? 'https://api.github.com'
    : `${connection.origin}/api/v1`
}
export async function providerRequest(
  connection: Pick<GitConnection, 'provider' | 'origin'>,
  token: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${apiOrigin(connection)}${path}`, {
    method: options.method ?? 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      ...(token
        ? {
            authorization: `${connection.provider.startsWith('github') ? 'Bearer' : 'token'} ${token}`,
          }
        : {}),
      'content-type': 'application/json',
      'user-agent': 'Kloud',
      ...(connection.provider.startsWith('github')
        ? { 'X-GitHub-Api-Version': '2026-03-10' }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {
    throw new HTTPException(502, {
      message:
        'Git provider is unreachable. Check the configured origin, TLS, and network access.',
    })
  })
  if (!response.ok) {
    const status = [401, 403, 404, 409, 422].includes(response.status)
      ? response.status
      : 502
    throw new HTTPException(status as 401 | 403 | 404 | 409 | 422 | 502, {
      message: `Git provider returned ${response.status}. Verify repository access, token expiration, installation access, and organization approval/SSO requirements.`,
    })
  }
  if (response.status === 204) return null
  const size = Number(response.headers.get('content-length') ?? 0)
  if (size > 4 * 1024 * 1024)
    throw new HTTPException(502, {
      message: 'Git provider response is too large.',
    })
  const reader = response.body?.getReader()
  if (!reader)
    throw new HTTPException(502, {
      message: 'Git provider returned an empty response.',
    })
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > 4 * 1024 * 1024) {
        await reader.cancel()
        throw new HTTPException(502, {
          message: 'Git provider response is too large.',
        })
      }
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (error instanceof HTTPException) throw error
    throw new HTTPException(502, {
      message: 'Git provider returned an unreadable response.',
    })
  }
}
export function appJwt(credentials: Credentials) {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: credentials.app_id }),
  ).toString('base64url')
  const message = `${header}.${payload}`
  try {
    return `${message}.${createSign('RSA-SHA256').update(message).sign(credentials.private_key!, 'base64url')}`
  } catch {
    throw new HTTPException(400, {
      message: 'GitHub App private key is invalid.',
    })
  }
}
export async function accessToken(
  connection: GitConnection,
  credentials: Credentials,
) {
  if (connection.provider !== 'github_app') return credentials.token!
  const data = await providerRequest(
    connection,
    appJwt(credentials),
    `/app/installations/${credentials.installation_id}/access_tokens`,
    { method: 'POST' },
  )
  return z.string().min(1).parse(data.token)
}
export function canonicalRepository(data: any, origin: string): Repository {
  const name = repositoryName.parse(data.full_name)
  return {
    id: z.union([z.string(), z.number()]).transform(String).parse(data.id),
    name,
    url: `${origin}/${name}`,
    default_branch: z.string().parse(data.default_branch),
    private: Boolean(data.private),
  }
}
export async function getRepository(
  connection: GitConnection,
  token: string,
  name: string,
) {
  return canonicalRepository(
    await providerRequest(
      connection,
      token,
      `/repos/${repositoryName.parse(name)}`,
    ),
    connection.origin,
  )
}
export async function repositoryFile(
  connection: GitConnection,
  token: string,
  name: string,
  path: string,
  ref: string,
) {
  if (path.split('/').some((part) => part === '..') || path.startsWith('/'))
    throw new HTTPException(400)
  const endpoint = `/repos/${repositoryName.parse(name)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
  try {
    const file = await providerRequest(connection, token, endpoint)
    if (
      file.type !== 'file' ||
      file.encoding !== 'base64' ||
      file.size > 256000
    )
      return null
    return Buffer.from(file.content, 'base64').toString('utf8')
  } catch (error) {
    if (error instanceof HTTPException && error.status === 404) return null
    throw error
  }
}
