import { useConfirmation } from './components/ui/confirmation-dialog'
import { CollapsibleSection } from './components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { FieldGroup, Field, FieldLabel } from '@/components/ui/field'
import { useEffect, useState, useRef } from 'react'
import type { DeploymentConfig } from '@kloud/protocol'
import { api, hasServer, type User } from './api'
import { ErrorMessage } from './components'
import { Button, Input, NativeSelect, Textarea } from './components/ui/controls'
import { Card } from './components/ui/card'
import { GithubAppConnect } from './github-app-connect'

interface Connection {
  id: string
  name: string
  provider: string
  origin: string
  owner: string | null
  identity: { account?: string; installation_id?: number }
}
interface Repository {
  id: string
  name: string
  url: string
  default_branch: string
  private: boolean
}
interface Inspection {
  evidence: string[]
  warnings: string[]
  dockerfile: string | null
  committed: boolean
  message: string
}
export function RepositoryOnboarding({
  project,
  service,
  value,
  onChange,
}: {
  project: string
  service: string
  value: DeploymentConfig
  onChange: (value: DeploymentConfig) => void
}) {
  const { confirm, confirmationDialog } = useConfirmation()
  const base = `/projects/${project}/git-connections`
  const [connections, setConnections] = useState<Connection[]>([])
  const [user, setUser] = useState<User>()
  const canCreate = !!user && hasServer(user, 'git.create')
  const [mode, setMode] = useState<'app' | 'pat' | 'selfhost' | 'legacy'>('app')
  const [connection, setConnection] = useState(value.connection_id ?? '')
  const [delegations, setDelegations] = useState(value.repository)
  useEffect(
    () =>
      setDelegations(
        value.connection_id === connection ? value.repository : '',
      ),
    [connection],
  )
  const [url, setUrl] = useState(
    value.repository
      ? `${value.provider_url ?? 'https://github.com'}/${value.repository}`
      : '',
  )
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [branches, setBranches] = useState<{ name: string; commit: string }[]>(
    [],
  )
  const [page, setPage] = useState(1),
    [nextPage, setNextPage] = useState<number | null>(null),
    [branchPage, setBranchPage] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false),
    [provider, setProvider] = useState('github')
  const [hook, setHook] = useState<{
    mode: string
    url: string
    message: string | null
    instructions: string
  } | null>(null)
  const [inspection, setInspection] = useState<Inspection | null>(null),
    [suggestion, setSuggestion] = useState('')
  const selected = connections.find((item) => item.id === connection)
  const available = connections.filter((item) =>
    mode === 'app'
      ? item.provider === 'github_app'
      : mode === 'pat'
        ? item.provider === 'github'
        : ['forgejo', 'gitea'].includes(item.provider),
  )
  const initialized = useRef(false)
  async function refresh() {
    const values = await api<Connection[]>(
      `${base}?service=${encodeURIComponent(service)}`,
    )
    setConnections(values)
    if (!initialized.current) {
      initialized.current = true
      const current = values.find((item) => item.id === value.connection_id)
      if (current)
        setMode(
          current.provider === 'github_app'
            ? 'app'
            : current.provider === 'github'
              ? 'pat'
              : 'selfhost',
        )
    }
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message))
    void api<User>('/auth/me')
      .then(setUser)
      .catch((e) => setError(e.message))
  }, [project, service])
  useEffect(() => {
    if (value.connection_id && value.connection_id !== connection) {
      setConnection(value.connection_id)
      const current = connections.find(
        (item) => item.id === value.connection_id,
      )
      if (current)
        setMode(
          current.provider === 'github_app'
            ? 'app'
            : current.provider === 'github'
              ? 'pat'
              : 'selfhost',
        )
    }
  }, [value.connection_id])
  useEffect(() => {
    setRepositories([])
    setBranches([])
    setPage(1)
    setNextPage(null)
    setInspection(null)
  }, [connection, mode])
  async function run(action: () => Promise<void>) {
    setError('')
    setBusy(true)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Repository operation failed')
    } finally {
      setBusy(false)
    }
  }
  async function select(repo: Repository) {
    const current = connections.find((item) => item.id === connection)
    if (!current) throw new Error('Select a connection first.')
    onChange({
      ...value,
      connection_id: current.id,
      repository_id: repo.id,
      provider_url: current.origin,
      repository: repo.name,
      branch: repo.default_branch,
    })
    setUrl(repo.url)
    const data = await api<{
      branches: { name: string; commit: string }[]
      next_page: number | null
    }>(
      `${base}/${current.id}/branches?service=${encodeURIComponent(service)}&repository=${encodeURIComponent(repo.name)}`,
    )
    setBranches(data.branches)
    setBranchPage(data.next_page)
  }
  return (
    <Card size="compact" className="flex min-w-0 flex-col gap-4">
      {confirmationDialog}
      <CardHeader>
        <CardTitle asChild>
          <h3 className="font-semibold">Connect repository</h3>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Field>
          <FieldLabel>Setup method</FieldLabel>
          <NativeSelect
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as typeof mode)
              setConnection('')
              setAdding(false)
              setError('')
              onChange({
                ...value,
                repository: '',
                connection_id: undefined,
                repository_id: undefined,
                provider_url: undefined,
              })
            }}
          >
            <option value="app">GitHub App installation</option>
            <option value="pat">Repository URL + personal access token</option>
            <option value="selfhost">Forgejo / Gitea access token</option>
            <option value="legacy">Existing manual GitHub configuration</option>
          </NativeSelect>
        </Field>
        <ErrorMessage message={error} />
        {mode === 'legacy' ? (
          <>
            <p className="text-xs text-muted-foreground">
              Compatibility mode uses the connector’s existing source
              credential. New connections should use a guided setup method.
            </p>
            <Field>
              <FieldLabel>GitHub repository (owner/repo)</FieldLabel>
              <Input
                required
                value={value.repository}
                onChange={(e) =>
                  onChange({
                    ...value,
                    repository: e.target.value,
                    connection_id: undefined,
                    repository_id: undefined,
                    provider_url: undefined,
                  })
                }
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              New or changed legacy repositories require an organization
              administrator. Existing approved repository/host pairs remain
              usable by app deployers. Selecting a scoped connection retires
              this app’s legacy source grants.
            </p>
            <Button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: 'Revoke legacy authorization?',
                    description:
                      'Queued builds using this repository and host authorization will be blocked. Organization administrator permission is required.',
                    actionLabel: 'Revoke authorization',
                    variant: 'destructive',
                  })
                )
                  void run(async () => {
                    await api(`${base}/legacy/authorization`, 'DELETE', {
                      service,
                      repository: value.repository,
                      connector_id: value.connector_id,
                    })
                  })
              }}
            >
              Revoke legacy repository authorization
            </Button>
          </>
        ) : (
          <>
            <Field>
              <FieldLabel>
                {mode === 'app' ? 'Installation / account' : 'Saved connection'}
              </FieldLabel>
              <NativeSelect
                value={connection}
                onChange={(e) => {
                  setConnection(e.target.value)
                  onChange({
                    ...value,
                    repository: '',
                    connection_id: undefined,
                    repository_id: undefined,
                    provider_url: undefined,
                  })
                }}
              >
                <option value="">Select a connection</option>
                {available.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.identity.account
                      ? ` · ${item.identity.account} · installation ${item.identity.installation_id}`
                      : ` · ${item.origin}`}
                    {item.owner
                      ? ' · personal, reusable'
                      : ' · shared across authorized teams'}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {!available.length && (
              <p className="text-xs text-muted-foreground">
                No authorized connections are available. Ask an administrator to
                make a saved shared connection available to this project’s team,
                or delegate a repository to this service. The same connection
                can be reused across multiple projects.
              </p>
            )}
            {canCreate ? (
              <Button
                type="button"
                onClick={async () => {
                  setAdding(!adding)
                  setProvider(
                    mode === 'app'
                      ? 'github_app'
                      : mode === 'selfhost'
                        ? 'forgejo'
                        : 'github',
                  )
                }}
              >
                {adding ? 'Cancel new connection' : 'Add connection'}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Select a prepared connection. Ask an administrator to grant
                Create Git connections permission if you need to add one.
              </p>
            )}
            {canCreate && adding && mode === 'app' && (
              <GithubAppConnect
                project={project}
                service={service}
                allowShared={!!user && hasServer(user, 'git.manage')}
                onConnected={async (id) => {
                  await refresh()
                  setConnection(id)
                  setAdding(false)
                }}
              />
            )}
            {canCreate && adding && mode !== 'app' && (
              <FieldGroup className="flex flex-col gap-3 border border-border rounded-md p-3">
                <Field>
                  <FieldLabel>Connection name</FieldLabel>
                  <Input name="git-name" data-git-new="name" />
                </Field>
                {mode === 'selfhost' && (
                  <Field>
                    <FieldLabel>Provider</FieldLabel>
                    <NativeSelect
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                    >
                      <option value="forgejo">Forgejo</option>
                      <option value="gitea">Gitea</option>
                    </NativeSelect>
                  </Field>
                )}
                {mode === 'selfhost' && (
                  <>
                    <Field>
                      <FieldLabel>Provider HTTPS origin</FieldLabel>
                      <Input
                        data-git-new="origin"
                        placeholder="https://git.example.com"
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Token owner username</FieldLabel>
                      <Input data-git-new="username" autoComplete="username" />
                    </Field>
                    <p className="text-xs text-muted-foreground">
                      An administrator must authorize this origin in
                      GIT_PROVIDER_ORIGINS. Provider capabilities depend on the
                      installed version.
                    </p>
                  </>
                )}
                <Field>
                  <FieldLabel>Personal access token</FieldLabel>
                  <Input
                    data-git-new="token"
                    type="password"
                    autoComplete="new-password"
                  />
                </Field>
                <Field>
                  <FieldLabel>Ownership</FieldLabel>
                  <NativeSelect data-git-new="scope">
                    <option value="personal">Personal</option>
                    {!!user && hasServer(user, 'git.manage') && (
                      <option value="shared">Shared</option>
                    )}
                  </NativeSelect>
                </Field>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={(e) => {
                    const container = e.currentTarget.parentElement!
                    const read = (key: string) =>
                      (
                        container.querySelector(`[data-git-new="${key}"]`) as
                          | HTMLInputElement
                          | HTMLTextAreaElement
                          | HTMLSelectElement
                          | null
                      )?.value
                    void run(async () => {
                      const result = await api<{ id: string }>(base, 'POST', {
                        name: read('name'),
                        provider,
                        service,
                        scope: read('scope'),
                        token: read('token'),
                        ...(mode === 'selfhost'
                          ? {
                              origin: read('origin'),
                              username: read('username'),
                            }
                          : {}),
                      })
                      container
                        .querySelectorAll<
                          HTMLInputElement | HTMLTextAreaElement
                        >('[data-git-new="token"],[data-git-new="private_key"]')
                        .forEach((input) => {
                          input.value = ''
                        })
                      await refresh()
                      setConnection(result.id)
                      setAdding(false)
                    })
                  }}
                >
                  Save encrypted connection
                </Button>
              </FieldGroup>
            )}
            {connection && mode === 'app' && (
              <>
                <Field>
                  <FieldLabel>Search repositories</FieldLabel>
                  <Input
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value)
                      setPage(1)
                    }}
                  />
                </Field>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const data = await api<{
                        repositories: Repository[]
                        next_page: number | null
                      }>(
                        `${base}/${connection}/repositories?service=${encodeURIComponent(service)}&page=${page}&q=${encodeURIComponent(search)}`,
                      )
                      setRepositories(data.repositories)
                      setNextPage(data.next_page)
                    })
                  }
                >
                  Load repositories
                </Button>
                <Field>
                  <FieldLabel>Repository</FieldLabel>
                  <NativeSelect
                    value={
                      value.connection_id === connection
                        ? (value.repository_id ?? '')
                        : ''
                    }
                    onChange={(e) => {
                      const repo = repositories.find(
                        (item) => item.id === e.target.value,
                      )
                      if (repo) void run(() => select(repo))
                    }}
                  >
                    <option value="">Select a repository</option>
                    {repositories.map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.name}
                        {repo.private ? ' · private' : ''}
                      </option>
                    ))}
                    {value.connection_id === connection &&
                      value.repository_id &&
                      !repositories.some(
                        (repo) => repo.id === value.repository_id,
                      ) && (
                        <option value={value.repository_id}>
                          {value.repository}
                        </option>
                      )}
                  </NativeSelect>
                </Field>
                {nextPage && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const data = await api<{
                          repositories: Repository[]
                          next_page: number | null
                        }>(
                          `${base}/${connection}/repositories?service=${encodeURIComponent(service)}&page=${nextPage}&q=${encodeURIComponent(search)}`,
                        )
                        setPage(nextPage)
                        setRepositories(data.repositories)
                        setNextPage(data.next_page)
                      })
                    }
                  >
                    Next repository page
                  </Button>
                )}
                {!repositories.length && !busy && (
                  <p className="text-xs text-muted-foreground">
                    Load a page to select repositories. Empty results may mean
                    access was removed, no repositories were delegated, or
                    matches are on another page.
                  </p>
                )}
              </>
            )}
            {connection && mode !== 'app' && (
              <>
                <Field>
                  <FieldLabel>Repository HTTPS URL</FieldLabel>
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder={`${selected?.origin ?? 'https://github.com'}/owner/repository`}
                  />
                </Field>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      select(
                        await api<Repository>(
                          `${base}/${connection}/repository`,
                          'POST',
                          { service, url },
                        ),
                      ),
                    )
                  }
                >
                  Validate repository access and load branches
                </Button>
                <p className="text-xs text-muted-foreground">
                  This checks the repository directly; GitHub App installation
                  and repository-listing permission are not required.
                  Organization approval and SSO rules still apply.
                </p>
              </>
            )}
            {!!branches.length && (
              <Field>
                <FieldLabel>Branch</FieldLabel>
                <NativeSelect
                  value={value.branch}
                  onChange={(e) =>
                    onChange({ ...value, branch: e.target.value })
                  }
                >
                  {branches.map((branch) => (
                    <option key={branch.name}>{branch.name}</option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            {branchPage && (
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const data = await api<{
                      branches: { name: string; commit: string }[]
                      next_page: number | null
                    }>(
                      `${base}/${connection}/branches?service=${encodeURIComponent(service)}&repository=${encodeURIComponent(value.repository)}&page=${branchPage}`,
                    )
                    setBranches([...branches, ...data.branches])
                    setBranchPage(data.next_page)
                  })
                }
              >
                Load more branches
              </Button>
            )}
            {connection && (
              <CollapsibleSection title="Connection access and revocation">
                <FieldGroup className="mt-3 flex flex-col gap-3">
                  <p className="text-xs text-muted-foreground">
                    The owner or shared-connection administrator can delegate
                    repository names to this app. Other app deployers may then
                    use these repositories without seeing credentials. Replacing
                    the list revokes omitted repository bindings.
                  </p>
                  <Field>
                    <FieldLabel>
                      Delegated repositories (one owner/repository per line)
                    </FieldLabel>
                    <Textarea
                      data-git-delegations
                      rows={3}
                      value={delegations}
                      onChange={(event) => setDelegations(event.target.value)}
                    />
                  </Field>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const text = delegations
                      if (
                        !(await confirm({
                          title: 'Replace repository delegations?',
                          description:
                            'Omitted bindings will be revoked for future deployments.',
                          actionLabel: 'Replace delegations',
                          variant: 'destructive',
                        }))
                      )
                        return
                      void run(async () => {
                        await api(`${base}/${connection}/delegations`, 'PUT', {
                          service,
                          repositories: text
                            .split('\n')
                            .map((name) => name.trim())
                            .filter(Boolean),
                        })
                      })
                    }}
                  >
                    Save app delegation
                  </Button>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: 'Revoke connection?',
                          description:
                            'Future deployments will stop using this connection. Serving apps stay running.',
                          actionLabel: 'Revoke connection',
                          variant: 'destructive',
                        })
                      )
                        void run(async () => {
                          await api(`${base}/${connection}`, 'DELETE')
                          setConnection('')
                          await refresh()
                        })
                    }}
                  >
                    Revoke connection
                  </Button>
                </FieldGroup>
              </CollapsibleSection>
            )}
            {value.connection_id && (
              <div className="flex flex-col gap-3   pt-3">
                <Separator className="basis-full" />
                <p className="text-sm text-muted-foreground">
                  Selected: {value.repository} · {value.branch}
                </p>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const data = await api<Inspection>(
                        `${base}/${value.connection_id}/inspect`,
                        'POST',
                        {
                          service,
                          repository: value.repository,
                          ref: value.branch,
                          app_root: value.app_root ?? '.',
                          context: value.context,
                          build_file: value.build_file,
                        },
                      )
                      setInspection(data)
                      setSuggestion(data.dockerfile ?? '')
                    })
                  }
                >
                  Inspect build inputs / suggest Dockerfile
                </Button>
                <div className="flex flex-wrap gap-2">
                  {(['automatic', 'manual', 'unavailable'] as const).map(
                    (mode) => (
                      <Button
                        key={mode}
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const status = await api<{
                              mode: string
                              url: string
                              message: string | null
                              instructions: string
                            }>(
                              `${base}/${value.connection_id}/webhook`,
                              'POST',
                              {
                                service,
                                repository: value.repository,
                                mode,
                              },
                            )
                            setHook(status)
                            if (status.mode === 'unavailable')
                              onChange({ ...value, enabled: false })
                          })
                        }
                      >
                        {mode === 'automatic'
                          ? 'Set up automatic webhook'
                          : mode === 'manual'
                            ? 'Manual webhook instructions'
                            : 'Use manual deployments only'}
                      </Button>
                    ),
                  )}
                </div>
                {hook && (
                  <p className="text-xs text-muted-foreground">
                    Webhook: {hook.mode}. {hook.message} {hook.instructions}{' '}
                    Callback: {hook.url}
                  </p>
                )}
                {inspection && (
                  <>
                    <p className="text-sm">{inspection.message}</p>
                    <ul className="list-disc pl-5 text-xs text-muted-foreground">
                      {[...inspection.evidence, ...inspection.warnings].map(
                        (text) => (
                          <li key={text}>{text}</li>
                        ),
                      )}
                    </ul>
                    {inspection.dockerfile && (
                      <Field>
                        <FieldLabel>
                          Editable Dockerfile suggestion — copy and commit at{' '}
                          {value.build_file}
                        </FieldLabel>
                        <Textarea
                          rows={18}
                          value={suggestion}
                          onChange={(e) => setSuggestion(e.target.value)}
                        />
                      </Field>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
