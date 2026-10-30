import {
  Button,
  Input,
  NativeSelect,
  Label,
  Checkbox,
} from './components/ui/controls'
import { useEffect, useState, type FormEvent } from 'react'
import { api, type User, type Project, type ContainerRow } from './api'
import { Shell, usePolling, ErrorMessage, Notice } from './components'
type AdminUser = User & {
  disabled: boolean
  enrolled: boolean
  projects: string[]
}
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
    containers: 'Container inventory',
  }
  return (
    <Shell
      user={user}
      projects={projects}
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
              ×
            </Button>
          </div>
        )}
        <fieldset className="admin-controls" disabled={busy}>
          {section === 'projects' ? (
            <Projects revision={revision} action={action} />
          ) : section === 'users' ? (
            <Users
              revision={revision}
              action={action}
              current={user}
              projects={projects}
            />
          ) : section === 'connectors' ? (
            <Connectors revision={revision} action={action} />
          ) : (
            <Inventory
              revision={revision}
              action={action}
              projects={projects}
            />
          )}
        </fieldset>
      </section>
    </Shell>
  )
}
type Action = (path: string, method: string, body: unknown) => Promise<boolean>
function Projects({ revision, action }: { revision: number; action: Action }) {
  const { data, error } = usePolling<Project[]>(
    `/admin/projects?revision=${revision}`,
  )
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    void action('/admin/projects', 'POST', {
      name: form.get('name'),
      slug: form.get('slug'),
    })
  }
  return (
    <>
      <form className="inline-form" onSubmit={submit}>
        <Label>
          Project name
          <Input name="name" required maxLength={100} placeholder="Miki" />
        </Label>
        <Label>
          Project slug
          <Input
            name="slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={100}
            placeholder="miki"
          />
        </Label>
        <Button className="primary">Create project</Button>
      </form>
      <ErrorMessage message={error} />
      {data?.map((p) => (
        <div className="admin-row" key={p.slug}>
          <div>
            <strong>{p.name}</strong>
            <small>{p.slug}</small>
          </div>
          <a className="button" href={`/projects/${p.slug}/compute/containers`}>
            Open project →
          </a>
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
function Users({
  revision,
  action,
  current,
  projects,
}: {
  revision: number
  action: Action
  current: User
  projects: Project[]
}) {
  const { data, error } = usePolling<AdminUser[]>(
    `/admin/users?revision=${revision}`,
  )
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    void action('/admin/users', 'POST', {
      username: form.get('username'),
      admin: form.get('admin') === 'on',
    })
  }
  return (
    <>
      <form className="inline-form" onSubmit={submit}>
        <Label>
          Username
          <Input
            name="username"
            required
            maxLength={100}
            pattern="[a-zA-Z0-9_.@\-]+"
            autoComplete="off"
          />
        </Label>
        <Label className="checkbox">
          <Checkbox name="admin" />
          Super-admin
        </Label>
        <Button className="primary">Invite user</Button>
      </form>
      <ErrorMessage message={error} />
      {data?.map((u) => (
        <UserEditor
          key={`${u.id}:${revision}`}
          user={u}
          current={current}
          projects={projects}
          action={action}
        />
      ))}
    </>
  )
}
function UserEditor({
  user,
  current,
  projects,
  action,
}: {
  user: AdminUser
  current: User
  projects: Project[]
  action: Action
}) {
  const [selected, setSelected] = useState(user.projects),
    [disabled, setDisabled] = useState(user.disabled)
  return (
    <div className="admin-row user-row">
      <div>
        <strong>{user.username}</strong>
        <small>
          {user.admin ? 'Super-admin' : 'Member'} ·{' '}
          {user.enrolled ? 'Enrolled' : 'Enrollment required'}
        </small>
      </div>
      <div className="membership-list">
        {projects.map((p) => (
          <Label className="checkbox" key={p.slug}>
            <Checkbox
              checked={selected.includes(p.slug)}
              onCheckedChange={(checked) =>
                setSelected(
                  checked === true
                    ? [...selected, p.slug]
                    : selected.filter((s) => s !== p.slug),
                )
              }
            />
            {p.name}
          </Label>
        ))}
        {user.admin && <small>Super-admins can access every project.</small>}
      </div>
      <div className="row-actions">
        <Label className="checkbox">
          <Checkbox
            checked={disabled}
            disabled={current.id === user.id}
            onCheckedChange={(checked) => setDisabled(checked === true)}
          />
          Disabled
        </Label>
        <Button
          onClick={() => {
            void action(`/admin/users/${user.id}`, 'PUT', {
              disabled,
              projects: selected,
            })
          }}
        >
          Save access
        </Button>
        {current.id !== user.id && (
          <Button
            onClick={() => {
              if (
                confirm(
                  `Reset ${user.username}'s password and passkey enrollment? Existing sessions will end.`,
                )
              )
                void action(`/admin/users/${user.id}/enrollment`, 'POST', {})
            }}
          >
            Reset enrollment
          </Button>
        )}
      </div>
    </div>
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
      <form className="inline-form" onSubmit={submit}>
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
        <div className="admin-row" key={c.id}>
          <div>
            <strong>{c.name}</strong>
            <small>
              {c.host ?? 'Not connected'} ·{' '}
              {c.revoked
                ? 'Revoked'
                : c.stale
                  ? 'Offline / stale'
                  : 'Connected'}
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
  const { data, error } = usePolling<ContainerRow[]>(
    `/admin/containers?revision=${revision}`,
  )
  return (
    <>
      <p className="helper">
        Enable discovery on a connector to assign unlabeled containers. Docker
        label assignments take precedence.
      </p>
      <ErrorMessage message={error} />
      {data?.map((c) => (
        <Assignment
          key={`${c.connector_id}:${c.container_id}:${revision}`}
          row={c}
          projects={projects}
          action={action}
        />
      ))}
      {data?.length === 0 && (
        <Notice title="No containers discovered">
          Connect a host and enable discovery, or add project and application
          labels to containers.
        </Notice>
      )}
    </>
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
    <form
      className="admin-row assignment-row"
      onSubmit={(e) => {
        e.preventDefault()
        void action(path, 'PUT', { project, application })
      }}
    >
      <div>
        <strong>{row.data.name}</strong>
        <small>
          {row.host ?? row.connector_name} ·{' '}
          {row.stale ? 'Stale' : row.data.state}
        </small>
      </div>
      {row.assignment === 'label' ? (
        <span className="label-assignment">
          {row.project} / {row.application}
          <small>Assigned by Docker labels</small>
        </span>
      ) : (
        <>
          <Label>
            <span className="sr-only">Project for {row.data.name}</span>
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
            <span className="sr-only">
              Application slug for {row.data.name}
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
          <Button disabled={row.stale}>Assign</Button>
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
        </>
      )}
    </form>
  )
}
