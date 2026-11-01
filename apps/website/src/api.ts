import type { ServerAddresses } from './server-addresses'
import { redirect } from '@tanstack/react-router'
export interface User {
  id: string
  username: string
  admin: boolean
  capabilities?: ServerCapability[]
}
export const serverCapabilities = [
  'dns.manage',
  'users.manage',
  'projects.create',
  'projects.manage',
  'connectors.manage',
  'connectors.operate',
  'inventory.manage',
] as const
export type ServerCapability = (typeof serverCapabilities)[number]
export const serverCapabilityLabels: Record<ServerCapability, string> = {
  'dns.manage': 'Manage shared DNS providers and project delegations',
  'users.manage': 'Manage users',
  'projects.create': 'Create projects',
  'projects.manage': 'Manage all projects and project access',
  'connectors.manage': 'Manage connectors',
  'connectors.operate': 'Operate connector resources',
  'inventory.manage': 'Manage inventory assignments',
}
export const hasServer = (user: User, capability: ServerCapability) =>
  user.admin || !!user.capabilities?.includes(capability)
export const adminCapabilities: Record<string, ServerCapability> = {
  dns: 'dns.manage',
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
  pm2_grants?: import('@kloud/protocol/pm2').Pm2Grant[]
  dns_grants?: import('@kloud/protocol/dns').DnsGrant[]
  id: string
  username: string
  disabled: boolean
  role: 'member' | 'admin'
  grants: Grant[]
  service_grants?: ServiceGrant[]
}
export const serviceCapabilities = [
  'read',
  'create',
  'update',
  'delete',
  'deploy',
  'reveal',
] as const
export interface ServiceGrant {
  capability: (typeof serviceCapabilities)[number]
  service: string | null
}
export interface Service {
  source_label?: string | null
  repository?: string | null
  branch?: string | null
  deployment_status?: 'queued' | 'running' | 'succeeded' | 'failed' | null
  last_deployment?: string | null
  slug: string
  name: string
  description: string
  type: 'application' | 'compose'
  can_update: boolean
  can_delete: boolean
  can_deploy: boolean
}
export interface ServiceList {
  can_create: boolean
  can_deploy_all?: boolean
  services: Service[]
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
    health?: 'healthy' | 'unhealthy' | 'starting'
    cpu: number | null
    memory: number | null
    memoryLimit: number | null
  }
}
export class ApiError extends Error {
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
  const timeout =
    path.includes('/pm2/') && path.endsWith('/operation')
      ? 40000
      : ['/auth/factor/challenge', '/auth/security/enroll'].includes(path)
        ? 30000
        : 10000
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Kloud-Origin': location.origin,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
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

export interface Connector extends ServerAddresses {
  id: string
  created_at?: string | null
  name: string
  host: string | null
  seen: string | null
  discovery: boolean
  revoked: boolean
  stale: boolean
  capabilities: string[]
}
export type ResourceScope =
  | { kind: 'project'; project: string }
  | { kind: 'connector'; connector: string }
export function resourceBase(scope: ResourceScope) {
  return scope.kind === 'project'
    ? '/projects/' + encodeURIComponent(scope.project)
    : '/connectors/' + encodeURIComponent(scope.connector)
}
export const canBrowseConnectors = (user: User) =>
  ['connectors.manage', 'inventory.manage', 'connectors.operate'].some((cap) =>
    hasServer(user, cap as ServerCapability),
  )
export const canBrowseConnectorResources = (user: User) =>
  hasServer(user, 'inventory.manage') || hasServer(user, 'connectors.operate')
export async function connectorSession(id: string) {
  const user = await session()
  const [projects, connector] = await Promise.all([
    api<Project[]>('/projects'),
    api<Connector>('/connectors/' + encodeURIComponent(id)),
  ])
  return { user, projects, connector }
}

export async function connectorResourceSession(id: string) {
  const data = await connectorSession(id)
  if (!canBrowseConnectorResources(data.user))
    throw redirect({
      to: '/connectors/$connectorId/overview',
      params: { connectorId: id },
    })
  return data
}
