import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { Compute } from '../compute'
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
      <Compute {...Route.useLoaderData()} project={project} storage="all" />
    </>
  )
}
