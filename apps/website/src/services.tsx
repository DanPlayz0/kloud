import { useState, type FormEvent } from 'react'
import { Boxes, Plus, Pencil, Trash2 } from 'lucide-react'
import {
  api,
  type Project,
  type User,
  type Service,
  type ServiceList,
} from './api'
import { Shell, ErrorMessage, usePolling, bytes } from './components'
import type { ContainerRow } from './api'
import { ServiceCreate } from './service-create'
import { Button, Input, Label } from './components/ui/controls'
import { Card } from './components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './components/ui/dialog'

export function ServicesPage({
  user,
  projects,
  project,
}: {
  user: User
  projects: Project[]
  project: string
}) {
  const [revision, setRevision] = useState(0)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Service | 'new' | null>(null)
  const [removing, setRemoving] = useState<Service | null>(null)
  const [busy, setBusy] = useState(false)
  const path = `/projects/${project}/services`
  const { data, error: loadError } = usePolling<ServiceList>(path, revision)
  const { data: containers, error: runtimeError } = usePolling<ContainerRow[]>(
    `/projects/${project}/containers`,
  )
  const filtered =
    data?.services?.filter((s) =>
      `${s.name} ${s.slug} ${s.type}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? []
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const body = {
        name: form.get('name'),
        description: form.get('description'),
        ...(editing === 'new'
          ? { slug: form.get('slug'), type: form.get('type') }
          : {}),
      }
      await api(
        editing === 'new' ? path : `${path}/${editing?.slug}`,
        editing === 'new' ? 'POST' : 'PUT',
        body,
      )
      setEditing(null)
      setRevision((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save service')
    } finally {
      setBusy(false)
    }
  }
  async function remove() {
    if (!removing) return
    setBusy(true)
    setError('')
    try {
      await api(`${path}/${removing.slug}`, 'DELETE')
      setRemoving(null)
      setRevision((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to remove service')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Shell
      user={user}
      projects={projects}
      project={project}
      active="services"
      title="Project / Services"
    >
      <section className="admin-content space-y-6">
        <div className="page-heading">
          <div>
            <h1>Services</h1>
            <p className="text-muted-foreground">
              Deploy applications and stacks. Monitor their health and manage
              their configuration.
            </p>
          </div>
          {data?.can_create && (
            <Button
              variant="primary"
              onClick={() => {
                setError('')
                setEditing('new')
              }}
            >
              <Plus size={16} /> Create service
            </Button>
          )}
        </div>
        <ErrorMessage
          message={loadError || (!editing && !removing ? error : '')}
        />
        <Input
          aria-label="Search services"
          placeholder="Search services"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!data && !loadError && (
          <p className="text-muted-foreground" role="status">
            Loading services…
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((service) => {
            const runtime = containers?.filter(
              (c) => c.application === service.slug,
            )
            const stale = runtime?.some(
              (c) =>
                c.stale || !c.seen || Date.now() - Date.parse(c.seen) > 20000,
            )
            return (
              <Card key={service.slug} className="space-y-4 p-5">
                <div className="flex items-start gap-3">
                  <Boxes size={20} />
                  <div className="min-w-0">
                    <a
                      className="font-semibold break-all"
                      href={`/projects/${project}/applications/${service.slug}`}
                    >
                      {service.name}
                    </a>
                    <p className="text-sm text-muted-foreground">
                      {service.type === 'compose'
                        ? 'Docker Compose'
                        : 'Application'}
                    </p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground break-words">
                  {service.description || service.slug}
                </p>
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">
                    Runtime:{' '}
                    {runtimeError
                      ? 'Unavailable'
                      : !runtime
                        ? 'Loading'
                        : stale
                          ? 'Host disconnected'
                          : !runtime.length
                            ? 'Not deployed'
                            : runtime.every(
                                  (c) =>
                                    c.data.state === 'running' &&
                                    c.data.health !== 'unhealthy' &&
                                    c.data.health !== 'starting',
                                )
                              ? 'Running'
                              : 'Needs attention'}
                  </p>
                  {!!runtime?.length && (
                    <>
                      <p>
                        {[
                          ...new Set(
                            runtime.map((c) => c.host ?? c.connector_name),
                          ),
                        ].join(', ')}
                      </p>
                      <p>
                        {runtime.length} container
                        {runtime.length === 1 ? '' : 's'} ·{' '}
                        {stale
                          ? 'Metrics unavailable'
                          : `${runtime.reduce((sum, c) => sum + (c.data.cpu ?? 0), 0).toFixed(1)}% CPU · ${bytes(runtime.reduce((sum, c) => sum + (c.data.memory ?? 0), 0))} RAM`}
                      </p>
                    </>
                  )}
                  <p>
                    {service.source_label ??
                      (service.repository
                        ? `${service.repository} · ${service.branch}`
                        : 'Source not configured')}
                  </p>
                  <p>
                    {service.deployment_status
                      ? `Latest deployment: ${service.deployment_status}`
                      : 'No deployments yet'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild>
                    <a
                      href={`/projects/${project}/applications/${service.slug}`}
                    >
                      Open service
                    </a>
                  </Button>
                  {service.can_update && (
                    <Button
                      aria-label={`Edit ${service.name}`}
                      onClick={() => {
                        setError('')
                        setEditing(service)
                      }}
                    >
                      <Pencil size={16} />
                    </Button>
                  )}
                  {service.can_delete && (
                    <Button
                      aria-label={`Remove ${service.name}`}
                      onClick={() => {
                        setError('')
                        setRemoving(service)
                      }}
                    >
                      <Trash2 size={16} />
                    </Button>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
        {data && !filtered.length && (
          <Card className="p-8 text-center text-muted-foreground">
            {query
              ? 'No services match your search.'
              : 'No services available. Create a service or ask a project administrator for access.'}
          </Card>
        )}
      </section>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!busy && !open) setEditing(null)
        }}
      >
        {editing === 'new' ? (
          <ServiceCreate
            key={revision}
            project={project}
            canDeploy={!!data?.can_deploy_all}
          />
        ) : (
          <DialogContent>
            <DialogTitle>Edit service</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Services keep their identity and permissions across deployments.
            </DialogDescription>
            {editing && (
              <form
                key={editing.slug}
                onSubmit={save}
                className="mt-4 space-y-4"
              >
                <fieldset disabled={busy} className="space-y-4">
                  <Label>
                    Name
                    <Input
                      name="name"
                      required
                      maxLength={100}
                      defaultValue={editing.name}
                    />
                  </Label>
                  <Label>
                    Description
                    <Input
                      name="description"
                      maxLength={1000}
                      defaultValue={editing.description}
                    />
                  </Label>
                  <ErrorMessage message={error} />
                  <div className="flex justify-end gap-2">
                    <Button type="button" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button variant="primary" disabled={busy}>
                      {busy ? 'Saving…' : 'Save service'}
                    </Button>
                  </div>
                </fieldset>
              </form>
            )}
          </DialogContent>
        )}
      </Dialog>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!busy && !open) setRemoving(null)
        }}
      >
        <DialogContent>
          <DialogTitle>Remove {removing?.name}?</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            This removes the service, its deployment configuration, build
            history, and specific permissions. Future webhook builds stop.
            Running containers and volumes remain on their host.
          </DialogDescription>
          <ErrorMessage message={error} />
          <div className="mt-4 flex justify-end gap-2">
            <Button disabled={busy} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Removing…' : 'Remove service'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Shell>
  )
}
