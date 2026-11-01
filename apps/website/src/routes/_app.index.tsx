import { Link } from '@tanstack/react-router'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { api, session, hasServer, type Project } from '../api'
import { Notice } from '../components'

export const Route = createFileRoute('/_app/')({
  remountDeps: ({ params }) => params,
  staticData: { shell: { title: 'Overview', active: 'services' } },
  loader: async () => {
    const user = await session(),
      projects =
        user.organization_member === false
          ? []
          : await api<Project[]>('/projects')
    if (projects[0])
      throw redirect({
        to: '/projects/$projectSlug/services',
        params: { projectSlug: projects[0].slug },
      })
    return { user, projects }
  },
  component: Home,
})
function Home() {
  const { user, projects } = Route.useLoaderData()
  return (
    <>
      <Notice title="No projects yet">
        {hasServer(user, 'projects.create') &&
        hasServer(user, 'projects.manage') ? (
          <Link to="/admin/$section" params={{ section: 'projects' }}>
            Create your first project
          </Link>
        ) : hasServer(user, 'projects.create') ? (
          'Use the project selector to create your first project.'
        ) : (
          'Ask an administrator to grant you project access.'
        )}
      </Notice>
    </>
  )
}
