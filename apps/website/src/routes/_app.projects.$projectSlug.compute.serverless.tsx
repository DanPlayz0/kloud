import { Link } from '@tanstack/react-router'
import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { Notice } from '../components'
export const Route = createFileRoute(
  '/_app/projects/$projectSlug/compute/serverless',
)({
  remountDeps: ({ params }) => params,
  staticData: {
    shell: { title: 'Compute / Serverless', active: 'serverless' },
  },
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})
function Page() {
  return (
    <>
      <Notice title="Serverless is coming later">
        Kubernetes integration will be available in a future update.{' '}
        <Link
          to="/projects/$projectSlug/compute/containers"
          params={{ projectSlug: Route.useParams().projectSlug }}
        >
          View containers
        </Link>
      </Notice>
    </>
  )
}
