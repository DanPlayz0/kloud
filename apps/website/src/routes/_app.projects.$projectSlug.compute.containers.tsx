import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { Compute } from '../compute'
export const Route = createFileRoute(
  '/_app/projects/$projectSlug/compute/containers',
)({
  remountDeps: ({ params }) => params,
  staticData: {
    shell: { title: 'Compute / Containers', active: 'containers' },
  },
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})
function Page() {
  return (
    <Compute
      {...Route.useLoaderData()}
      project={Route.useParams().projectSlug}
    />
  )
}
