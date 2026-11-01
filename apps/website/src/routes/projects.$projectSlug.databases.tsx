import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { ProjectDatabases } from '../project-databases'
export const Route = createFileRoute('/projects/$projectSlug/databases')({
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})
function Page() {
  return <ProjectDatabases project={Route.useParams().projectSlug} />
}
