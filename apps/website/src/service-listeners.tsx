import { useState } from 'react'
import type { ListenerConfig } from '@kloud/protocol/forwarding'
import { api, type ContainerRow } from './api'
import { usePolling, ErrorMessage } from './components'
import {
  Button,
  Checkbox,
  Input,
  Label,
  NativeSelect,
  Textarea,
} from './components/ui/controls'
import { Card } from './components/ui/card'

interface Listener {
  id: string
  connector_id: string
  config: ListenerConfig
  applied: boolean
  error: string | null
  reported: string | null
}
export function ServiceListeners({
  project,
  service,
  containers,
  canDeploy,
  compose = false,
}: {
  project: string
  service: string
  containers: ContainerRow[]
  canDeploy: boolean
  compose?: boolean
}) {
  const base = `/projects/${project}/services/${service}/listeners`
  const [refresh, setRefresh] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const { data, error: loadError } = usePolling<Listener[]>(base, refresh)
  const [editing, setEditing] = useState<Listener | null>(null)
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    const target = containers.find(
      (c) => `${c.connector_id}:${c.data.name}` === form.get('target'),
    )
    try {
      if (!target) throw new Error('Select an assigned service container')
      const sources = String(form.get('sources') || '')
        .split(/[\s,]+/)
        .filter(Boolean)
      const config = {
        protocol: form.get('protocol'),
        bind_address: form.get('bind_address'),
        port: Number(form.get('port')),
        target_port: Number(form.get('target_port')),
        network: form.get('network'),
        container: target.data.name,
        compose_service: String(form.get('compose_service') || '') || undefined,
        sources,
        enabled: form.get('enabled') === 'on',
        application_protocol: form.get('application_protocol'),
      }
      if (
        !window.confirm(
          `${config.protocol} ${config.bind_address}:${config.port} → ${target.data.name}:${config.target_port}\nSources: ${sources.length ? sources.join(', ') : 'Allow anyone'}\n${config.enabled ? 'Enable this public listener?' : 'Save disabled listener?'}`,
        )
      )
        return
      await api(`${base}/${editing?.id ?? crypto.randomUUID()}`, 'PUT', {
        connector_id: target.connector_id,
        config,
      })
      setEditing(null)
      setRefresh((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save listener')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Optional host-local TCP/UDP forwarding is independent of HTTP domains
        and VPN connectivity. The server administrator must enable forwarding
        and approve bind addresses. PostgreSQL listeners stay blocked until
        native TLS and renewal are verified. Connections may end when a release
        is replaced.
      </p>
      <ErrorMessage message={error || loadError} />
      {data?.map((listener) => (
        <Card key={listener.id} size="compact" className="space-y-2">
          <p>
            {listener.config.protocol.toUpperCase()} ·{' '}
            {listener.config.bind_address}:{listener.config.port} →{' '}
            {listener.config.container}:{listener.config.target_port}
          </p>
          <p className="text-xs text-muted-foreground">
            {listener.config.sources.length
              ? listener.config.sources.join(', ')
              : 'Allow anyone'}{' '}
            ·{' '}
            {listener.error ||
              (!listener.config.enabled
                ? 'Disabled'
                : listener.applied &&
                    listener.reported &&
                    Date.now() - Date.parse(listener.reported) < 20000
                  ? 'Applied'
                  : 'Pending / stale')}
          </p>
          {canDeploy && (
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => setEditing(listener)}>
                Edit
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      'Remove this listener and disable its public access?',
                    )
                  )
                    return
                  setBusy(true)
                  try {
                    await api(`${base}/${listener.id}`, 'DELETE')
                    setRefresh((n) => n + 1)
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : 'Unable to remove listener',
                    )
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Remove
              </Button>
            </div>
          )}
        </Card>
      ))}
      {canDeploy && (
        <form key={editing?.id ?? 'new'} onSubmit={save}>
          <Card className="space-y-3">
            <h2 className="font-semibold">
              {editing ? 'Edit listener' : 'Add listener'}
            </h2>
            <fieldset disabled={busy} className="space-y-3">
              <Label>
                Service container
                <NativeSelect
                  name="target"
                  required
                  defaultValue={
                    editing
                      ? `${editing.connector_id}:${editing.config.container}`
                      : ''
                  }
                >
                  <option value="">Choose an assigned container</option>
                  {containers.map((c) => (
                    <option
                      key={c.container_id}
                      value={`${c.connector_id}:${c.data.name}`}
                    >
                      {c.data.name} · {c.connector_name}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
              <div className="grid gap-3 sm:grid-cols-3">
                <Label>
                  Protocol
                  <NativeSelect
                    name="protocol"
                    defaultValue={editing?.config.protocol ?? 'tcp'}
                  >
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </NativeSelect>
                </Label>
                <Label>
                  Public bind address
                  <Input
                    name="bind_address"
                    required
                    defaultValue={editing?.config.bind_address ?? ''}
                    placeholder="Administrator-approved host IP"
                  />
                </Label>
                <Label>
                  Public port
                  <Input
                    name="port"
                    type="number"
                    min={1024}
                    max={65535}
                    required
                    defaultValue={editing?.config.port}
                  />
                </Label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Label>
                  Target internal port
                  <Input
                    name="target_port"
                    type="number"
                    min={1}
                    max={65535}
                    required
                    defaultValue={editing?.config.target_port}
                  />
                </Label>
                <Label>
                  Docker network
                  <Input
                    name="network"
                    required
                    defaultValue={editing?.config.network}
                  />
                </Label>
              </div>
              {compose && (
                <Label>
                  Compose service key
                  <Input
                    name="compose_service"
                    required
                    defaultValue={editing?.config.compose_service ?? ''}
                    placeholder="web"
                  />
                  <span className="text-xs text-muted-foreground">
                    The committed Compose service key lets this listener follow
                    container replacement.
                  </span>
                </Label>
              )}
              <Label>
                Application protocol
                <NativeSelect
                  name="application_protocol"
                  defaultValue={
                    editing?.config.application_protocol ?? 'generic'
                  }
                >
                  <option value="generic">Generic application</option>
                  <option value="postgresql">
                    PostgreSQL (native TLS prerequisites required)
                  </option>
                </NativeSelect>
              </Label>
              <Label>
                Source IPv4 / IPv6 CIDRs
                <Textarea
                  name="sources"
                  rows={3}
                  defaultValue={editing?.config.sources.join('\n') ?? ''}
                  placeholder="Allow anyone (empty list). Otherwise one CIDR per line."
                />
                <span className="text-xs text-muted-foreground">
                  An empty list means Allow anyone. Invalid CIDRs block saving.
                </span>
              </Label>
              <Label className="flex items-center gap-2">
                <Input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={editing?.config.enabled ?? false}
                />
                Enable listener
              </Label>
              <Button>Save listener</Button>
              {editing && (
                <Button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              )}
            </fieldset>
          </Card>
        </form>
      )}
    </div>
  )
}
