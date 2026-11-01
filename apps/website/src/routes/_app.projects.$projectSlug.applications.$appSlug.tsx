import { createFileRoute } from '@tanstack/react-router'
import { projectSession, api } from '../api'
import { ServiceDetail } from '../service-detail'
export const Route = createFileRoute(
  '/_app/projects/$projectSlug/applications/$appSlug',
)({
  remountDeps: ({ params }) => params,
  staticData: { shell: { title: 'Services', active: 'services' } },
  loader: async ({ params }) => {
    const context = await projectSession(params.projectSlug)
    const service = await api<{
      name?: string
      type?: 'application' | 'compose'
      can_deploy?: boolean
    }>(`/projects/${params.projectSlug}/applications/${params.appSlug}`)
    return { ...context, service }
  },
  component: Page,
})
function Page() {
  const { projectSlug, appSlug } = Route.useParams()
  const context = Route.useLoaderData()
  return (
    <>
      <ServiceDetail
        project={projectSlug}
        slug={appSlug}
        name={context.service.name ?? appSlug}
        canDeploy={context.user.admin || !!context.service.can_deploy}
        type={context.service.type}
      />
    </>
  )
}
