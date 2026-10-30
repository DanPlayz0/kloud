import { redirect } from '@tanstack/react-router'
export interface User {
  id: string
  username: string
  admin: boolean
}
export interface Project {
  slug: string
  name: string
}
export interface ContainerRow {
  connector_id: string
  connector_name: string
  host: string | null
  seen: string | null
  stale: boolean
  container_id: string
  project: string | null
  application: string | null
  assignment: 'label' | 'manual' | null
  data: {
    name: string
    state: string
    cpu: number | null
    memory: number | null
    memoryLimit: number | null
  }
}
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
export async function api<T = unknown>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (response.status === 401 && !path.startsWith('/auth/')) {
    window.location.assign(
      `/login?next=${encodeURIComponent(location.pathname)}`,
    )
    throw new Error('Session expired')
  }
  const data = await response.json()
  if (!response.ok)
    throw new ApiError(data.error ?? 'Request failed', response.status)
  return data as T
}
export async function session() {
  try {
    return await api<User>('/auth/me')
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      throw redirect({ to: '/login', search: { next: location.pathname } })
    throw error
  }
}
export async function projectSession(slug: string) {
  const user = await session(),
    projects = await api<Project[]>('/projects')
  if (!projects.some((p) => p.slug === slug))
    throw new Error('Project not found or access denied')
  return { user, projects }
}
export async function adminSession() {
  const user = await session()
  if (!user.admin) throw new Error('Administrator access required')
  return user
}
