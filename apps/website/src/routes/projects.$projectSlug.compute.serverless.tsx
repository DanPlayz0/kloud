import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { Shell, Notice } from '../components'
export const Route = createFileRoute(
  '/projects/$projectSlug/compute/serverless',
)({
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})
function Page() {
  return (
    <Shell
      {...Route.useLoaderData()}
      project={Route.useParams().projectSlug}
      active="serverless"
      title="Compute / Serverless"
    >
      <Notice title="Serverless is coming later">
        Kubernetes integration will be available in a future update.{' '}
        <a
          href={`/projects/${Route.useParams().projectSlug}/compute/containers`}
        >
          View containers
        </a>
      </Notice>
    </Shell>
  )
}
