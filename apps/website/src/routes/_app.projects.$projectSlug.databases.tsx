import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { ProjectDatabases } from '../project-databases'
export const Route = createFileRoute('/_app/projects/$projectSlug/databases')({
  remountDeps: ({ params }) => params,
  staticData: { shell: { title: 'Storage / Databases', active: 'databases' } },
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})
function Page() {
  const project = Route.useParams().projectSlug
  return (
    <>
      <ProjectDatabases project={project} />
    </>
  )
}
