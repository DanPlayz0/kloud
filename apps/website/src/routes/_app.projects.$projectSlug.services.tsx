import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { ServicesPage } from '../services'

export const Route = createFileRoute('/_app/projects/$projectSlug/services')({
  remountDeps: ({ params }) => params,
  staticData: { shell: { title: 'Project / Services', active: 'services' } },
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})
function Page() {
  return (
    <ServicesPage
      {...Route.useLoaderData()}
      project={Route.useParams().projectSlug}
    />
  )
}
