import { createFileRoute } from '@tanstack/react-router'
import { connectorResourceSession } from '../api'
import { Pm2Page } from '../pm2'
export const Route = createFileRoute('/connectors/$connectorId/compute/pm2')({
  loader: ({ params }) => connectorResourceSession(params.connectorId),
  component: Page,
})
function Page() {
  return <Pm2Page {...Route.useLoaderData()} />
}
