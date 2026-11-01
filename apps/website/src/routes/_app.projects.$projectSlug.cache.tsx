import { CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { createFileRoute } from '@tanstack/react-router'
import { projectSession } from '../api'
import { Card } from '../components/ui/card'
import { StatusBadge } from '../components/ui/status-badge'

export const Route = createFileRoute('/_app/projects/$projectSlug/cache')({
  remountDeps: ({ params }) => params,
  staticData: { shell: { title: 'Storage / Cache', active: 'cache' } },
  loader: ({ params }) => projectSession(params.projectSlug),
  component: Page,
})

function Page() {
  return (
    <>
      <section className="admin-content flex flex-col gap-6">
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
            <Card key={engine} className="flex flex-col gap-3">
              <CardHeader>
                <CardTitle asChild>
                  <h2 className="font-semibold">{engine}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <StatusBadge>Coming soon</StatusBadge>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </>
  )
}
