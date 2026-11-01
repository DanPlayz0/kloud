import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { ProjectDatabases } from '../project-databases'
import { Shell } from '../components'
export const Route = createFileRoute('/projects/$projectSlug/databases')({
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})
function Page() {
  const project = Route.useParams().projectSlug
  return (
    <Shell
      {...Route.useLoaderData()}
      project={project}
      active="databases"
      title="Storage / Databases"
    >
      <ProjectDatabases project={project} />
    </Shell>
  )
}
