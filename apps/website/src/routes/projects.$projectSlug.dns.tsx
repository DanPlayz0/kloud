import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { DnsPage } from '../dns'
export const Route = createFileRoute('/projects/$projectSlug/dns')({
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})
function Page() {
  return (
    <DnsPage
      {...Route.useLoaderData()}
      project={Route.useParams().projectSlug}
    />
  )
}
