import { CollapsibleSection } from './components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { StatusBadge } from './components/ui/status-badge'
import { useState, useEffect, type FormEvent } from 'react'
import { GitBranch, Hammer } from 'lucide-react'
import { api, type ContainerRow } from './api'
import { usePolling, ErrorMessage } from './components'
import { Card } from './components/ui/card'
import { Button, Input, NativeSelect, Checkbox } from './components/ui/controls'

interface Config {
  connector_id: string
  container_name: string
  repository: string
  branch: string
  kind: 'dockerfile' | 'compose'
  build_file: string
  context: string
  service: string
  enabled: boolean
  managed?: boolean
}
interface Build {
  id: string
  commit: string
  status: string
  created: string
  log: string
}
interface Deployment {
  id: string
  config: Config
  webhook_url: string
  builds: Build[]
}

export function DeploymentSettings({
  project,
  application,
  canDeploy = true,
  serviceType,
}: {
  project: string
  application: string
  canDeploy?: boolean
  serviceType?: 'application' | 'compose'
}) {
  const path = `/projects/${project}/applications/${application}/deployment`
  const [refresh, setRefresh] = useState(0)
  const [commit, setCommit] = useState('')
  const [queueError, setQueueError] = useState('')
  const [queueMessage, setQueueMessage] = useState('')
  const [queuing, setQueuing] = useState(false)
  const { data, error } = usePolling<Deployment | null>(path, refresh)
  const { data: containers, error: containerError } = usePolling<
    ContainerRow[]
  >(`/projects/${project}/containers`)
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <GitBranch size={22} />
        <div>
          <h1 className="text-xl font-semibold">{application} deployments</h1>
          <p className="text-muted-foreground">
            Build and redeploy on GitHub pushes.
          </p>
        </div>
      </div>
      <ErrorMessage message={error || containerError} />
      {!canDeploy && (
        <p className="text-muted-foreground">
          You have view access. Ask a project administrator for deployment
          permission to change configuration.
        </p>
      )}
      {canDeploy && data !== undefined && containers && (
        <DeploymentForm
          key={path}
          path={path}
          deployment={data}
          containers={containers.filter((c) => c.application === application)}
          onSaved={() => setRefresh((v) => v + 1)}
          serviceType={serviceType}
          project={project}
          application={application}
        />
      )}
      {data && (
        <Card className="flex flex-col gap-4">
          {canDeploy && (
            <Form
              className="flex flex-wrap items-end gap-3"
              onSubmit={async (e) => {
                e.preventDefault()
                setQueuing(true)
                setQueueError('')
                setQueueMessage('')
                try {
                  await api(path, 'POST', { commit })
                  setQueueMessage('Build queued.')
                  setRefresh((n) => n + 1)
                } catch (e) {
                  setQueueError(
                    e instanceof Error ? e.message : 'Unable to queue build',
                  )
                } finally {
                  setQueuing(false)
                }
              }}
            >
              <Field>
                <FieldLabel>Commit SHA</FieldLabel>
                <Input
                  aria-label="Commit SHA"
                  value={commit}
                  required
                  pattern="[a-f0-9]{40}"
                  maxLength={40}
                  placeholder="Full 40-character commit SHA"
                  onChange={(e) => setCommit(e.target.value)}
                />
              </Field>
              <Button variant="primary" disabled={queuing}>
                {queuing ? 'Queuing…' : 'Deploy commit'}
              </Button>
            </Form>
          )}
          <ErrorMessage message={queueError} />
          {queueMessage && (
            <p role="status" className="text-muted-foreground">
              {queueMessage}
            </p>
          )}
          <h2 className="flex items-center gap-2 font-semibold">
            <Hammer size={16} />
            Build history
          </h2>
          {data.builds.length === 0 && (
            <p className="text-muted-foreground">
              Waiting for a push to {data.config.branch}. Builds are processed
              by the selected connector when deployments are enabled on that
              host.
            </p>
          )}
          {data.builds.map((build) => (
            <CollapsibleSection
              key={build.id}
              title={`Build ${build.commit.slice(0, 7)}`}
              summary={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{build.commit.slice(0, 7)}</span>{' '}
                  · <StatusBadge deployment>{build.status}</StatusBadge> ·{' '}
                  {new Date(build.created).toLocaleString()}
                </span>
              }
            >
              <pre
                tabIndex={0}
                aria-label={`Build ${build.commit.slice(0, 7)} log`}
                className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground"
              >
                {build.log ||
                  (build.status === 'running'
                    ? 'Building on connector. Logs will appear when the build finishes.'
                    : 'Waiting for an enabled deployment worker.')}
              </pre>
            </CollapsibleSection>
          ))}
        </Card>
      )}
    </div>
  )
}

function DeploymentForm({
  path,
  deployment,
  containers,
  onSaved,
  serviceType,
  project,
  application,
}: {
  path: string
  deployment: Deployment | null
  containers: ContainerRow[]
  onSaved: () => void
  serviceType?: 'application' | 'compose'
  project: string
  application: string
}) {
  const [config, setConfig] = useState<Config>(
    deployment?.config ?? {
      connector_id: containers[0]?.connector_id ?? '',
      container_name: serviceType
        ? `kloud-${project}-${application}`
        : (containers[0]?.data.name ?? ''),
      repository: '',
      branch: 'main',
      kind: serviceType === 'compose' ? 'compose' : 'dockerfile',
      build_file: serviceType === 'compose' ? 'compose.yaml' : 'Dockerfile',
      context: '.',
      service: 'app',
      enabled: true,
      managed: !!serviceType,
    },
  )
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([])
  const [hostError, setHostError] = useState('')
  useEffect(() => {
    if (!serviceType) return
    const abort = new AbortController()
    void api<{ id: string; name: string }[]>(
      `/projects/${project}/services/${application}/connectors`,
      'GET',
      undefined,
      abort.signal,
    )
      .then(setHosts)
      .catch((e) => {
        if (!abort.signal.aborted)
          setHostError(e instanceof Error ? e.message : 'Unable to load hosts')
      })
    return () => abort.abort()
  }, [project, application, serviceType])
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [url, setUrl] = useState(deployment?.webhook_url ?? '')
  const change = <K extends keyof Config>(key: K, value: Config[K]) => {
    setConfig((old) => ({ ...old, [key]: value }))
    setSaved(false)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    setSaved(false)
    setBusy(true)
    setError('')
    try {
      const result = await api<{
        webhook_url: string
        webhook_secret?: string
      }>(path, 'PUT', config)
      setUrl(result.webhook_url)
      if (result.webhook_secret) setSecret(result.webhook_secret)
      setSaved(true)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save deployment')
    } finally {
      setBusy(false)
    }
  }
  async function rotate() {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ webhook_secret: string }>(path, 'POST')
      setSecret(result.webhook_secret)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to rotate secret')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="flex flex-col gap-5">
      <Form
        onSubmit={save}
        onChange={() => setSaved(false)}
        className="flex flex-col gap-5"
      >
        <h2 className="font-semibold">Deployment configuration</h2>
        <p className="text-sm text-muted-foreground">
          Choose where this service runs. Builds use temporary isolated workers.
        </p>
        <ErrorMessage message={hostError} />
        <FieldGroup className="grid gap-4 md:grid-cols-2">
          <Field className="flex flex-col gap-2">
            {config.managed ? (
              <>
                <FieldLabel htmlFor="deployment-host">
                  Deployment host
                </FieldLabel>
                <NativeSelect
                  id="deployment-host"
                  required
                  value={config.connector_id}
                  onChange={(e) => change('connector_id', e.target.value)}
                >
                  <option value="">Choose host</option>
                  {hosts.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.name}
                    </option>
                  ))}
                </NativeSelect>
              </>
            ) : (
              <>
                <FieldLabel htmlFor="deployment-target">
                  Container / host
                </FieldLabel>
                <NativeSelect
                  id="deployment-target"
                  required
                  value={`${config.connector_id}:${config.container_name}`}
                  onChange={(e) => {
                    const row = containers.find(
                      (r) =>
                        `${r.connector_id}:${r.data.name}` === e.target.value,
                    )
                    if (row)
                      setConfig((old) => ({
                        ...old,
                        connector_id: row.connector_id,
                        container_name: row.data.name,
                      }))
                  }}
                >
                  <option value="">Choose container</option>
                  {containers.map((row) => (
                    <option
                      key={`${row.connector_id}:${row.container_id}`}
                      value={`${row.connector_id}:${row.data.name}`}
                    >
                      {row.data.name} / {row.connector_name}
                    </option>
                  ))}
                </NativeSelect>
              </>
            )}
          </Field>
          <Field className="flex flex-col gap-2">
            <FieldLabel htmlFor="deployment-repository">
              GitHub repository (owner/repo)
            </FieldLabel>
            <Input
              id="deployment-repository"
              required
              placeholder="owner/repository"
              value={config.repository}
              onChange={(e) => change('repository', e.target.value)}
            />
          </Field>
          <Field className="flex flex-col gap-2">
            <FieldLabel htmlFor="deployment-branch">Branch</FieldLabel>
            <Input
              id="deployment-branch"
              required
              value={config.branch}
              onChange={(e) => change('branch', e.target.value)}
            />
          </Field>
          <Field data-disabled={!!serviceType} className="flex flex-col gap-2">
            <FieldLabel htmlFor="deployment-kind">Build type</FieldLabel>
            <NativeSelect
              id="deployment-kind"
              disabled={!!serviceType}
              value={config.kind}
              onChange={(e) => {
                const kind = e.target.value as Config['kind']
                setConfig((old) => ({
                  ...old,
                  kind,
                  build_file:
                    kind === 'compose' ? 'compose.yaml' : 'Dockerfile',
                }))
              }}
            >
              <option value="dockerfile">Dockerfile</option>
              <option value="compose">Docker Compose</option>
            </NativeSelect>
          </Field>
          <Field className="flex flex-col gap-2">
            <FieldLabel htmlFor="deployment-file">
              Build file (repository-relative)
            </FieldLabel>
            <Input
              id="deployment-file"
              required
              value={config.build_file}
              onChange={(e) => change('build_file', e.target.value)}
            />
          </Field>
          <Field className="flex flex-col gap-2">
            <FieldLabel htmlFor="deployment-context">
              {config.kind === 'compose'
                ? 'Compose project directory'
                : 'Build context'}
            </FieldLabel>
            <Input
              id="deployment-context"
              required
              value={config.context}
              onChange={(e) => change('context', e.target.value)}
            />
          </Field>
          {config.kind === 'compose' && !config.managed && (
            <Field className="flex flex-col gap-2">
              <FieldLabel htmlFor="deployment-service">
                Compose service
              </FieldLabel>
              <Input
                id="deployment-service"
                required
                value={config.service}
                onChange={(e) => change('service', e.target.value)}
              />
            </Field>
          )}
        </FieldGroup>
        <Field orientation="horizontal" className="flex items-center gap-2">
          <Checkbox
            id="deployment-enabled"
            checked={config.enabled}
            onCheckedChange={(v) => change('enabled', v === true)}
          />
          <FieldLabel htmlFor="deployment-enabled">
            Automatically deploy pushes
          </FieldLabel>
        </Field>
        <ErrorMessage message={error} />
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            type="submit"
            disabled={
              busy ||
              !config.connector_id ||
              (!config.managed && !containers.length)
            }
          >
            {busy ? 'Saving…' : 'Save deployment'}
          </Button>
          {saved && (
            <span role="status" className="text-sm text-muted-foreground">
              Deployment saved.
            </span>
          )}
        </div>
      </Form>
      {url && (
        <FieldGroup className="flex flex-col gap-3   pt-5">
          <Separator className="basis-full" />
          <h2 className="font-semibold">GitHub webhook</h2>
          <p className="text-sm text-muted-foreground">
            In repository Settings → Webhooks, add this URL with content type
            application/json, the secret below, and push events. Keep SSL
            verification enabled.
          </p>
          <Field>
            <FieldLabel htmlFor="webhook-url">Payload URL</FieldLabel>
            <Input id="webhook-url" readOnly value={url} />
          </Field>
          {secret ? (
            <Field>
              <FieldLabel htmlFor="webhook-secret">
                Secret — copy now; it is only shown once
              </FieldLabel>
              <Input id="webhook-secret" readOnly value={secret} />
            </Field>
          ) : (
            <p className="text-sm text-muted-foreground">
              The existing secret is hidden. Generate a new one if you need to
              configure the webhook again.
            </p>
          )}
          <Button type="button" disabled={busy} onClick={() => void rotate()}>
            Generate new webhook secret
          </Button>
          <p className="text-xs text-muted-foreground">
            Generating a new secret invalidates the previous secret. Update
            GitHub to match.
          </p>
        </FieldGroup>
      )}
    </Card>
  )
}
