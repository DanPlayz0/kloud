import { redirect } from '@tanstack/react-router'
export interface User {
  id: string
  username: string
  admin: boolean
  capabilities?: ServerCapability[]
}
export const serverCapabilities = [
  'users.manage',
  'projects.manage',
  'connectors.manage',
  'inventory.manage',
] as const
export type ServerCapability = (typeof serverCapabilities)[number]
export const serverCapabilityLabels: Record<ServerCapability, string> = {
  'users.manage': 'Manage users',
  'projects.manage': 'Manage projects and all project access',
  'connectors.manage': 'Manage connectors',
  'inventory.manage': 'Manage inventory assignments',
}
export const hasServer = (user: User, capability: ServerCapability) =>
  user.admin || !!user.capabilities?.includes(capability)
export const adminCapabilities: Record<string, ServerCapability> = {
  users: 'users.manage',
  projects: 'projects.manage',
  connectors: 'connectors.manage',
  containers: 'inventory.manage',
}
export const containerCapabilities = [
  'view',
  'logs',
  'lifecycle',
  'terminal',
  'configuration',
] as const
export type ContainerCapability = (typeof containerCapabilities)[number]
export interface Grant {
  capability: ContainerCapability
  kind: 'all' | 'id' | 'name'
  connector_id: string | null
  target: string | null
}
export interface ProjectMember {
  id: string
  username: string
  disabled: boolean
  role: 'member' | 'admin'
  grants: Grant[]
}
export interface ProjectAccess {
  grant_mode: 'id' | 'name'
  members: ProjectMember[]
}
export interface Project {
  slug: string
  name: string
  grant_mode?: 'id' | 'name'
  role?: 'member' | 'admin' | null
  can_manage_access?: boolean
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
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
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
export async function adminSession(section: string) {
  const user = await session()
  if (
    !adminCapabilities[section] ||
    !hasServer(user, adminCapabilities[section])
  )
    throw new Error('Server permission required')
  return user
}
