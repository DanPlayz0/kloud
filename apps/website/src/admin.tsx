import { Link, useRouter } from '@tanstack/react-router'
import { X, ArrowRight } from 'lucide-react'
import { FieldSet, Field, FieldLabel } from '@/components/ui/field'
import {
  Card,
  FormCard,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
  CardContent,
} from './components/ui/card'
import { StatusBadge } from './components/ui/status-badge'
import { Container } from 'lucide-react'
import { Alert, AlertDescription } from './components/ui/alert'
import { ConnectorControls } from './components/connector-controls'
import { ConnectorToken } from './components/connector-token'
import { InventoryCard } from './components/inventory-card'
import { ProjectFields, projectFormValues } from './components/project-fields'
import { Button, Input, NativeSelect } from './components/ui/controls'
import { useEffect, useState, type FormEvent } from 'react'
import {
  api,
  hasServer,
  type User,
  type Project,
  type ContainerRow,
  type Connector,
} from './api'
import { usePolling, ErrorMessage, Notice, Icon } from './components'
import { Users } from './components/users'
import { DnsProviders } from './dns'
import { Pm2Inventory } from './pm2'
import { GitConnectionsAdmin } from './git-connections-admin'
export function Admin({
  user,
  projects,
  section,
}: {
  user: User
  projects: Project[]
  section: string
}) {
  const router = useRouter()
  const [revision, setRevision] = useState(0),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [projectList, setProjectList] = useState(projects)
  const [connectorToken, setConnectorToken] = useState<{
    id: string
    token: string
    rotated: boolean
  }>()
  useEffect(() => setProjectList(projects), [projects])
  async function action(path: string, method: string, body: unknown) {
    setError('')
    setMessage('')
    setBusy(true)
    try {
      const result = await api<{
        id?: string
        enrollmentUrl?: string
        token?: string
      }>(path, method, body)
      if (result.token && result.id)
        setConnectorToken({
          id: result.id,
          token: result.token,
          rotated: path.endsWith('/rotate'),
        })
      if (method === 'PUT' && (body as { revoked?: boolean })?.revoked)
        setConnectorToken((current) =>
          path === '/admin/connectors/' + current?.id ? undefined : current,
        )
      setMessage(
        result.enrollmentUrl
          ? `Enrollment link (valid for 24 hours): ${result.enrollmentUrl}`
          : result.token
            ? ''
            : 'Changes saved.',
      )
      setRevision((n) => n + 1)
      if (path.startsWith('/admin/projects')) {
        // Keep the sidebar in sync without losing a successful mutation's result.
        void api<Project[]>('/projects')
          .then(setProjectList)
          .catch(() => {})
        void router.invalidate()
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
    'git-connections': 'Git connections',
    projects: 'Projects',
    users: 'Users',
    connectors: 'Connectors',
    containers: 'Runtime inventory',
    dns: 'DNS providers',
  }
  return (
    <>
      <section className="admin-content">
        <div className="page-heading">
          <div>
            <p className="eyebrow">ADMINISTRATION</p>
            <h1>{titles[section]}</h1>
          </div>
        </div>
        <ErrorMessage message={error} />
        {message && (
          <Alert role="status" className="mb-5 grid-cols-[1fr_auto]">
            <AlertDescription className="col-start-1">
              {message}
            </AlertDescription>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMessage('')}
              aria-label="Dismiss"
            >
              <Icon data-icon="inline-start" icon={X} />
            </Button>
          </Alert>
        )}
        <FieldSet className="admin-controls" disabled={busy}>
          {section === 'git-connections' ? (
            <GitConnectionsAdmin user={user} />
          ) : section === 'dns' ? (
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
            <Connectors
              revision={revision}
              action={action}
              revealedToken={connectorToken}
              onDismissToken={() => setConnectorToken(undefined)}
            />
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
        </FieldSet>
      </section>
    </>
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
        <FormCard onSubmit={submit}>
          <ProjectFields />
          <Button variant="primary">Create project</Button>
        </FormCard>
      )}
      <ErrorMessage message={error} />
      {data?.map((p) => (
        <Card className="admin-row" key={p.slug}>
          <div>
            <strong>{p.name}</strong>
            <small>{p.slug}</small>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link
                to="/projects/$projectSlug/access"
                params={{ projectSlug: p.slug }}
              >
                Manage access
              </Link>
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
              <Link
                to="/projects/$projectSlug/compute/containers"
                params={{ projectSlug: p.slug }}
              >
                Open project <Icon data-icon="inline-start" icon={ArrowRight} />
              </Link>
            </Button>
          </div>
        </Card>
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
  revealedToken,
  onDismissToken,
}: {
  revision: number
  action: Action
  revealedToken?: { id: string; token: string; rotated: boolean }
  onDismissToken: () => void
}) {
  const { data, error } = usePolling<Connector[]>('/admin/connectors', revision)
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const filtered = data?.filter((connector) =>
    [connector.name, connector.host ?? ''].some((value) =>
      value.toLowerCase().includes(query),
    ),
  )
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    void action('/admin/connectors', 'POST', {
      name: new FormData(e.currentTarget).get('name'),
    }).then((saved) => {
      if (saved) setSearch('')
    })
  }
  return (
    <>
      <FormCard onSubmit={submit}>
        <Field>
          <FieldLabel>Connector name</FieldLabel>
          <Input
            name="name"
            placeholder="Production Docker host"
            required
            maxLength={100}
          />
        </Field>
        <Button variant="primary">Create connector token</Button>
      </FormCard>
      <p className="helper">
        Install the connector on your Docker host using the token. Discovery
        allows unassigned containers to appear in the admin inventory.
      </p>
      <ErrorMessage message={error} />
      <Field className="mb-4">
        <FieldLabel>Search connectors</FieldLabel>
        <Input
          type="search"
          placeholder="Search by name or host"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </Field>
      {filtered?.map((c) => (
        <Card className="admin-row" key={c.id}>
          <CardHeader>
            <CardTitle asChild>
              <strong>{c.name}</strong>
            </CardTitle>
            <CardDescription>
              {c.host ?? 'Not connected'} ·{' '}
              <StatusBadge>
                {c.revoked
                  ? 'Revoked'
                  : c.stale
                    ? 'Offline / stale'
                    : 'Connected'}
              </StatusBadge>
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <ConnectorControls connector={c} action={action} showOpen />
          </CardFooter>
          {revealedToken?.id === c.id && (
            <CardContent className="basis-full">
              <ConnectorToken
                key={revealedToken.token}
                token={revealedToken.token}
                rotated={revealedToken.rotated}
                onDismiss={onDismissToken}
              />
            </CardContent>
          )}
        </Card>
      ))}
      {data?.length === 0 && (
        <Notice title="Connect a Docker host">
          Create a token to get started.
        </Notice>
      )}
      {!!data?.length && filtered?.length === 0 && (
        <Notice title="No matching connectors">
          Try a different name or host.
          <Button type="button" variant="ghost" onClick={() => setSearch('')}>
            Clear search
          </Button>
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
    <section className="flex flex-col gap-4" aria-label="Container inventory">
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
          <Field>
            <FieldLabel>
              <span>
                Project<span className="sr-only"> for {row.data.name}</span>
              </span>
            </FieldLabel>
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
          </Field>
          <Field>
            <FieldLabel>
              <span>
                Application slug
                <span className="sr-only"> for {row.data.name}</span>
              </span>
            </FieldLabel>
            <Input
              value={application}
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              maxLength={100}
              onChange={(e) => setApplication(e.target.value)}
              placeholder="Application slug"
            />
          </Field>
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
