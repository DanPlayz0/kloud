import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Container,
  FileCode2,
  GitBranch,
  Layers,
  Server,
  Info,
  type LucideIcon,
} from 'lucide-react'
import {
  platformConfigSchema,
  type PlatformConfig,
} from '@kloud/protocol/platform'
import { api, type Project, type User } from './api'
import { Shell, usePolling, ErrorMessage } from './components'
import {
  newConfig,
  SourceFields,
  RuntimeFields,
  type Host,
} from './service-configuration'
import { Button, Input, Label } from './components/ui/controls'
import { Card } from './components/ui/card'
import { CollapsibleSection } from './components/ui/collapsible'
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
  TooltipPortal,
} from './components/ui/tooltip'

type SourceKey = 'dockerfile' | 'git-compose' | 'image' | 'compose'
const sourceHelp: Record<SourceKey, string> = {
  dockerfile:
    'Build paths are relative to the repository root. Change the branch, Dockerfile, or build context in Build settings.',
  'git-compose':
    'The repository’s Compose file defines environment variables, ports, volumes, networks, and health checks for the stack.',
  image:
    'Use a complete image reference, including its registry and tag or digest. Add credentials only for private registries.',
  compose:
    'Compose defines the stack’s runtime settings. Use image references here; choose GitHub Compose for repository builds.',
}
const sources: {
  key: SourceKey
  title: string
  description: string
  icon: LucideIcon
  group: string
}[] = [
  {
    key: 'dockerfile',
    title: 'GitHub application',
    description: 'Build from a Dockerfile.',
    icon: GitBranch,
    group: 'From a repository',
  },
  {
    key: 'git-compose',
    title: 'GitHub Compose',
    description: 'Deploy a stack from a repository.',
    icon: Layers,
    group: 'From a repository',
  },
  {
    key: 'image',
    title: 'Docker image',
    description: 'Run an image from a registry.',
    icon: Container,
    group: 'From Docker',
  },
  {
    key: 'compose',
    title: 'Docker Compose',
    description: 'Paste a stack definition.',
    icon: FileCode2,
    group: 'From Docker',
  },
]
function sourceConfig(key: SourceKey): PlatformConfig['source'] {
  if (key === 'image') return { type: 'image', image: '' }
  if (key === 'compose') return { type: 'compose', content: '' }
  return {
    type: 'github',
    config: {
      connector_id: '',
      container_name: 'managed',
      repository: '',
      branch: 'main',
      kind: key === 'dockerfile' ? 'dockerfile' : 'compose',
      build_file: key === 'dockerfile' ? 'Dockerfile' : 'compose.yaml',
      context: '.',
      service: 'app',
      enabled: true,
      managed: true,
    },
  }
}
function generatedSlug(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '')
}
function hostIssue(host: Host) {
  return !host.capabilities.includes('deploy')
    ? 'Deployments disabled'
    : !host.seen || Date.now() - Date.parse(host.seen) > 20000
      ? 'Disconnected'
      : null
}

export function ServiceCreatePage({
  user,
  projects,
  project,
  canCreate,
  canDeploy,
}: {
  user: User
  projects: Project[]
  project: string
  canCreate: boolean
  canDeploy: boolean
}) {
  const [selected, setSelected] = useState<SourceKey | null>(null),
    [name, setName] = useState(''),
    [customSlug, setCustomSlug] = useState<string>(),
    [config, setConfig] = useState(newConfig)
  const drafts = useRef<Partial<Record<SourceKey, PlatformConfig['source']>>>(
    {},
  )
  const [error, setError] = useState(''),
    [fieldError, setFieldError] = useState(''),
    [busy, setBusy] = useState(false),
    [created, setCreated] = useState(false),
    [deploying, setDeploying] = useState(false),
    [commit, setCommit] = useState('')
  const submitting = useRef(false),
    requestKey = useRef(crypto.randomUUID()),
    deploymentFingerprint = useRef(''),
    savedRevision = useRef<{ fingerprint: string; id: string } | null>(null)
  const nameField = useRef<HTMLInputElement>(null),
    commitField = useRef<HTMLInputElement>(null)
  const { data: hosts, error: hostError } = usePolling<Host[]>(
    canCreate && canDeploy ? `/projects/${project}/hosts` : null,
  )
  const slug = customSlug ?? generatedSlug(name)
  const source = sources.find((s) => s.key === selected) ?? sources[0]!
  const compose = selected === 'compose' || selected === 'git-compose'
  const eligible = hosts?.filter((h) => !hostIssue(h)) ?? []
  useEffect(() => {
    if (!config.connector_id && eligible.length === 1)
      setConfig((value) => ({ ...value, connector_id: eligible[0]!.id }))
  }, [hosts, config.connector_id])
  useEffect(() => {
    if (selected) nameField.current?.focus()
  }, [selected])
  useEffect(() => {
    if (deploying) commitField.current?.focus()
  }, [deploying])
  function choose(key: SourceKey) {
    if (selected) drafts.current[selected] = config.source
    setConfig((value) => ({
      ...value,
      source: drafts.current[key] ?? sourceConfig(key),
    }))
    setSelected(key)
    setError('')
    setFieldError('')
    setDeploying(false)
  }
  function change() {
    if (selected) drafts.current[selected] = config.source
    setSelected(null)
    setError('')
    setFieldError('')
    const previous = selected
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-source-choice="${previous}"]`)
        ?.focus(),
    )
  }
  function reveal(title: string) {
    document
      .querySelector(`[data-settings-section="${title}"]`)
      ?.dispatchEvent(new Event('reveal-settings'))
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || !selected) return
    const form = event.currentTarget
    const wantsDeploy =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
        'data-deploy',
      ) === 'true'
    setError('')
    setFieldError('')
    if (!form.checkValidity()) {
      const input = form.querySelector<HTMLInputElement>(
        'input:invalid,textarea:invalid,select:invalid',
      )
      setFieldError(
        `${input?.labels?.[0]?.textContent?.trim() ?? 'Required field'}: ${input?.validationMessage ?? 'Check this value.'}`,
      )
      requestAnimationFrame(() => input?.focus())
      return
    }
    if (!slug) {
      reveal('Advanced settings')
      setFieldError('Enter a slug using letters or numbers.')
      requestAnimationFrame(() =>
        form.querySelector<HTMLInputElement>('[name="slug"]')?.focus(),
      )
      return
    }
    const desired: PlatformConfig = {
      ...config,
      runtime: compose ? newConfig().runtime : config.runtime,
      source:
        config.source.type === 'github'
          ? {
              ...config.source,
              config: {
                ...config.source.config,
                connector_id: config.connector_id,
                container_name: `kloud-${project}-${slug}`,
              },
            }
          : config.source,
    }
    if (canDeploy) {
      const parsed = platformConfigSchema.safeParse(desired)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!,
          path = issue.path.join('.')
        const section = path.includes('registry')
          ? 'Registry credentials'
          : path.startsWith('source.config') &&
              path !== 'source.config.repository'
            ? 'Build settings'
            : path.startsWith('runtime')
              ? path.includes('environment')
                ? 'Environment and secrets'
                : path.includes('ports')
                  ? 'Published ports'
                  : path.includes('volumes')
                    ? 'Persistent volumes'
                    : path.includes('networks')
                      ? 'Networks'
                      : path.includes('healthcheck')
                        ? 'Health check'
                        : 'Resources and restart'
              : null
        if (section) reveal(section)
        const label =
          section ??
          (path === 'connector_id'
            ? 'Deployment host'
            : config.source.type === 'image'
              ? 'Image'
              : config.source.type === 'compose'
                ? 'Compose definition'
                : 'Repository')
        setFieldError(`${label}: ${issue.message}`)
        requestAnimationFrame(() => {
          const exact = Array.from(
            form.querySelectorAll<HTMLElement>('[data-config-path]'),
          ).find((element) => element.dataset.configPath === path)
          const target =
            exact ??
            (section
              ? document.querySelector<HTMLElement>(
                  `[data-settings-section="${section}"] input, [data-settings-section="${section}"] textarea`,
                )
              : path === 'connector_id'
                ? form.querySelector<HTMLElement>(
                    'button[aria-label^="Deploy to"]:not(:disabled)',
                  )
                : form.querySelector<HTMLElement>('[data-source-input]'))
          target?.focus()
        })
        return
      }
      if (!hosts?.some((h) => h.id === config.connector_id && !hostIssue(h))) {
        setFieldError('Choose a connected host with deployments enabled.')
        return
      }
      if (
        wantsDeploy &&
        desired.source.type === 'github' &&
        !/^[a-f0-9]{40}$/.test(commit)
      ) {
        setFieldError('Enter a full 40-character commit SHA.')
        commitField.current?.focus()
        return
      }
    }
    submitting.current = true
    setBusy(true)
    try {
      if (!created) {
        await api(`/projects/${project}/services`, 'POST', {
          name,
          slug,
          type: compose ? 'compose' : 'application',
          description: '',
        })
        setCreated(true)
      }
      if (canDeploy) {
        const fingerprint = JSON.stringify(desired)
        if (savedRevision.current?.fingerprint !== fingerprint) {
          const revision = await api<{ id: string }>(
            `/projects/${project}/services/${slug}/configuration`,
            'PUT',
            { config: desired },
          )
          savedRevision.current = { fingerprint, id: revision.id }
          requestKey.current = crypto.randomUUID()
        }
        if (wantsDeploy) {
          const fingerprint = `${savedRevision.current!.id}:${desired.source.type === 'github' ? commit : ''}`
          if (deploymentFingerprint.current !== fingerprint) {
            deploymentFingerprint.current = fingerprint
            requestKey.current = crypto.randomUUID()
          }
          await api(`/projects/${project}/services/${slug}/deploy`, 'POST', {
            revision: savedRevision.current!.id,
            request_key: requestKey.current,
            ...(desired.source.type === 'github' ? { commit } : {}),
          })
        }
      }
      location.assign(`/projects/${project}/applications/${slug}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create service')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <Shell
      user={user}
      projects={projects}
      project={project}
      active="services"
      title="Services / Create service"
    >
      <section className="admin-content min-w-0 space-y-7">
        <Button
          asChild
          className="!border-0 !bg-transparent !px-0 text-muted-foreground"
        >
          <a href={`/projects/${project}/services`}>
            <ArrowLeft size={15} />
            Services
          </a>
        </Button>
        <div>
          <p className="eyebrow">NEW SERVICE</p>
          <h1 className="mt-2 text-2xl font-semibold">
            {selected
              ? 'Set up your service'
              : 'What would you like to deploy?'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {selected
              ? 'Start with the essentials. Fine-tune the rest when you need it.'
              : 'Choose a source to get started.'}
          </p>
        </div>
        {!canCreate ? (
          <Card className="p-6 text-muted-foreground">
            You need permission to create services in this project.
          </Card>
        ) : !selected ? (
          <div className="grid gap-6 md:grid-cols-2">
            {['From a repository', 'From Docker'].map((group) => (
              <section key={group} className="min-w-0 space-y-3">
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {group}
                </h2>
                {sources
                  .filter((s) => s.group === group)
                  .map((item) => (
                    <Button
                      key={item.key}
                      aria-label={item.title}
                      data-source-choice={item.key}
                      onClick={() => choose(item.key)}
                      className="group !h-auto min-h-36 w-full !justify-start !rounded-xl !bg-card !p-6 text-left hover:!border-muted-foreground focus-visible:ring-2 focus-visible:ring-foreground"
                    >
                      <span className="flex w-full items-start gap-4">
                        <span className="rounded-lg border border-border bg-background p-3">
                          <item.icon
                            size={25}
                            strokeWidth={1.5}
                            aria-hidden="true"
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-base font-semibold">
                            {item.title}
                          </span>
                          <span className="mt-2 block text-sm leading-relaxed text-muted-foreground">
                            {item.description}
                          </span>
                        </span>
                        <ArrowRight
                          size={17}
                          className="mt-3 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1"
                          aria-hidden="true"
                        />
                      </span>
                    </Button>
                  ))}
              </section>
            ))}
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="space-y-6">
            <fieldset disabled={busy} className="min-w-0 space-y-6">
              <Card
                size="compact"
                className="flex flex-wrap items-center gap-3"
              >
                <source.icon size={21} aria-hidden="true" />
                <span className="min-w-0 flex-1 font-medium">
                  {source.title}
                </span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        aria-label={`About ${source.title}`}
                        className="!border-0 !bg-transparent !p-2 text-muted-foreground"
                      >
                        <Info size={16} aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipPortal>
                      <TooltipContent side="bottom" className="max-w-72">
                        {sourceHelp[selected]}
                      </TooltipContent>
                    </TooltipPortal>
                  </Tooltip>
                </TooltipProvider>
                <Button type="button" disabled={created} onClick={change}>
                  Change
                </Button>
              </Card>
              {!canDeploy && (
                <p className="text-sm text-muted-foreground">
                  Create the service now. Deployment permission is needed to
                  configure and deploy it.
                </p>
              )}
              <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_17rem]">
                <div className="min-w-0 space-y-4">
                  <Card className="space-y-5">
                    <Label>
                      Service name
                      <Input
                        ref={nameField}
                        required
                        maxLength={100}
                        disabled={created}
                        placeholder="My application"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </Label>
                    {canDeploy && (
                      <SourceFields
                        config={config}
                        onChange={setConfig}
                        mode="create"
                      />
                    )}
                  </Card>
                  {canDeploy && (
                    <section className="space-y-3" aria-label="Deployment host">
                      <div className="flex items-center justify-between">
                        <h2 className="text-sm font-medium">Deployment host</h2>
                        <span className="text-xs text-muted-foreground">
                          {eligible.length} available
                        </span>
                      </div>
                      <ErrorMessage message={hostError} />
                      {!hosts && !hostError && (
                        <p
                          role="status"
                          className="text-sm text-muted-foreground"
                        >
                          Loading hosts…
                        </p>
                      )}
                      {hosts?.length === 0 && (
                        <Card
                          size="compact"
                          className="text-sm text-muted-foreground"
                        >
                          No hosts connected. Add a connector to deploy
                          services.
                        </Card>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        {hosts?.map((host) => {
                          const issue = hostIssue(host),
                            active = config.connector_id === host.id
                          return (
                            <Button
                              key={host.id}
                              type="button"
                              aria-label={`Deploy to ${host.name}`}
                              aria-pressed={active}
                              aria-describedby={`host-state-${host.id}`}
                              disabled={!!issue}
                              onClick={() =>
                                setConfig({ ...config, connector_id: host.id })
                              }
                              className={`!h-auto !justify-start !p-4 text-left ${active ? '!border-foreground !bg-card' : '!bg-card'}`}
                            >
                              <Server
                                size={18}
                                className="shrink-0"
                                aria-hidden="true"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block break-all text-sm font-medium">
                                  {host.name}
                                </span>
                                <span
                                  id={`host-state-${host.id}`}
                                  className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
                                >
                                  <span
                                    className={`size-1.5 rounded-full ${issue ? 'bg-muted-foreground' : 'bg-emerald-500'}`}
                                    aria-hidden="true"
                                  />
                                  {issue ?? 'Connected'}
                                </span>
                              </span>
                              {active && !issue && (
                                <Check
                                  size={16}
                                  className="shrink-0"
                                  aria-hidden="true"
                                />
                              )}
                            </Button>
                          )
                        })}
                      </div>
                    </section>
                  )}
                  <CollapsibleSection
                    title="Advanced settings"
                    count={customSlug !== undefined ? 1 : 0}
                  >
                    <Label>
                      Slug
                      <Input
                        name="slug"
                        required
                        pattern="[a-z0-9]+(-[a-z0-9]+)*"
                        maxLength={100}
                        disabled={created}
                        value={slug}
                        onChange={(e) =>
                          setCustomSlug(e.target.value || undefined)
                        }
                      />
                    </Label>
                  </CollapsibleSection>
                  {canDeploy && !compose && (
                    <RuntimeFields
                      value={config.runtime}
                      onChange={(runtime) => setConfig({ ...config, runtime })}
                      compact
                    />
                  )}
                </div>
                <aside className="hidden min-w-0 space-y-4 xl:sticky xl:top-6 xl:block">
                  <Card className="space-y-4">
                    <h2 className="text-sm font-semibold">Your service</h2>
                    <dl className="space-y-4 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">Name</dt>
                        <dd className="mt-1 break-all">
                          {name || 'Untitled service'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          Source
                        </dt>
                        <dd className="mt-1">{source.title}</dd>
                      </div>
                      {canDeploy && (
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            Host
                          </dt>
                          <dd className="mt-1 break-all">
                            {hosts?.find((h) => h.id === config.connector_id)
                              ?.name ?? 'Not selected'}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </Card>
                </aside>
              </div>
              {deploying && config.source.type === 'github' && (
                <Card className="space-y-3">
                  <Label>
                    Commit SHA
                    <Input
                      ref={commitField}
                      maxLength={40}
                      placeholder="40-character commit SHA"
                      value={commit}
                      onChange={(e) => setCommit(e.target.value)}
                    />
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Deploy this exact commit from your repository.
                  </p>
                </Card>
              )}
              <ErrorMessage message={error || fieldError} />
              {created && error && (
                <Button asChild>
                  <a href={`/projects/${project}/applications/${slug}`}>
                    Open created service
                    <ArrowRight size={14} />
                  </a>
                </Button>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background py-4">
                <span className="text-xs text-muted-foreground">
                  {deploying
                    ? 'Deploy after saving'
                    : 'Saving a draft does not deploy.'}
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    type="submit"
                    onClick={() => setDeploying(false)}
                    disabled={busy}
                  >
                    {busy
                      ? 'Saving…'
                      : canDeploy
                        ? 'Save draft'
                        : 'Create service'}
                  </Button>
                  {canDeploy && (
                    <Button
                      type={
                        config.source.type !== 'github' || deploying
                          ? 'submit'
                          : 'button'
                      }
                      data-deploy="true"
                      disabled={busy}
                      onClick={(event) => {
                        if (config.source.type === 'github' && !deploying) {
                          event.preventDefault()
                          setDeploying(true)
                        }
                      }}
                    >
                      {deploying ? 'Deploy now' : 'Create and deploy'}
                      <ArrowRight size={14} />
                    </Button>
                  )}
                </div>
              </div>
            </fieldset>
          </form>
        )}
      </section>
    </Shell>
  )
}
