import { createFileRoute } from '@tanstack/react-router'
import { connectorResourceSession } from '../api'
import { Compute } from '../compute'
export const Route = createFileRoute(
  '/connectors/$connectorId/compute/containers',
)({
  loader: ({ params }) => connectorResourceSession(params.connectorId),
  component: Page,
})
function Page() {
  return <Compute {...Route.useLoaderData()} />
}
