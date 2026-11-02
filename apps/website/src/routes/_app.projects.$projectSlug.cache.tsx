import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { Compute } from '../compute'

export const Route = createFileRoute('/_app/projects/$projectSlug/cache')({
  remountDeps: ({ params }) => params,
  staticData: { shell: { title: 'Storage / Cache', active: 'cache' } },
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})

function Page() {
  return (
    <Compute
      {...Route.useLoaderData()}
      project={Route.useParams().projectSlug}
      storage="cache"
    />
  )
}
