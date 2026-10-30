import { createFileRoute } from '@tanstack/react-router'
import { projectSession, api } from '../api'
import { Shell, Notice } from '../components'
export const Route = createFileRoute(
  '/projects/$projectSlug/applications/$appSlug',
)({
  loader: async ({ params }) => {
    const context = await projectSession(params.projectSlug)
    await api(`/projects/${params.projectSlug}/applications/${params.appSlug}`)
    return context
  },
  component: Page,
})
function Page() {
  const { projectSlug, appSlug } = Route.useParams()
  return (
    <Shell
      {...Route.useLoaderData()}
      project={projectSlug}
      title={`Applications / ${appSlug}`}
    >
      <Notice title={appSlug}>
        Application details are coming in a later update.{' '}
        <a href={`/projects/${projectSlug}/compute/containers`}>
          Back to containers
        </a>
      </Notice>
    </Shell>
  )
}
