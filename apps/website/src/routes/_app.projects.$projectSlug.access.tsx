import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { ProjectAccessPage } from '../project-access'

export const Route = createFileRoute('/_app/projects/$projectSlug/access')({
  remountDeps: ({ params }) => params,
  staticData: { shell: { title: 'Project / Access', active: 'access' } },
  loader: async ({ params }) => {
    const session = await projectSession(params.projectSlug)
    if (
      !session.projects.find((p) => p.slug === params.projectSlug)
        ?.can_manage_access
    )
      throw new Error('Project Administrator permission required')
    return session
  },
  component: Page,
})
function Page() {
  return (
    <ProjectAccessPage
      {...Route.useLoaderData()}
      project={Route.useParams().projectSlug}
    />
  )
}
