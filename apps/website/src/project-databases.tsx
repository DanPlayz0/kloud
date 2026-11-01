import { CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { FieldGroup, FieldSet, Field, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { DatabaseAccess } from './database-access'
import { useState, type FormEvent } from 'react'
import { Database, Download, RotateCcw, ShieldCheck, Plus } from 'lucide-react'
import { api } from './api'
import { ErrorMessage, usePolling, bytes } from './components'
import { Card } from './components/ui/card'
import {
  Button,
  Input,
  NativeSelect,
  Textarea,
  Checkbox,
} from './components/ui/controls'
import { StatusBadge } from './components/ui/status-badge'

interface Resource {
  id: string
  name: string
  slug: string
  connector_id: string
  state: string
  version: string
  permissions: Record<string, boolean>
}
interface List {
  resources: Resource[]
  can_create: boolean
  can_restore: boolean
  can_destinations: boolean
  can_manage_access: boolean
}
interface Destination {
  id: string
  name: string
  kind: 'disk' | 's3'
  connector_id: string
}
interface Policy {
  id: string
  name: string
  enabled: boolean
  next_run: string
  config: any
}
interface Detail {
  runtime?: {
    state: string
    health: string | null
    seen: string
    stale: boolean
  } | null
  jobs: {
    id: string
    kind: string
    state: string
    created: string
    log: string
    result: any
    has_import?: boolean
  }[]
  archives: {
    id: string
    state: string
    destination_name: string
    metadata: any
    created: string
  }[]
  policies: Policy[]
}
interface Host {
  id: string
  name: string
  seen: string | null
}
export function ProjectDatabases({ project }: { project: string }) {
  const base = `/projects/${project}/databases`
  const [refresh, setRefresh] = useState(0),
    [selected, setSelected] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const { data, error: loadError } = usePolling<List>(base, refresh)
  const { data: hosts } = usePolling<Host[]>(`${base}/hosts/list`)
  const { data: destinations } = usePolling<Destination[]>(
    `${base}/destinations/list`,
    refresh,
  )
  const { data: detail } = usePolling<Detail>(
    selected ? `${base}/${selected}` : null,
    refresh,
  )
  const resource = data?.resources.find((r) => r.id === selected)
  async function action(path: string, body: unknown) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api(base + path, 'POST', body)
      setRefresh((n) => n + 1)
      setMessage(
        'Operation queued. The selected host reports its outcome below.',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed')
    } finally {
      setBusy(false)
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const value = await api<{ resource: string }>(base, 'POST', {
        slug: form.get('slug'),
        name: form.get('name'),
        connector_id: form.get('connector'),
        version: '17.6',
        request_key: crypto.randomUUID(),
      })
      setSelected(value.resource)
      setRefresh((n) => n + 1)
      setMessage('PostgreSQL creation queued. No public ports are published.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create database')
    } finally {
      setBusy(false)
    }
  }
  async function importArchive(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget),
      file = form.get('archive') as File
    if (!file?.size) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api${base}/imports`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/octet-stream',
          'x-target-slug': String(form.get('slug')),
          'x-target-name': String(form.get('name')),
          'x-connector-id': String(form.get('connector')),
          'x-request-key': crypto.randomUUID(),
        },
        body: file,
      })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error ?? 'Import failed')
      setSelected(value.resource)
      setRefresh((n) => n + 1)
      setMessage(
        'Archive import queued into a new database. The source is retained; application connection strings are unchanged.',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to import')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="admin-content flex flex-col gap-6">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROJECT DATABASES</p>
          <h1 className="flex items-center gap-2">
            <Database size={24} />
            PostgreSQL
          </h1>
          <p className="text-muted-foreground">
            Private databases, verified custom archives, and restore into new
            resources.
          </p>
        </div>
      </div>
      <ErrorMessage message={error || loadError} />
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      <Card className="flex flex-col gap-3">
        <CardHeader>
          <CardTitle asChild>
            <h2 className="font-semibold">Databases</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!data?.resources.length && (
            <p className="text-muted-foreground">
              No managed databases are available.
            </p>
          )}
          <ToggleGroup
            type="single"
            value={selected}
            spacing={2}
            className="flex-wrap"
            aria-label="Database"
            onValueChange={(value) => {
              if (value) setSelected(value)
            }}
          >
            {data?.resources.map((r) => (
              <ToggleGroupItem key={r.id} value={r.id}>
                {r.name} · {r.state}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            Data volumes and backups are independent of application deletion.
            Public access is disabled; use the database network or configured
            private connectivity.
          </p>
        </CardContent>
      </Card>
      {data?.can_manage_access && (
        <DatabaseAccess project={project} resources={data.resources} />
      )}
      {data?.can_create && (
        <Card className="flex flex-col gap-3">
          <CardHeader>
            <CardTitle asChild>
              <h2 className="font-semibold">Create PostgreSQL 17.6</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Form onSubmit={create}>
              <FieldSet disabled={busy} className="grid gap-3 md:grid-cols-2">
                <Field>
                  <FieldLabel>Name</FieldLabel>
                  <Input name="name" required maxLength={100} />
                </Field>
                <Field>
                  <FieldLabel>Resource slug</FieldLabel>
                  <Input
                    name="slug"
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    maxLength={80}
                  />
                </Field>
                <DatabaseHost hosts={hosts ?? []} />
                <Button variant="primary">
                  <Plus data-icon="inline-start" />
                  Create private database
                </Button>
              </FieldSet>
            </Form>
          </CardContent>
        </Card>
      )}
      {data?.can_restore && (
        <Card className="flex flex-col gap-3">
          <CardHeader>
            <CardTitle asChild>
              <h2 className="font-semibold">
                Import an existing PostgreSQL export
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Upload a single-database custom-format .dmp/.dump archive (PGDMP),
              up to 64 MiB. Archive versions and extensions are checked before
              restore. A new resource is always created; existing targets are
              preserved.
            </p>
            <Form onSubmit={importArchive}>
              <FieldSet disabled={busy} className="grid gap-3 md:grid-cols-2">
                <Field>
                  <FieldLabel>New database name</FieldLabel>
                  <Input name="name" required />
                </Field>
                <Field>
                  <FieldLabel>New resource slug</FieldLabel>
                  <Input
                    name="slug"
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  />
                </Field>
                <DatabaseHost hosts={hosts ?? []} />
                <Field>
                  <FieldLabel>Custom archive</FieldLabel>
                  <Input
                    type="file"
                    name="archive"
                    required
                    accept=".dmp,.dump"
                  />
                </Field>
                <Button>
                  <Download data-icon="inline-start" />
                  Import into new database
                </Button>
              </FieldSet>
            </Form>
          </CardContent>
        </Card>
      )}
      {data?.can_destinations && (
        <BackupDestination
          base={base}
          hosts={hosts ?? []}
          onSaved={() => setRefresh((n) => n + 1)}
        />
      )}
      {data?.can_destinations && !!destinations?.length && (
        <Card className="flex flex-col gap-3">
          <CardHeader>
            <CardTitle asChild>
              <h2 className="font-semibold">Destination connection tests</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Select a database on the destination host. The test writes, reads,
              verifies and deletes an isolated test object; results appear in
              that database's operation history.
            </p>
            {destinations.map((destination) => (
              <div
                key={destination.id}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span>
                  {destination.name} · {destination.kind}
                </span>
                <Button
                  disabled={
                    busy ||
                    !resource ||
                    resource.connector_id !== destination.connector_id
                  }
                  onClick={() =>
                    void action(`/destinations/${destination.id}/test`, {
                      resource: selected,
                      request_key: crypto.randomUUID(),
                    })
                  }
                >
                  Test destination
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {resource && detail && (
        <>
          <Card className="flex flex-col gap-4">
            <CardHeader>
              <CardTitle asChild>
                <h2 className="font-semibold">
                  {resource.name} · <StatusBadge>{resource.state}</StatusBadge>
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                PostgreSQL {resource.version}. Authentication role has no
                superuser, role-creation, or database-creation privileges.
              </p>
              <p className="text-sm text-muted-foreground">
                Observed runtime:{' '}
                {detail.runtime && !detail.runtime.stale
                  ? `${detail.runtime.state} · ${detail.runtime.health ?? 'health check unavailable'}`
                  : 'awaiting current connector inventory'}
              </p>
              <div className="flex flex-wrap gap-2">
                {['start', 'stop', 'restart', 'logs']
                  .filter((a) =>
                    a === 'logs'
                      ? resource.permissions.read
                      : resource.permissions.manage,
                  )
                  .map((a) => (
                    <Button
                      key={a}
                      disabled={busy}
                      onClick={() => {
                        if (a === 'stop' || a === 'restart') {
                          if (
                            !window.confirm(
                              `${a} this database? Active applications may be interrupted.`,
                            )
                          )
                            return
                        }
                        void action(`/${selected}/operations`, {
                          action: a,
                          request_key: crypto.randomUUID(),
                        })
                      }}
                    >
                      {a}
                    </Button>
                  ))}
              </div>
              {resource.permissions.reveal && (
                <CredentialReveal path={`${base}/${selected}/credentials`} />
              )}
            </CardContent>
          </Card>
          {resource.permissions.backup && (
            <BackupPolicy
              key={resource.id}
              resource={resource}
              base={base}
              destinations={(destinations ?? []).filter(
                (d) => d.connector_id === resource.connector_id,
              )}
              onSaved={() => setRefresh((n) => n + 1)}
            />
          )}
          <Card className="flex flex-col gap-3">
            <CardHeader>
              <CardTitle asChild>
                <h2 className="font-semibold">Backup policies</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {detail.policies.map((p) => (
                <div
                  key={p.id}
                  className="rounded border border-border p-3 flex flex-col gap-2"
                >
                  <p>
                    {p.name} · {p.enabled ? 'Scheduled' : 'On demand'} ·{' '}
                    {p.config.timezone}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {p.config.cron} · next{' '}
                    {new Date(p.next_run).toLocaleString()}
                  </p>
                  {resource.permissions.backup && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setBusy(true)
                        setError('')
                        void api(
                          `${base}/${selected}/policies/${p.id}`,
                          'PUT',
                          {
                            enabled: !p.enabled,
                          },
                        )
                          .then(() => setRefresh((n) => n + 1))
                          .catch((e) => setError(e.message))
                          .finally(() => setBusy(false))
                      }}
                    >
                      {p.enabled ? 'Disable schedule' : 'Enable schedule'}
                    </Button>
                  )}
                  {resource.permissions.backup && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(`/${selected}/backups`, {
                          policy: p.id,
                          request_key: crypto.randomUUID(),
                        })
                      }
                    >
                      Back up now
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="flex flex-col gap-3">
            <CardHeader>
              <CardTitle asChild>
                <h2 className="font-semibold">Restore points</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!detail.archives.length && (
                <p className="text-sm text-muted-foreground">
                  No backup artifacts have been recorded.
                </p>
              )}
              {detail.archives.map((a) => (
                <div
                  key={a.id}
                  className="rounded border border-border p-3 flex flex-col gap-2"
                >
                  <p>
                    {a.destination_name} · {a.state} ·{' '}
                    {new Date(a.created).toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {bytes(a.metadata.size ?? 0)} · PostgreSQL{' '}
                    {a.metadata.sourceVersion ?? 'unknown'} ·{' '}
                    {a.metadata.format ?? 'custom'}
                  </p>
                  {a.metadata.error && (
                    <ErrorMessage message={a.metadata.error} />
                  )}{' '}
                  {resource.permissions.restore && a.state === 'complete' && (
                    <RestoreForm
                      base={base}
                      source={selected}
                      archive={a.id}
                      hosts={hosts ?? []}
                      defaultHost={resource.connector_id}
                      onSaved={(id) => {
                        setSelected(id)
                        setRefresh((n) => n + 1)
                      }}
                    />
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="flex flex-col gap-3">
            <CardHeader>
              <CardTitle asChild>
                <h2 className="font-semibold">Operation history</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {detail.jobs.map((j) => (
                <details
                  key={j.id}
                  className="rounded border border-border p-3"
                >
                  <summary>
                    {j.kind} · {j.state} ·{' '}
                    {new Date(j.created).toLocaleString()}
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-all text-xs">
                    {j.log || JSON.stringify(j.result ?? {}, null, 2)}
                  </pre>
                  {j.kind === 'import' &&
                    j.has_import &&
                    ['failed', 'cancelled'].includes(j.state) &&
                    resource.permissions.restore && (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              'Discard the retained uploaded source archive? The database volume is unchanged. Keep your original .dmp export separately.',
                            )
                          )
                            return
                          setBusy(true)
                          void api(
                            `${base}/${selected}/imports/${j.id}`,
                            'DELETE',
                          )
                            .then(() => setRefresh((n) => n + 1))
                            .catch((e) => setError(e.message))
                            .finally(() => setBusy(false))
                        }}
                      >
                        Discard retained upload
                      </Button>
                    )}
                  {j.state === 'unknown' && (
                    <>
                      {' '}
                      <p className="text-sm text-muted-foreground">
                        The host outcome is uncertain. Automatic database
                        dispatch is paused. Inspect the host and reconcile
                        before retrying; no restore is automatically repeated.
                      </p>
                      {resource.permissions.manage && (
                        <Button
                          disabled={busy}
                          onClick={() => {
                            if (
                              !window.confirm(
                                'Inspect the host to release this pause? Any incomplete new import/restore target will be stopped and retained. The original job stays failed; it is never repeated or marked successful.',
                              )
                            )
                              return
                            void action(`/${selected}/reconcile`, {
                              unknown_job: j.id,
                              request_key: crypto.randomUUID(),
                              confirm: true,
                            })
                          }}
                        >
                          Inspect and reconcile host
                        </Button>
                      )}
                    </>
                  )}
                </details>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </section>
  )
}
function DatabaseHost({
  hosts,
  defaultValue,
}: {
  hosts: Host[]
  defaultValue?: string
}) {
  return (
    <Field>
      <FieldLabel>Database host</FieldLabel>
      <NativeSelect name="connector" required defaultValue={defaultValue ?? ''}>
        <option value="">Select PostgreSQL-enabled host</option>
        {hosts.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  )
}
function CredentialReveal({ path }: { path: string }) {
  const [value, setValue] = useState(''),
    [error, setError] = useState('')
  return (
    <div className="flex flex-col gap-2">
      <Button
        onClick={() => {
          if (value) {
            setValue('')
            return
          }
          if (!window.confirm('Reveal database credentials in this browser?'))
            return
          void api<Record<string, unknown>>(path)
            .then((v) => setValue(JSON.stringify(v, null, 2)))
            .catch((e) => setError(e.message))
        }}
      >
        <ShieldCheck data-icon="inline-start" />
        {value ? 'Hide credentials' : 'Reveal connection details'}
      </Button>
      <ErrorMessage message={error} />
      {value && (
        <Textarea
          readOnly
          value={value}
          rows={8}
          aria-label="Database credentials"
        />
      )}
    </div>
  )
}
function BackupDestination({
  base,
  hosts,
  onSaved,
}: {
  base: string
  hosts: Host[]
  onSaved: () => void
}) {
  const [kind, setKind] = useState('disk'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const f = new FormData(e.currentTarget)
    try {
      await api(`${base}/destinations`, 'POST', {
        name: f.get('name'),
        connector_id: f.get('connector'),
        config:
          kind === 'disk'
            ? { kind, root: f.get('root') }
            : {
                kind,
                endpoint: f.get('endpoint'),
                region: f.get('region'),
                bucket: f.get('bucket'),
                prefix: f.get('prefix'),
                accessKey: f.get('accessKey'),
                secretKey: f.get('secretKey'),
              },
      })
      onSaved()
      e.currentTarget?.reset()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save destination')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="flex flex-col gap-3">
      <CardHeader>
        <CardTitle asChild>
          <h2 className="font-semibold">Add backup destination</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ErrorMessage message={error} />
        <Form onSubmit={save}>
          <FieldSet disabled={busy} className="grid gap-3 md:grid-cols-2">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input name="name" required />
            </Field>
            <DatabaseHost hosts={hosts} />
            <Field>
              <FieldLabel>Storage</FieldLabel>
              <NativeSelect
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="disk">Host disk</option>
                <option value="s3">S3-compatible storage</option>
              </NativeSelect>
            </Field>
            {kind === 'disk' ? (
              <Field>
                <FieldLabel>
                  Existing directory under BACKUP_DISK_ROOT
                </FieldLabel>
                <Input
                  name="root"
                  required
                  placeholder="/var/lib/kloud/backups"
                />
              </Field>
            ) : (
              <>
                {[
                  'endpoint',
                  'region',
                  'bucket',
                  'prefix',
                  'accessKey',
                  'secretKey',
                ].map((k) => (
                  <Field key={k}>
                    <FieldLabel>{k}</FieldLabel>
                    <Input
                      name={k}
                      required
                      type={k === 'secretKey' ? 'password' : 'text'}
                      defaultValue={k === 'prefix' ? 'kloud' : undefined}
                    />
                  </Field>
                ))}
              </>
            )}
            <Button>Save encrypted destination</Button>
          </FieldSet>
        </Form>
      </CardContent>
    </Card>
  )
}
function BackupPolicy({
  resource,
  base,
  destinations,
  onSaved,
}: {
  resource: Resource
  base: string
  destinations: Destination[]
  onSaved: () => void
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [cron, setCron] = useState('0 2 * * *'),
    [enabled, setEnabled] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<any>(null),
    [body, setBody] = useState<any>(null),
    [busy, setBusy] = useState(false)
  async function review(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const f = new FormData(e.currentTarget)
    const value = {
      name: f.get('name'),
      cron,
      timezone: f.get('timezone'),
      enabled,
      destinations: selected.map((id) => ({
        destination: id,
        maxBytes: Number(f.get(`max-${id}`)),
        minimumPoints: Number(f.get(`minimum-${id}`)),
        reserveBytes: Number(f.get(`reserve-${id}`)),
      })),
    }
    try {
      const p = await api(
        `${base}/${resource.id}/policies/preview`,
        'POST',
        value,
      )
      setBody(value)
      setPreview(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to preview schedule')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="flex flex-col gap-3">
      <CardHeader>
        <CardTitle asChild>
          <h2 className="font-semibold">Configure backup policy</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ErrorMessage message={error} />
        <Form onSubmit={review} onChange={() => setPreview(null)}>
          <FieldSet disabled={busy} className="flex flex-col gap-3">
            <Field>
              <FieldLabel>Policy name</FieldLabel>
              <Input name="name" required />
            </Field>
            <Field>
              <FieldLabel>Schedule preset</FieldLabel>
              <NativeSelect onChange={(e) => setCron(e.target.value)}>
                <option value="0 2 * * *">Daily at 02:00</option>
                <option value="0 2 * * 0">Weekly Sunday at 02:00</option>
                <option value="0 2 1 * *">Monthly on day 1 at 02:00</option>
                <option value={cron}>Custom cron below</option>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel>Cron</FieldLabel>
              <Input
                required
                value={cron}
                onChange={(e) => setCron(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Timezone</FieldLabel>
              <Input
                name="timezone"
                required
                defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
              />
            </Field>
            <Field orientation="horizontal" className="flex items-center gap-2">
              <Checkbox
                checked={enabled}
                onCheckedChange={(v) => {
                  setEnabled(v === true)
                  setPreview(null)
                }}
              />
              <FieldLabel>Enable scheduled backups</FieldLabel>
            </Field>
            {destinations.map((d) => (
              <FieldGroup
                key={d.id}
                className="rounded border border-border p-3 flex flex-col gap-2"
              >
                <Field
                  orientation="horizontal"
                  className="flex items-center gap-2"
                >
                  <Checkbox
                    checked={selected.includes(d.id)}
                    onCheckedChange={(v) => {
                      setSelected(
                        v
                          ? [...selected, d.id]
                          : selected.filter((x) => x !== d.id),
                      )
                      setPreview(null)
                    }}
                  />
                  <FieldLabel>
                    {d.name} ({d.kind})
                  </FieldLabel>
                </Field>
                {selected.includes(d.id) && (
                  <FieldGroup className="grid gap-3 md:grid-cols-3">
                    <Field>
                      <FieldLabel>Storage limit (bytes)</FieldLabel>
                      <Input
                        type="number"
                        name={`max-${d.id}`}
                        required
                        min={1}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Minimum restore points</FieldLabel>
                      <Input
                        type="number"
                        name={`minimum-${d.id}`}
                        required
                        min={1}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Free-space reserve (bytes)</FieldLabel>
                      <Input
                        type="number"
                        name={`reserve-${d.id}`}
                        required
                        min={0}
                      />
                    </Field>
                  </FieldGroup>
                )}
              </FieldGroup>
            ))}
            <p className="text-xs text-muted-foreground">
              Set explicit limits and minimum points for each destination.
              Minimum points are protected even when that prevents a backup
              under the storage cap. Use one disk destination, one S3
              destination, or both.
            </p>
            <Button disabled={!selected.length}>Review effective policy</Button>
          </FieldSet>
        </Form>
        {preview && (
          <div className="flex flex-col gap-2">
            <pre className="whitespace-pre-wrap break-all text-xs">
              {JSON.stringify({ ...preview, enabled }, null, 2)}
            </pre>
            <Button
              disabled={busy}
              variant="primary"
              onClick={() => {
                setBusy(true)
                void api(`${base}/${resource.id}/policies`, 'POST', body)
                  .then(() => {
                    onSaved()
                    setPreview(null)
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false))
              }}
            >
              Confirm backup policy
            </Button>
            <Button onClick={() => setPreview(null)}>Cancel</Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
function RestoreForm({
  base,
  source,
  archive,
  hosts,
  defaultHost,
  onSaved,
}: {
  base: string
  source: string
  archive: string
  hosts: Host[]
  defaultHost: string
  onSaved: (id: string) => void
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function restore(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (
      !window.confirm(
        'Restore this backup into a new database? The source and existing databases are unchanged. Application connection strings must be changed separately.',
      )
    )
      return
    const f = new FormData(e.currentTarget)
    setBusy(true)
    try {
      const result = await api<{ resource: string }>(
        `${base}/${source}/restores`,
        'POST',
        {
          slug: f.get('slug'),
          name: f.get('name'),
          connector_id: f.get('connector'),
          version: '17.6',
          request_key: crypto.randomUUID(),
          archive,
        },
      )
      onSaved(result.resource)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <Button onClick={() => setOpen(!open)}>
        <RotateCcw data-icon="inline-start" />
        Restore into new database
      </Button>
      {open && (
        <Form onSubmit={restore}>
          <FieldSet disabled={busy} className="flex flex-col gap-2 mt-3">
            <Field>
              <FieldLabel>New name</FieldLabel>
              <Input name="name" required />
            </Field>
            <Field>
              <FieldLabel>New resource slug</FieldLabel>
              <Input name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" required />
            </Field>
            <DatabaseHost hosts={hosts} defaultValue={defaultHost} />
            <ErrorMessage message={error} />
            <Button>Queue restore</Button>
          </FieldSet>
        </Form>
      )}
    </div>
  )
}
