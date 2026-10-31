import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { Pm2Page } from '../pm2'
export const Route = createFileRoute('/projects/$projectSlug/compute/pm2')({
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})
function Page() {
  return (
    <Pm2Page
      {...Route.useLoaderData()}
      project={Route.useParams().projectSlug}
    />
  )
}
