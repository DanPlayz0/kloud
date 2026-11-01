import QuickTip from './components/quickTip'
import { Link } from '@tanstack/react-router'
import { Empty, EmptyHeader, EmptyDescription } from '@/components/ui/empty'
import { FieldSet, Field, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { StatusBadge } from './components/ui/status-badge'
import { useState, type FormEvent } from 'react'
import { Boxes, Plus, Pencil, Trash2 } from 'lucide-react'
import {
  api,
  type Project,
  type User,
  type Service,
  type ServiceList,
} from './api'
import { ErrorMessage, usePolling, bytes } from './components'
import type { ContainerRow } from './api'
import { Button, Input, Textarea } from './components/ui/controls'
import { Card } from './components/ui/card'
import {
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './components/ui/card'
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
  const [editing, setEditing] = useState<Service | null>(null)
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
      }
      await api(`${path}/${editing?.slug}`, 'PUT', body)
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
    <>
      <section className="admin-content flex flex-col gap-6">
        <div className="page-heading">
          <div>
            <h1>Services</h1>
            <p className="text-muted-foreground">
              Deploy applications and stacks. Monitor their health and manage
              their configuration.
            </p>
          </div>
          {data?.can_create && (
            <Button variant="primary" asChild>
              <Link
                to="/projects/$projectSlug/services/new"
                params={{ projectSlug: project }}
              >
                <Plus data-icon="inline-start" />
                Create service
              </Link>
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
              <Card key={service.slug} className="flex flex-col gap-4">
                <CardHeader className="flex-row items-start gap-3">
                  <Boxes
                    size={20}
                    className="shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <CardTitle asChild>
                      <Link
                        className="font-semibold break-all"
                        to="/projects/$projectSlug/applications/$appSlug"
                        params={{ projectSlug: project, appSlug: service.slug }}
                      >
                        {service.name}
                      </Link>
                    </CardTitle>
                    <CardDescription>
                      {service.type === 'compose'
                        ? 'Docker Compose'
                        : 'Application'}
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground break-words">
                    {service.description || service.slug}
                  </p>
                  <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">
                      Runtime:{' '}
                      <StatusBadge>
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
                      </StatusBadge>
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
                      {service.deployment_status ? (
                        <>
                          Latest deployment:{' '}
                          <StatusBadge deployment>
                            {service.deployment_status}
                          </StatusBadge>
                        </>
                      ) : (
                        'No deployments yet'
                      )}
                    </p>
                  </div>
                </CardContent>
                <CardFooter className="flex-wrap">
                  <Button asChild>
                    <Link
                      to="/projects/$projectSlug/applications/$appSlug"
                      params={{ projectSlug: project, appSlug: service.slug }}
                    >
                      Open service
                    </Link>
                  </Button>
                  {service.can_update && (
                    <QuickTip content={`Edit ${service.name}`}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${service.name}`}
                        onClick={() => {
                          setError('')
                          setEditing(service)
                        }}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                    </QuickTip>
                  )}
                  {service.can_delete && (
                    <QuickTip content={`Remove ${service.name}`}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${service.name}`}
                        onClick={() => {
                          setError('')
                          setRemoving(service)
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </QuickTip>
                  )}
                </CardFooter>
              </Card>
            )
          })}
        </div>
        {data && !filtered.length && (
          <Empty>
            <EmptyHeader>
              <EmptyDescription>
                {query
                  ? 'No services match your search.'
                  : 'No services available. Create a service or ask a project administrator for access.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!busy && !open) setEditing(null)
        }}
      >
        <DialogContent>
          <DialogTitle>Edit service</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Services keep their identity and permissions across deployments.
          </DialogDescription>
          {editing && (
            <Form
              key={editing.slug}
              onSubmit={save}
              className="mt-4 flex flex-col gap-4"
            >
              <FieldSet disabled={busy} className="flex flex-col gap-4">
                <Field>
                  <FieldLabel>Name</FieldLabel>
                  <Input
                    name="name"
                    required
                    maxLength={100}
                    defaultValue={editing.name}
                  />
                </Field>
                <Field>
                  <FieldLabel>Description</FieldLabel>
                  <Textarea
                    rows={3}
                    className="min-h-24 font-sans"
                    name="description"
                    maxLength={1000}
                    defaultValue={editing.description}
                  />
                </Field>
                <ErrorMessage message={error} />
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button variant="primary" disabled={busy}>
                    {busy ? 'Saving…' : 'Save service'}
                  </Button>
                </div>
              </FieldSet>
            </Form>
          )}
        </DialogContent>
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
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
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
    </>
  )
}
