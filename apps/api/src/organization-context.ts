import { AsyncLocalStorage } from 'node:async_hooks'

export interface OrganizationContext {
  slug: string
  schema: string
}

export const organizationContext = new AsyncLocalStorage<OrganizationContext>()

export function currentOrganization() {
  return organizationContext.getStore()
}

export function organizationResourceKey(id: string) {
  return `${currentOrganization()?.slug ?? 'default'}:${id}`
}

export function bindOrganization<T extends (...args: any[]) => any>(
  operation: T,
): T {
  const organization = currentOrganization()
  return ((...args: Parameters<T>) =>
    organization
      ? runWithOrganization(organization, () => operation(...args))
      : organizationContext.exit(() => operation(...args))) as T
}

export function runWithOrganization<T>(
  organization: OrganizationContext,
  operation: () => T,
): T {
  // Schema names come from the organization registry, never directly from a
  // request. Keep this boundary strict even when called by background work.
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(organization.schema))
    throw new Error('Invalid organization schema')
  return organizationContext.run(organization, operation)
}

export function organizationApiPrefix() {
  const slug = currentOrganization()?.slug
  return slug && slug !== 'default' ? `/organizations/${slug}` : ''
}
export function scopedApiUrl(origin: string, path: string) {
  return `${origin}/api${organizationApiPrefix()}${path}`
}
export function organizationBrowserQuery() {
  const slug = currentOrganization()?.slug
  return slug && slug !== 'default'
    ? `?organization=${encodeURIComponent(slug)}`
    : ''
}
