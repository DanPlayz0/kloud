import type { ServerAddresses } from './server-addresses'
import { redirect } from '@tanstack/react-router'

export interface Organization {
  slug: string
  name: string
  api_url?: string
  description?: string | null
  website?: string | null
  admin?: boolean
}
const organizationSlug = /^[a-z0-9]+(-[a-z0-9]+)*$/
export function validOrganizationSlug(value: string) {
  return value.length <= 63 && organizationSlug.test(value)
}
function initialOrganization() {
  const requested = new URLSearchParams(location.search).get('organization')
  let saved: string | null = null
  try {
    saved = localStorage.getItem('kloud-organization')
  } catch {
    /* Storage can be disabled. */
  }
  const slug =
    requested && validOrganizationSlug(requested)
      ? requested
      : saved && validOrganizationSlug(saved)
        ? saved
        : 'default'
  try {
    localStorage.setItem('kloud-organization', slug)
  } catch {
    /* URL routing still works. */
  }
  return slug
}
const selectedOrganization = initialOrganization()
export const currentOrganization = () => selectedOrganization
export function organizationApiPath(path: string) {
  return (
    '/api' +
    (selectedOrganization === 'default'
      ? ''
      : '/organizations/' + encodeURIComponent(selectedOrganization)) +
    path
  )
}
export function organizationPath(path: string) {
  return (
    path +
    (path.includes('?') ? '&' : '?') +
    'organization=' +
    encodeURIComponent(selectedOrganization)
  )
}
export function switchOrganization(slug: string) {
  if (!validOrganizationSlug(slug))
    throw new Error('Enter a valid organization slug')
  try {
    localStorage.setItem('kloud-organization', slug)
  } catch {
    /* URL routing still works. */
  }
  window.location.assign('/?organization=' + encodeURIComponent(slug))
}
export interface User {
  organization_member?: boolean
  id: string
  username: string
  email?: string | null
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
  'git.create',
  'git.manage',
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
  'git.create': 'Create Git connections',
  'git.manage': 'Manage all Git connections',
}
export const hasServer = (user: User, capability: ServerCapability) =>
  user.admin || !!user.capabilities?.includes(capability)
export const adminCapabilities: Record<string, ServerCapability> = {
  'git-connections': 'git.manage',
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
  email?: string | null
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
    image?: string
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
  const lookup = path.startsWith('/organizations/lookup/')
  const response = await fetch(
    lookup ? '/api' + path : organizationApiPath(path),
    {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Kloud-Origin': location.origin,
        ...(!lookup ? { 'X-Kloud-Organization': selectedOrganization } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    },
  )
  if (response.status === 401 && !path.startsWith('/auth/')) {
    window.location.assign(
      `/login?organization=${encodeURIComponent(selectedOrganization)}&next=${encodeURIComponent(location.pathname)}`,
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
    const user = await api<User>('/auth/me')
    if (user.organization_member === false) {
      const memberships = await api<Organization[]>('/organizations')
      if (memberships[0])
        throw redirect({
          href: '/?organization=' + encodeURIComponent(memberships[0].slug),
          reloadDocument: true,
        })
    }
    return user
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
    throw new Error('Organization permission required')
  return user
}

export interface Connector extends ServerAddresses {
  agent_status?: import('@kloud/protocol/connector').ConnectorStatus | null
  auto_update?: boolean | null
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
