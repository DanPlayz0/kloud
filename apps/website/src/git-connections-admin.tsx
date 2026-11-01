import { useState, type FormEvent } from 'react'
import { GitBranch, Pencil, Trash2 } from 'lucide-react'
import { api, hasServer, type Project, type User } from './api'
import { ErrorMessage, usePolling } from './components'
import { GithubAppConnect } from './github-app-connect'
import { Button, Checkbox, Input, NativeSelect } from './components/ui/controls'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from './components/ui/card'
import {
  Field,
  FieldLabel,
  FieldSet,
  FieldDescription,
} from './components/ui/field'
import { Form } from './components/ui/form'
import { Badge } from './components/ui/badge'
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from './components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from './components/ui/dialog'
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from './components/ui/empty'

interface Connection {
  id: string
  project: string
  project_name: string
  name: string
  provider: string
  origin: string
  owner: string | null
  owner_name: string | null
  identity: { account?: string; installation_id?: number }
  project_access: boolean
  revoked: boolean
  bindings: number
}

export function GitConnectionsAdmin({ user }: { user: User }) {
  const [revision, setRevision] = useState(0)
  const [selectedProject, setSelectedProject] = useState('')
  const [method, setMethod] = useState('app')
  const [projectAccess, setProjectAccess] = useState(true)
  const { data: projects, error: projectsError } = usePolling<Project[]>(
    '/admin/git-connections/projects',
  )
  const { data: connections, error } = usePolling<Connection[]>(
    '/admin/git-connections',
    revision,
  )
  const project = selectedProject || projects?.[0]?.slug || ''
  const refresh = async () => {
    setRevision((n) => n + 1)
  }
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Prepare repository connections before creating services. Repositories
        and branches are selected in each service’s Source setup. Control who
        can create connections under Administration / Users.
      </p>
      <ErrorMessage message={error || projectsError} />
      {hasServer(user, 'git.create') ? (
        <Card className="flex min-w-0 flex-col gap-4">
          <CardHeader>
            <CardTitle>Create a connection</CardTitle>
            <CardDescription>
              Shared connections belong to a project and keep credentials
              encrypted on the server.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Project</FieldLabel>
              <NativeSelect
                value={project}
                onChange={(e) => setSelectedProject(e.target.value)}
              >
                {!projects?.length && (
                  <option value="">No projects available</option>
                )}
                {projects?.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel>Connection type</FieldLabel>
              <NativeSelect
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="app">GitHub App</option>
                <option value="github">GitHub personal access token</option>
                <option value="forgejo">Forgejo access token</option>
                <option value="gitea">Gitea access token</option>
              </NativeSelect>
            </Field>
            <ProjectAccess
              checked={projectAccess}
              onChange={setProjectAccess}
            />
            {project &&
              (method === 'app' ? (
                <GithubAppConnect
                  key={project}
                  project={project}
                  administration
                  projectAccess={projectAccess}
                  onConnected={refresh}
                />
              ) : (
                <TokenConnection
                  key={`${project}:${method}`}
                  project={project}
                  provider={method}
                  projectAccess={projectAccess}
                  onConnected={refresh}
                />
              ))}
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Create Git connections permission is required to add a connection.
        </p>
      )}
      <Card className="flex min-w-0 flex-col gap-4">
        <CardHeader>
          <CardTitle>Saved connections</CardTitle>
          <CardDescription>
            Manage names, project availability, and revocation. Credentials are
            never displayed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!connections ? (
            <p role="status">Loading connections…</p>
          ) : !connections.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <GitBranch />
                </EmptyMedia>
                <EmptyTitle>No Git connections</EmptyTitle>
                <EmptyDescription>
                  Create a connection above to make it available during service
                  setup.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Connection</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.map((connection) => (
                  <TableRow key={connection.id}>
                    <TableCell>
                      <p className="font-medium">{connection.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {connection.identity.account || connection.origin} ·{' '}
                        {connection.provider === 'github_app'
                          ? 'GitHub App'
                          : connection.provider}
                      </p>
                    </TableCell>
                    <TableCell>{connection.project_name}</TableCell>
                    <TableCell>
                      {connection.owner
                        ? `Personal · ${connection.owner_name ?? 'Unknown owner'}`
                        : connection.project_access
                          ? 'Project deployers'
                          : 'Delegated services only'}
                      <p className="text-xs text-muted-foreground">
                        {connection.bindings} repository bindings
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={connection.revoked ? 'secondary' : 'outline'}
                      >
                        {connection.revoked ? 'Revoked' : 'Active'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ConnectionEditor
                        connection={connection}
                        onSaved={refresh}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ProjectAccess({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <Field>
      <Field orientation="horizontal">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
        />
        <FieldLabel>Available to project deployers</FieldLabel>
      </Field>
      <FieldDescription>
        Users with deployment permission can browse and select any repository
        authorized by this shared connection. Turn this off to require explicit
        service delegation. Existing repository bindings remain valid.
      </FieldDescription>
    </Field>
  )
}

function TokenConnection({
  project,
  provider,
  projectAccess,
  onConnected,
}: {
  project: string
  provider: string
  projectAccess: boolean
  onConnected: () => Promise<void>
}) {
  const [name, setName] = useState(''),
    [token, setToken] = useState(''),
    [origin, setOrigin] = useState(''),
    [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api(`/projects/${project}/git-connections`, 'POST', {
        name,
        provider,
        token,
        scope: 'shared',
        project_access: projectAccess,
        ...(provider !== 'github' ? { origin, username } : {}),
      })
      setName('')
      setToken('')
      await onConnected()
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to save connection',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Form onSubmit={submit}>
      <FieldSet disabled={busy}>
        <Field>
          <FieldLabel>Connection name</FieldLabel>
          <Input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {provider !== 'github' && (
          <>
            <Field>
              <FieldLabel>Provider HTTPS origin</FieldLabel>
              <Input
                required
                type="url"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
              />
              <FieldDescription>
                The origin must be authorized in GIT_PROVIDER_ORIGINS.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Token owner username</FieldLabel>
              <Input
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
          </>
        )}
        <Field>
          <FieldLabel>Personal access token</FieldLabel>
          <Input
            required
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <ErrorMessage message={error} />
        <Button type="submit">{busy ? 'Saving…' : 'Save connection'}</Button>
      </FieldSet>
    </Form>
  )
}

function ConnectionEditor({
  connection,
  onSaved,
}: {
  connection: Connection
  onSaved: () => Promise<void>
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(connection.name),
    [access, setAccess] = useState(connection.project_access)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function save(revoke = false) {
    setBusy(true)
    setError('')
    try {
      await api(
        `/admin/git-connections/${connection.id}`,
        'PUT',
        revoke ? { revoked: true } : { name, project_access: access },
      )
      await onSaved()
      setOpen(false)
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to update connection',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setName(connection.name)
        setAccess(connection.project_access)
        setError('')
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" aria-label={`Manage ${connection.name}`}>
          <Pencil data-icon="inline-start" />
          Manage
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Manage {connection.name}</DialogTitle>
        <DialogDescription>
          {connection.project_name}. Revoking a connection blocks future builds
          that use it.
        </DialogDescription>
        <Form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <FieldSet disabled={busy || connection.revoked}>
            <Field>
              <FieldLabel>Connection name</FieldLabel>
              <Input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            {!connection.owner && (
              <ProjectAccess checked={access} onChange={setAccess} />
            )}
            <ErrorMessage message={error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit">Save changes</Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  if (
                    window.confirm(
                      `Revoke ${connection.name}? Future builds using this connection will be blocked.`,
                    )
                  )
                    void save(true)
                }}
              >
                <Trash2 data-icon="inline-start" />
                Revoke connection
              </Button>
            </div>
          </FieldSet>
        </Form>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Close
        </Button>
      </DialogContent>
    </Dialog>
  )
}
