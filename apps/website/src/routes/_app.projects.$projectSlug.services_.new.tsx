import { createFileRoute } from '@tanstack/react-router'
import { api, projectSession, type ServiceList } from '../api'
import { ServiceCreatePage } from '../service-create'
export const Route = createFileRoute(
  '/_app/projects/$projectSlug/services_/new',
)({
  remountDeps: ({ params }) => params,
  staticData: {
    shell: { title: 'Services / Create service', active: 'services' },
  },
  loader: async ({ params }) => {
    const context = await projectSession(params.projectSlug)
    const permissions = await api<ServiceList>(
      `/projects/${params.projectSlug}/services`,
    )
    return {
      ...context,
      canCreate: permissions.can_create,
      canDeploy: !!permissions.can_deploy_all,
    }
  },
  component: Page,
})
function Page() {
  return (
    <ServiceCreatePage
      {...Route.useLoaderData()}
      project={Route.useParams().projectSlug}
    />
  )
}
