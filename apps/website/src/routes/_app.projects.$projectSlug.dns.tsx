import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { DnsPage } from '../dns'
export const Route = createFileRoute('/_app/projects/$projectSlug/dns')({
  remountDeps: ({ params }) => params,
  staticData: { shell: { title: 'Networking / Cloud DNS', active: 'dns' } },
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
