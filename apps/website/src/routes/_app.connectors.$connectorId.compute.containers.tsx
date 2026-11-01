import { createFileRoute } from '@tanstack/react-router'
import { connectorResourceSession } from '../api'
import { Compute } from '../compute'
export const Route = createFileRoute(
  '/_app/connectors/$connectorId/compute/containers',
)({
  remountDeps: ({ params }) => params,
  staticData: {
    shell: { title: 'Compute / Containers', active: 'compute/containers' },
  },
  loader: ({ params }) => connectorResourceSession(params.connectorId),
  component: Page,
})
function Page() {
  return <Compute {...Route.useLoaderData()} />
}
