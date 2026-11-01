import { createFileRoute } from '@tanstack/react-router'
import { connectorResourceSession } from '../api'
import { Pm2Page } from '../pm2'
export const Route = createFileRoute(
  '/_app/connectors/$connectorId/compute/pm2',
)({
  remountDeps: ({ params }) => params,
  staticData: { shell: { title: 'Compute / PM2', active: 'compute/pm2' } },
  loader: ({ params }) => connectorResourceSession(params.connectorId),
  component: Page,
})
function Page() {
  return <Pm2Page {...Route.useLoaderData()} />
}
