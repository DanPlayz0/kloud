import { useState, type FormEvent } from 'react'
import {
  api,
  containerCapabilities,
  type Grant,
  type ProjectAccess,
  type ProjectMember,
  type ContainerRow,
  type User,
  type Project,
} from './api'
import { Shell, usePolling, ErrorMessage } from './components'
import {
  Button,
  Input,
  Label,
  NativeSelect,
  Checkbox,
} from './components/ui/controls'

export function ProjectAccessPage({
  user,
  projects,
  project,
}: {
  user: User
  projects: Project[]
  project: string
}) {
  const [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const base = `/projects/${project}/access`
  const { data, error: loadError } = usePolling<ProjectAccess>(
    `${base}?revision=${revision}`,
  )
  const inventory = usePolling<ContainerRow[]>(
    `/projects/${project}/containers`,
  )
  async function action(path: string, method: string, body?: unknown) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await api<{ enrollmentUrl?: string }>(path, method, body)
      setMessage(
        result.enrollmentUrl
          ? `Enrollment link (valid for 24 hours): ${result.enrollmentUrl}`
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
  return (
    <Shell
      user={user}
      projects={projects}
      project={project}
      active="access"
      title="Project / Access"
    >
      <section className="admin-content space-y-6">
        <div className="page-heading">
          <h1>Project access</h1>
        </div>
        <ErrorMessage message={error || loadError || inventory.error} />
        {message && (
          <p className="success break-all" role="status">
            {message}
          </p>
        )}
        {data && (
          <fieldset disabled={busy} className="space-y-6 min-w-0">
            <form
              key={`settings:${revision}`}
              className="inline-form bg-card border-border"
              onSubmit={(e) => {
                e.preventDefault()
                void action(`${base}/settings`, 'PUT', {
                  grant_mode: new FormData(e.currentTarget).get('grant_mode'),
                })
              }}
            >
              <Label>
                Default matching mode
                <NativeSelect
                  aria-label="Default matching mode"
                  name="grant_mode"
                  defaultValue={data.grant_mode}
                >
                  <option value="id">Container IDs</option>
                  <option value="name">Exact container names</option>
                </NativeSelect>
              </Label>
              <Button>Save default</Button>
              <p className="text-muted-foreground text-sm">
                Existing grants stay unchanged. Names follow recreated
                containers on the same connector in this project.
              </p>
            </form>
            <h2>Invite or add a member</h2>
            <MemberEditor
              key={`invite:${revision}`}
              mode={data.grant_mode}
              containers={inventory.data ?? []}
              onSave={(body) => action(`${base}/members`, 'POST', body)}
            />
            <h2>Members</h2>
            <p className="text-muted-foreground text-sm">
              Project Administrators manage access and see every container.
              Members see only containers with View grants. Other capabilities
              are planned and unavailable today, and include View for the same
              target.
            </p>
            {data.members.map((member) => (
              <MemberEditor
                key={`${member.id}:${revision}`}
                member={member}
                mode={data.grant_mode}
                containers={inventory.data ?? []}
                onSave={(body) =>
                  action(`${base}/members/${member.id}`, 'PUT', body)
                }
                onRemove={() => {
                  if (confirm(`Remove ${member.username} from this project?`))
                    void action(`${base}/members/${member.id}`, 'DELETE')
                }}
              />
            ))}
            {!data.members.length && (
              <p className="text-muted-foreground">No project members yet.</p>
            )}
          </fieldset>
        )}
      </section>
    </Shell>
  )
}

function MemberEditor({
  member,
  mode,
  containers,
  onSave,
  onRemove,
}: {
  member?: ProjectMember
  mode: 'id' | 'name'
  containers: ContainerRow[]
  onSave: (body: unknown) => Promise<boolean>
  onRemove?: () => void
}) {
  const [role, setRole] = useState(member?.role ?? 'member')
  const [grants, setGrants] = useState<Grant[]>(member?.grants ?? [])
  const [kind, setKind] = useState<Grant['kind']>(mode)
  const [selected, setSelected] = useState('')
  const [capabilities, setCapabilities] = useState<Grant['capability'][]>([
    'view',
  ])
  function addGrant() {
    const row = containers.find(
      (c) => `${c.connector_id}:${c.container_id}` === selected,
    )
    if (kind !== 'all' && !row) return
    const next = [
      ...new Set([
        ...capabilities,
        ...(capabilities.length ? ['view' as const] : []),
      ]),
    ].map((capability) => ({
      capability,
      kind,
      connector_id: kind === 'all' ? null : row!.connector_id,
      target:
        kind === 'all'
          ? null
          : kind === 'id'
            ? row!.container_id
            : row!.data.name,
    }))
    setGrants((old) => [
      ...old,
      ...next.filter(
        (g) => !old.some((o) => JSON.stringify(o) === JSON.stringify(g)),
      ),
    ])
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = {
      role,
      grants,
      ...(!member
        ? { username: new FormData(e.currentTarget).get('username') }
        : {}),
    }
    void onSave(body)
  }
  return (
    <form
      className="bg-card border border-border rounded-lg p-4 space-y-4 min-w-0"
      onSubmit={submit}
    >
      <div className="flex flex-wrap items-end gap-4">
        {member ? (
          <strong className="break-all">
            {member.username}
            {member.disabled && ' (disabled)'}
          </strong>
        ) : (
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
        )}
        <Label>
          Project role
          <NativeSelect
            aria-label="Project role"
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            <option value="member">Project Member</option>
            <option value="admin">Project Administrator</option>
          </NativeSelect>
        </Label>
      </div>
      {role === 'admin' && (
        <p className="text-muted-foreground text-sm">
          This role grants all project container capabilities and access
          management. Saved member grants are retained.
        </p>
      )}
      <div className="space-y-2">
        <h3>Container grants</h3>
        {grants.map((g, index) => (
          <div
            key={index}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <span className="break-all">
              {g.capability}
              {g.capability !== 'view' && ' (planned)'} ·{' '}
              {g.kind === 'all'
                ? 'All containers in this project'
                : `${g.kind}: ${g.target} · ${containers.find((c) => c.connector_id === g.connector_id)?.connector_name ?? g.connector_id}`}
            </span>
            <Button
              type="button"
              aria-label={`Remove ${g.capability} grant ${index + 1}`}
              onClick={() =>
                setGrants((old) =>
                  old.filter(
                    (_, i) =>
                      i !== index &&
                      !(
                        g.capability === 'view' &&
                        old[i]?.kind === g.kind &&
                        old[i]?.connector_id === g.connector_id &&
                        old[i]?.target === g.target
                      ),
                  ),
                )
              }
            >
              Remove
            </Button>
          </div>
        ))}
        {!grants.length && (
          <p className="text-muted-foreground text-sm">
            {role === 'admin'
              ? 'No member grants. The administrator role provides project-wide access.'
              : 'No grants. Project Members cannot view containers until granted access.'}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-4 items-end">
        <Label>
          Grant target
          <NativeSelect
            aria-label="Grant target"
            value={kind}
            onChange={(e) => setKind(e.target.value as Grant['kind'])}
          >
            <option value="all">All containers in this project</option>
            <option value="id">Container ID</option>
            <option value="name">Exact container name</option>
          </NativeSelect>
        </Label>
        {kind !== 'all' && (
          <Label>
            Container
            <NativeSelect
              aria-label="Container"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Select container</option>
              {containers.map((c) => (
                <option
                  key={`${c.connector_id}:${c.container_id}`}
                  value={`${c.connector_id}:${c.container_id}`}
                >
                  {c.data.name} ({c.connector_name})
                </option>
              ))}
            </NativeSelect>
          </Label>
        )}
        <Button
          type="button"
          onClick={addGrant}
          disabled={!capabilities.length || (kind !== 'all' && !selected)}
        >
          Add grant
        </Button>
      </div>
      <div className="flex flex-wrap gap-4">
        {containerCapabilities.map((capability) => (
          <Label key={capability} className="checkbox">
            <Checkbox
              checked={capabilities.includes(capability)}
              onCheckedChange={(checked) =>
                setCapabilities((old) =>
                  checked
                    ? [...old, capability]
                    : old.filter((c) => c !== capability),
                )
              }
            />
            {capability === 'view' ? 'View' : `${capability} (planned)`}
          </Label>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary">
          {member ? 'Save member access' : 'Invite or add member'}
        </Button>
        {onRemove && (
          <Button type="button" variant="destructive" onClick={onRemove}>
            Remove member
          </Button>
        )}
      </div>
    </form>
  )
}
