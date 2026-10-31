import { StatusBadge } from './components/ui/status-badge'
import { Container } from 'lucide-react'
import { InventoryCard } from './components/inventory-card'
import { ProjectFields, projectFormValues } from './components/project-fields'
import {
  Button,
  Input,
  NativeSelect,
  Label,
  Checkbox,
} from './components/ui/controls'
import { useEffect, useState, type FormEvent } from 'react'
import {
  api,
  hasServer,
  type User,
  type Project,
  type ContainerRow,
} from './api'
import { Shell, usePolling, ErrorMessage, Notice, Icon } from './components'
import { Users } from './components/users'
import { DnsProviders } from './dns'
import { Pm2Inventory } from './pm2'
type Connector = {
  id: string
  name: string
  host: string | null
  discovery: boolean
  revoked: boolean
  stale: boolean
}
export function Admin({
  user,
  projects,
  section,
}: {
  user: User
  projects: Project[]
  section: string
}) {
  const [revision, setRevision] = useState(0),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [projectList, setProjectList] = useState(projects)
  useEffect(() => setProjectList(projects), [projects])
  async function action(path: string, method: string, body: unknown) {
    setError('')
    setMessage('')
    setBusy(true)
    try {
      const result = await api<{ enrollmentUrl?: string; token?: string }>(
        path,
        method,
        body,
      )
      setMessage(
        result.enrollmentUrl
          ? `Enrollment link (valid for 24 hours): ${result.enrollmentUrl}`
          : result.token
            ? `Connector token — copy now; it is shown only once: ${result.token}`
            : 'Changes saved.',
      )
      setRevision((n) => n + 1)
      if (path.startsWith('/admin/projects')) {
        // Keep the sidebar in sync without losing a successful mutation's result.
        void api<Project[]>('/projects')
          .then(setProjectList)
          .catch(() => {})
      }
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
      return false
    } finally {
      setBusy(false)
    }
  }
  const titles: Record<string, string> = {
    projects: 'Projects',
    users: 'Users',
    connectors: 'Connectors',
    containers: 'Runtime inventory',
    dns: 'DNS providers',
  }
  return (
    <Shell
      user={user}
      projects={projectList}
      active={`admin-${section}`}
      title={`Administration / ${titles[section]}`}
    >
      <section className="admin-content">
        <div className="page-heading">
          <div>
            <p className="eyebrow">ADMINISTRATION</p>
            <h1>{titles[section]}</h1>
          </div>
        </div>
        <ErrorMessage message={error} />
        {message && (
          <div className="success" role="status">
            <span>{message}</span>
            <Button onClick={() => setMessage('')} aria-label="Dismiss">
              <Icon name="close" />
            </Button>
          </div>
        )}
        <fieldset className="admin-controls" disabled={busy}>
          {section === 'dns' ? (
            <DnsProviders projects={projectList} />
          ) : section === 'projects' ? (
            <Projects
              revision={revision}
              action={action}
              canCreate={hasServer(user, 'projects.create')}
            />
          ) : section === 'users' ? (
            <Users
              revision={revision}
              action={action}
              current={user}
              projects={projectList}
            />
          ) : section === 'connectors' ? (
            <Connectors revision={revision} action={action} />
          ) : (
            <>
              <Inventory
                revision={revision}
                action={action}
                projects={projectList}
              />
              <Pm2Inventory projects={projectList} />
            </>
          )}
        </fieldset>
      </section>
    </Shell>
  )
}
type Action = (path: string, method: string, body: unknown) => Promise<boolean>
function Projects({
  revision,
  action,
  canCreate,
}: {
  revision: number
  action: Action
  canCreate: boolean
}) {
  const { data, error } = usePolling<Project[]>(
    `/admin/projects?revision=${revision}`,
  )
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    void action('/admin/projects', 'POST', projectFormValues(e.currentTarget))
  }
  return (
    <>
      {canCreate && (
        <form className="inline-form bg-card border-border" onSubmit={submit}>
          <ProjectFields />
          <Button className="primary">Create project</Button>
        </form>
      )}
      <ErrorMessage message={error} />
      {data?.map((p) => (
        <div className="admin-row bg-card border-border" key={p.slug}>
          <div>
            <strong>{p.name}</strong>
            <small>{p.slug}</small>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={`/projects/${p.slug}/access`}>Manage access</a>
            </Button>
            <Button
              type="button"
              onClick={() => {
                const name = prompt('Project name', p.name)
                if (name?.trim())
                  void action(`/admin/projects/${p.slug}`, 'PUT', {
                    name: name.trim(),
                  })
              }}
            >
              Rename
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (
                  confirm(
                    `Delete project ${p.name}? Memberships and grants will be removed. Docker containers will keep running.`,
                  )
                )
                  void action(`/admin/projects/${p.slug}`, 'DELETE', undefined)
              }}
            >
              Delete
            </Button>
            <Button asChild>
              <a href={`/projects/${p.slug}/compute/containers`}>
                Open project <Icon name="arrow" />
              </a>
            </Button>
          </div>
        </div>
      ))}
      {data?.length === 0 && (
        <Notice title="No projects yet">
          Create a project to organize your containers.
        </Notice>
      )}
    </>
  )
}
function Connectors({
  revision,
  action,
}: {
  revision: number
  action: Action
}) {
  const { data, error } = usePolling<Connector[]>(
    `/admin/connectors?revision=${revision}`,
  )
  const [pending, setPending] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (data)
      setPending((p) =>
        Object.fromEntries(
          Object.entries(p).filter(
            ([id, value]) => data.find((c) => c.id === id)?.discovery !== value,
          ),
        ),
      )
  }, [data])
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    void action('/admin/connectors', 'POST', {
      name: new FormData(e.currentTarget).get('name'),
    })
  }
  return (
    <>
      <form className="inline-form bg-card border-border" onSubmit={submit}>
        <Label>
          Connector name
          <Input
            name="name"
            placeholder="Production Docker host"
            required
            maxLength={100}
          />
        </Label>
        <Button className="primary">Create connector token</Button>
      </form>
      <p className="helper">
        Install the connector on your Docker host using the token. Discovery
        allows unassigned containers to appear in the admin inventory.
      </p>
      <ErrorMessage message={error} />
      {data?.map((c) => (
        <div className="admin-row bg-card border-border" key={c.id}>
          <div>
            <strong>{c.name}</strong>
            <small>
              {c.host ?? 'Not connected'} ·{' '}
              <StatusBadge>
                {c.revoked
                  ? 'Revoked'
                  : c.stale
                    ? 'Offline / stale'
                    : 'Connected'}
              </StatusBadge>
            </small>
          </div>
          <div className="row-actions">
            <Label className="checkbox">
              <Checkbox
                checked={pending[c.id] ?? c.discovery}
                disabled={c.revoked}
                onCheckedChange={(value) => {
                  const checked = value === true
                  setPending((p) => ({ ...p, [c.id]: checked }))
                  void action(`/admin/connectors/${c.id}`, 'PUT', {
                    discovery: checked,
                    revoked: false,
                  }).then((success) => {
                    if (!success)
                      setPending((p) => {
                        const next = { ...p }
                        delete next[c.id]
                        return next
                      })
                  })
                }}
              />
              Discover unassigned containers
            </Label>
            <Button
              disabled={c.revoked}
              className="danger"
              onClick={() => {
                if (
                  confirm(
                    `Revoke ${c.name}? Its token will stop working permanently.`,
                  )
                )
                  void action(`/admin/connectors/${c.id}`, 'PUT', {
                    discovery: c.discovery,
                    revoked: true,
                  })
              }}
            >
              Revoke token
            </Button>
          </div>
        </div>
      ))}
      {data?.length === 0 && (
        <Notice title="Connect a Docker host">
          Create a token to get started.
        </Notice>
      )}
    </>
  )
}
function Inventory({
  revision,
  action,
  projects,
}: {
  revision: number
  action: Action
  projects: Project[]
}) {
  const assignmentProjects = usePolling<Project[]>('/admin/containers/projects')
  const { data, error } = usePolling<ContainerRow[]>(
    `/admin/containers?revision=${revision}`,
  )
  return (
    <section className="space-y-4" aria-label="Container inventory">
      <h2>Container inventory</h2>
      <p className="text-sm text-muted-foreground">
        Enable discovery on a connector to assign unlabeled containers. Docker
        label assignments take precedence.
      </p>
      <ErrorMessage message={error} />
      {data?.map((c) => (
        <Assignment
          key={`${c.connector_id}:${c.container_id}:${revision}`}
          row={c}
          projects={assignmentProjects.data ?? projects}
          action={action}
        />
      ))}
      {data?.length === 0 && (
        <Notice title="No containers discovered">
          Connect a host and enable discovery, or add project and application
          labels to containers.
        </Notice>
      )}
    </section>
  )
}
function Assignment({
  row,
  projects,
  action,
}: {
  row: ContainerRow
  projects: Project[]
  action: Action
}) {
  const [project, setProject] = useState(row.project ?? ''),
    [application, setApplication] = useState(row.application ?? '')
  const path = `/admin/containers/${row.connector_id}/${row.container_id}`
  return (
    <InventoryCard
      name={row.data.name}
      icon={Container}
      metadata={row.host ?? row.connector_name}
      status={<StatusBadge>{row.stale ? 'Stale' : row.data.state}</StatusBadge>}
      onSubmit={(e) => {
        e.preventDefault()
        void action(path, 'PUT', { project, application })
      }}
    >
      {row.assignment === 'label' ? (
        <div className="min-w-0 text-sm">
          <p className="font-medium">
            {row.project} / {row.application}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Assigned by Docker labels
          </p>
        </div>
      ) : (
        <>
          <Label>
            <span>
              Project<span className="sr-only"> for {row.data.name}</span>
            </span>
            <NativeSelect
              required
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">Select project</option>
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Label>
            <span>
              Application slug
              <span className="sr-only"> for {row.data.name}</span>
            </span>
            <Input
              value={application}
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              maxLength={100}
              onChange={(e) => setApplication(e.target.value)}
              placeholder="Application slug"
            />
          </Label>
          <div className="inventory-card-actions">
            <Button type="submit" disabled={row.stale}>
              Assign
            </Button>
            {row.assignment === 'manual' && (
              <Button
                type="button"
                onClick={() => {
                  void action(path, 'PUT', null)
                }}
              >
                Unassign
              </Button>
            )}
          </div>
        </>
      )}
    </InventoryCard>
  )
}
