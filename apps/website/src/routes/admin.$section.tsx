import { createFileRoute, notFound } from '@tanstack/react-router'
import { adminSession, api, type Project } from '../api'
import { Admin } from '../admin'
export const Route = createFileRoute('/admin/$section')({
  loader: async ({ params }) => {
    const user = await adminSession(params.section)
    if (
      !['projects', 'users', 'connectors', 'containers', 'dns'].includes(
        params.section,
      )
    )
      throw notFound()
    return { user, projects: await api<Project[]>('/projects') }
  },
  component: Page,
})
function Page() {
  return (
    <Admin {...Route.useLoaderData()} section={Route.useParams().section} />
  )
}
