import { createFileRoute, redirect } from '@tanstack/react-router'
import { api, session, hasServer, type Project } from '../api'
import { Shell, Notice } from '../components'

export const Route = createFileRoute('/')({
  loader: async () => {
    const user = await session(),
      projects = await api<Project[]>('/projects')
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
    <Shell user={user} projects={projects} title="Overview">
      <Notice title="No projects yet">
        {hasServer(user, 'projects.create') &&
        hasServer(user, 'projects.manage') ? (
          <a href="/admin/projects">Create your first project</a>
        ) : hasServer(user, 'projects.create') ? (
          'Use the project selector to create your first project.'
        ) : (
          'Ask an administrator to grant you project access.'
        )}
      </Notice>
    </Shell>
  )
}
