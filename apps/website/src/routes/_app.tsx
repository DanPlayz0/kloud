import { createFileRoute, Outlet, useMatches } from '@tanstack/react-router'
import { api, session, type Project, type User, type Connector } from '../api'
import { Shell } from '../components'

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    shell?: { title: string; active: string }
  }
}

export const Route = createFileRoute('/_app')({
  loader: async () => ({
    user: await session(),
    projects: await api<Project[]>('/projects'),
  }),
  component: AppLayout,
})

function AppLayout() {
  const session = Route.useLoaderData()
  const match = useMatches({
    select: (matches) => matches[matches.length - 1]!,
  })
  const data = match.loaderData as
    | {
        user?: User
        projects?: Project[]
        connector?: Connector
        service?: { name?: string }
      }
    | undefined
  const params = match.params as {
    projectSlug?: string
    appSlug?: string
    section?: string
  }
  const shell = match.staticData.shell ?? { title: 'Overview', active: '' }
  const adminTitles: Record<string, string> = {
    projects: 'Projects',
    users: 'Users',
    connectors: 'Connectors',
    containers: 'Runtime inventory',
    dns: 'DNS providers',
  }
  const title = params.section
    ? `Administration / ${adminTitles[params.section] ?? params.section}`
    : params.appSlug
      ? `Services / ${data?.service?.name ?? params.appSlug}`
      : shell.title

  return (
    <Shell
      user={data?.user ?? session.user}
      projects={data?.projects ?? session.projects}
      project={params.projectSlug}
      connector={data?.connector}
      title={title}
      active={params.section ? `admin-${params.section}` : shell.active}
    >
      <Outlet />
    </Shell>
  )
}
