import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { ServicesPage } from '../services'

export const Route = createFileRoute('/projects/$projectSlug/services')({
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
