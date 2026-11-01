import { createFileRoute } from '@tanstack/react-router'
import { connectorSession } from '../api'
import { ConnectorOverview } from '../connector-overview'
export const Route = createFileRoute('/connectors/$connectorId/overview')({
  loader: ({ params }) => connectorSession(params.connectorId),
  component: Page,
})
function Page() {
  return <ConnectorOverview {...Route.useLoaderData()} />
}
