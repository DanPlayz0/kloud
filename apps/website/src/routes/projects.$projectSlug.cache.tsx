import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { Shell } from '../components'
import { Card } from '../components/ui/card'
import { StatusBadge } from '../components/ui/status-badge'

export const Route = createFileRoute('/projects/$projectSlug/cache')({
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})

function Page() {
  return (
    <Shell
      {...Route.useLoaderData()}
      project={Route.useParams().projectSlug}
      active="cache"
      title="Storage / Cache"
    >
      <section className="admin-content space-y-6">
        <div className="page-heading">
          <div>
            <p className="eyebrow">PROJECT CACHE</p>
            <h1>Cache</h1>
            <p className="text-muted-foreground">
              Redis, Valkey, and KeyDB cache services. Managed provisioning is
              coming in a future update.
            </p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {['Redis', 'Valkey', 'KeyDB'].map((engine) => (
            <Card key={engine} className="space-y-3">
              <h2 className="font-semibold">{engine}</h2>
              <StatusBadge>Coming soon</StatusBadge>
            </Card>
          ))}
        </div>
      </section>
    </Shell>
  )
}
