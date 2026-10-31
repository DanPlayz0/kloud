import { StatusBadge } from './components/ui/status-badge'
import { useEffect, useState, type FormEvent } from 'react'
import { Plus, Trash2, RotateCcw } from 'lucide-react'
import type { PlatformConfig, Domain } from '@kloud/protocol/platform'
import { platformConfigSchema } from '@kloud/protocol/platform'
import { api, type ContainerRow } from './api'
import { usePolling, ErrorMessage, bytes } from './components'
import { DeploymentSettings } from './deployments'
import { ContainerOperations } from './container-operations'
import {
  SourceFields,
  RuntimeFields,
  HostField,
  newConfig,
  type Host,
} from './service-configuration'
import { Tabs } from './components/ui/tabs'
import { Button, Input, Label, NativeSelect } from './components/ui/controls'
import { Card } from './components/ui/card'

interface History {
  revisions: { id: string; created: string }[]
  runs: {
    id: string
    revision: string
    status: string
    log: string
    created: string
    artifacts: Record<string, string> | null
  }[]
}
export function ServiceDetail({
  project,
  slug,
  name,
  type,
  canDeploy,
}: {
  project: string
  slug: string
  name: string
  type?: 'application' | 'compose'
  canDeploy: boolean
}) {
  const [tab, setTab] = useState('Overview'),
    [legacyOpen, setLegacyOpen] = useState(false),
    [refresh, setRefresh] = useState(0),
    [config, setConfig] = useState<PlatformConfig>(() =>
      type === 'compose'
        ? { ...newConfig(), source: { type: 'compose', content: '' } }
        : newConfig(),
    ),
    [loaded, setLoaded] = useState<string | undefined>(),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [commit, setCommit] = useState('')
  const base = `/projects/${project}/services/${slug}`
  const { data: history, error: historyError } = usePolling<History>(
    type ? `${base}/configuration` : null,
    refresh,
  )
  const { data: inventory, error: inventoryError } = usePolling<ContainerRow[]>(
    `/projects/${project}/containers`,
  )
  const { data: hosts } = usePolling<Host[]>(
    canDeploy ? `/projects/${project}/hosts` : null,
  )
  const containers = inventory?.filter((c) => c.application === slug)
  const latest = history?.revisions?.[0]?.id
  const { data: legacy } = usePolling<{ config: unknown } | null>(
    latest ? null : `/projects/${project}/applications/${slug}/deployment`,
  )
  useEffect(() => {
    if (!canDeploy || !latest || latest === loaded) return
    let cancelled = false
    void api<PlatformConfig>(`${base}/configuration/${latest}`)
      .then((value) => {
        if (!cancelled) {
          setConfig(value)
          setLoaded(latest)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [latest, canDeploy, base])
  const compose =
    config.source.type === 'compose' ||
    (config.source.type === 'github' && config.source.config.kind === 'compose')
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const parsed = platformConfigSchema.safeParse(config)
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        )
      const result = await api<{ id: string }>(`${base}/configuration`, 'PUT', {
        config: parsed.data,
        previous: loaded,
      })
      setLoaded(undefined)
      setRefresh((n) => n + 1)
      setMessage('Draft saved. Deploy it explicitly from Deployments.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save')
    } finally {
      setBusy(false)
    }
  }
  async function deploy(revision: string, rollback?: string) {
    if (
      rollback &&
      !window.confirm(
        'Roll back code and configuration? Database contents and volume data will not be restored.',
      )
    )
      return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api(`${base}/deploy`, 'POST', {
        revision,
        request_key: crypto.randomUUID(),
        ...(config.source.type === 'github' && !rollback ? { commit } : {}),
        ...(rollback ? { rollback } : {}),
      })
      setRefresh((n) => n + 1)
      setMessage('Deployment queued.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to deploy')
    } finally {
      setBusy(false)
    }
  }
  const stale = containers?.some(
    (c) => c.stale || !c.seen || Date.now() - Date.parse(c.seen) > 20000,
  )
  return (
    <section className="admin-content min-w-0 space-y-6">
      <div className="page-heading">
        <div>
          <p className="eyebrow">SERVICE</p>
          <h1>{name}</h1>
          <p className="text-muted-foreground">
            {type === 'compose' ? 'Compose stack' : 'Application'} · {slug}
          </p>
        </div>
      </div>
      <Tabs
        items={[
          'Overview',
          'Source',
          'Configuration',
          'Deployments',
          'Containers',
          'Logs',
          'Domains',
        ]}
        value={tab}
        onChange={(value) => {
          setTab(value)
          setError('')
          setMessage('')
        }}
        label="Service sections"
      />
      <ErrorMessage message={error || historyError || inventoryError} />
      {!canDeploy && (
        <p className="text-sm text-muted-foreground">
          You have view access. Ask a project administrator for deployment
          permission.
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      {tab === 'Overview' && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="space-y-2 p-5">
              <p className="text-sm text-muted-foreground">Runtime</p>
              <p className="font-semibold">
                <StatusBadge>
                  {inventoryError
                    ? 'Unavailable'
                    : !containers
                      ? 'Loading'
                      : stale
                        ? 'Host disconnected'
                        : !containers.length
                          ? 'Not deployed'
                          : containers.every(
                                (c) =>
                                  c.data.state === 'running' &&
                                  c.data.health !== 'unhealthy' &&
                                  c.data.health !== 'starting',
                              )
                            ? 'Running'
                            : 'Needs attention'}
                </StatusBadge>
              </p>
              <p className="text-xs text-muted-foreground">
                {containers?.length ?? 0} containers
              </p>
            </Card>
            <Card className="space-y-2 p-5">
              <p className="text-sm text-muted-foreground">Latest deployment</p>
              <p className="font-semibold">
                <StatusBadge deployment>
                  {history?.runs?.[0]?.status ?? 'No new deployments'}
                </StatusBadge>
              </p>
              <p className="text-xs text-muted-foreground">
                Deployment success is separate from runtime health.
              </p>
            </Card>
            <Card className="space-y-2 p-5">
              <p className="text-sm text-muted-foreground">Resources</p>
              <p>
                {stale || !containers?.length
                  ? 'Unavailable'
                  : `${containers.reduce((n, c) => n + (c.data.cpu ?? 0), 0).toFixed(1)}% CPU · ${bytes(containers.reduce((n, c) => n + (c.data.memory ?? 0), 0))}`}
              </p>
              <p className="text-xs text-muted-foreground break-all">
                {[
                  ...new Set(
                    containers?.map((c) => c.host ?? c.connector_name),
                  ),
                ].join(', ')}
              </p>
            </Card>
          </div>
          <p className="text-muted-foreground">
            Create a configuration draft, then deploy it. Existing Git
            deployment settings remain available under Deployments.
          </p>
        </>
      )}
      {(tab === 'Source' || tab === 'Configuration') &&
        (canDeploy && !latest && legacy?.config ? (
          <Card className="space-y-3 p-5">
            <p className="text-sm text-muted-foreground">
              This service uses existing Git deployment configuration.
            </p>
            <Button onClick={() => setTab('Deployments')}>
              Open deployment settings
            </Button>
          </Card>
        ) : canDeploy ? (
          <form onSubmit={save} className="space-y-5">
            <fieldset disabled={busy} className="min-w-0 space-y-5">
              {tab === 'Source' ? (
                <>
                  <SourceFields
                    config={config}
                    onChange={setConfig}
                    serviceType={type}
                  />
                  <HostField
                    config={config}
                    onChange={setConfig}
                    hosts={hosts ?? []}
                  />
                  {latest && config.source.type === 'github' && (
                    <GitWebhook project={project} slug={slug} />
                  )}
                </>
              ) : compose ? (
                <p className="text-muted-foreground">
                  Compose owns this stack’s runtime configuration. Edit its
                  source definition.
                </p>
              ) : (
                <RuntimeFields
                  key={loaded ?? 'new'}
                  value={config.runtime}
                  onChange={(runtime) => setConfig({ ...config, runtime })}
                />
              )}
              <Button variant="primary" disabled={busy}>
                Save draft
              </Button>
            </fieldset>
          </form>
        ) : (
          <p className="text-muted-foreground">
            You have view access. Deployment permission is required to change
            configuration.
          </p>
        ))}
      {tab === 'Deployments' && (
        <div className="space-y-5">
          {canDeploy && latest && (
            <Card className="space-y-4 p-5">
              <h2 className="font-semibold">Deploy saved draft</h2>
              {config.source.type === 'github' && (
                <Label>
                  Commit SHA
                  <Input
                    pattern="[a-f0-9]{40}"
                    value={commit}
                    onChange={(e) => setCommit(e.target.value)}
                  />
                </Label>
              )}
              <Button
                variant="primary"
                disabled={
                  busy ||
                  (config.source.type === 'github' &&
                    !/^[a-f0-9]{40}$/.test(commit))
                }
                onClick={() => void deploy(latest)}
              >
                Deploy draft
              </Button>
            </Card>
          )}
          {history?.runs?.map((run) => (
            <Card key={run.id} className="space-y-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm">
                  <StatusBadge deployment>{run.status}</StatusBadge> ·{' '}
                  {new Date(run.created).toLocaleString()}
                </p>
                {canDeploy && run.status === 'succeeded' && run.artifacts && (
                  <Button
                    disabled={busy}
                    onClick={() => void deploy(run.revision, run.id)}
                  >
                    <RotateCcw size={14} />
                    Roll back
                  </Button>
                )}
              </div>
              <pre className="overflow-auto text-xs whitespace-pre-wrap break-all">
                {run.log || 'Waiting for host…'}
              </pre>
            </Card>
          ))}
          <Card className="p-4">
            <Button
              aria-expanded={legacyOpen}
              onClick={() => setLegacyOpen(!legacyOpen)}
            >
              Existing Git deployment settings and history
            </Button>
            {legacyOpen && (
              <DeploymentSettings
                project={project}
                application={slug}
                canDeploy={canDeploy && !latest}
                serviceType={type}
              />
            )}
          </Card>
        </div>
      )}
      {(tab === 'Containers' || tab === 'Logs') && (
        <div className="space-y-3">
          {!containers?.length && (
            <p className="text-muted-foreground">
              No runtime containers available.
            </p>
          )}
          {containers?.map((c) => (
            <Card
              key={`${c.connector_id}:${c.container_id}`}
              className="flex flex-wrap items-center justify-between gap-4 p-4"
            >
              <div>
                <p className="font-medium break-all">{c.data.name}</p>
                <p className="text-xs text-muted-foreground">
                  {c.connector_name} · {c.stale ? 'Stale' : c.data.state}
                </p>
              </div>
              <ContainerOperations project={project} container={c} />
            </Card>
          ))}
        </div>
      )}
      {tab === 'Domains' && (
        <ServiceDomains
          project={project}
          slug={slug}
          canDeploy={canDeploy}
          containers={containers ?? []}
        />
      )}
    </section>
  )
}
function GitWebhook({ project, slug }: { project: string; slug: string }) {
  const path = `/projects/${project}/applications/${slug}/deployment`
  const { data } = usePolling<{
    webhook_url: string
    config: { enabled: boolean }
  } | null>(path)
  const [secret, setSecret] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  if (!data) return null
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">GitHub push deployments</h2>
      <Label>
        Webhook URL
        <Input readOnly value={data.webhook_url} />
      </Label>
      <p className="text-xs text-muted-foreground">
        {data.config.enabled
          ? 'Signed pushes deploy the active revision.'
          : 'Deploy a draft first to activate push deployments.'}{' '}
        Configure a GitHub push webhook using this URL and the generated secret.
      </p>
      <Button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError('')
          void api<{ webhook_secret: string }>(path, 'POST')
            .then((value) => setSecret(value.webhook_secret))
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false))
        }}
      >
        Generate new webhook secret
      </Button>
      {secret && (
        <Label>
          Webhook secret — copy now
          <Input readOnly value={secret} />
          <span className="text-xs">
            Update GitHub immediately. The previous secret is invalid.
          </span>
        </Label>
      )}
      <ErrorMessage message={error} />
    </Card>
  )
}
function ServiceDomains({
  project,
  slug,
  canDeploy,
  containers,
}: {
  project: string
  slug: string
  canDeploy: boolean
  containers: ContainerRow[]
}) {
  const [refresh, setRefresh] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const path = `/projects/${project}/services/${slug}/domains`
  const { data, error: loadError } = usePolling<
    {
      id: string
      config: Domain
      desired: string | null
      applied: string | null
      error: string | null
    }[]
  >(path, refresh)
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(e.currentTarget)
    const target = containers.find(
      (c) => `${c.connector_id}:${c.container_id}` === form.get('target'),
    )
    try {
      if (!target) throw new Error('Select a service container')
      await api(path, 'POST', {
        connector_id: target.connector_id,
        config: {
          hostname: form.get('hostname'),
          path: form.get('path'),
          port: Number(form.get('port')),
          container: target.data.name,
          network: form.get('network'),
          https: form.get('https') === 'true',
          redirect: true,
        },
      })
      setRefresh((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save route')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Managed NGINX routes to containers on the same host. Configure DNS
        separately in Cloud DNS. HTTPS requires public port 80 for certificate
        validation.
      </p>
      <ErrorMessage message={error || loadError} />
      {data?.map((route) => (
        <Card
          key={route.id}
          className="flex flex-wrap items-center justify-between gap-3 p-4"
        >
          <div>
            <p>
              {route.config.hostname}
              {route.config.path}
            </p>
            <p className="text-xs text-muted-foreground">
              {route.error ||
                (route.applied && route.applied === route.desired
                  ? 'Applied'
                  : 'Pending reconciliation')}
            </p>
          </div>
          {canDeploy && (
            <Button
              disabled={busy}
              aria-label={`Remove ${route.config.hostname}`}
              onClick={() => {
                setBusy(true)
                void api(`${path}/${route.id}`, 'DELETE')
                  .then(() => setRefresh((n) => n + 1))
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false))
              }}
            >
              <Trash2 size={14} />
            </Button>
          )}
        </Card>
      ))}
      {canDeploy && (
        <form onSubmit={save}>
          <Card className="space-y-4 p-5">
            <h2 className="font-semibold">Add domain</h2>
            <fieldset disabled={busy} className="space-y-4">
              <Label>
                Hostname
                <Input name="hostname" required placeholder="app.example.com" />
              </Label>
              <div className="grid gap-4 md:grid-cols-2">
                <Label>
                  Path
                  <Input name="path" required defaultValue="/" />
                </Label>
                <Label>
                  Container port
                  <Input
                    name="port"
                    type="number"
                    min={1}
                    max={65535}
                    required
                    defaultValue={80}
                  />
                </Label>
              </div>
              <Label>
                Service container
                <NativeSelect name="target" required>
                  <option value="">Select container</option>
                  {containers.map((c) => (
                    <option
                      key={`${c.connector_id}:${c.container_id}`}
                      value={`${c.connector_id}:${c.container_id}`}
                    >
                      {c.data.name} · {c.connector_name}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
              <Label>
                Docker network
                <Input name="network" required placeholder="service-network" />
              </Label>
              <Label>
                Protocol
                <NativeSelect name="https">
                  <option value="false">HTTP</option>
                  <option value="true">HTTPS with automatic certificate</option>
                </NativeSelect>
              </Label>
              <Button disabled={busy}>
                <Plus size={14} />
                Save route
              </Button>
            </fieldset>
          </Card>
        </form>
      )}
    </div>
  )
}
