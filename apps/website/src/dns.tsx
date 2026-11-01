import { TableCard, Card } from './components/ui/card'
import { useEffect, useState, type FormEvent } from 'react'
import { Globe, Plus, Trash2, Pencil } from 'lucide-react'
import {
  dnsActions,
  dnsFields,
  dnsTypes,
  dnsRecordSchema,
  type DnsAction,
  type DnsRule,
  type DnsGrant,
  type DnsRecord,
  type DnsLiveRecord,
} from '@kloud/protocol/dns'
import { api, type Project, type User } from './api'
import { Shell, ErrorMessage, usePolling } from './components'
import {
  Button,
  Input,
  Label,
  NativeSelect,
  Checkbox,
} from './components/ui/controls'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './components/ui/dialog'

type ZoneChoice = {
  id: string
  name: string
  provider_name: string
  origin: string
}
type ZoneRecords = { records: DnsLiveRecord[]; creation_scopes: DnsRule[] }
type Provider = { id: string; name: string; enabled: boolean }
type ManagedZone = {
  id: string
  name: string
  delegations: { project: string; rules: DnsRule[] }[]
}
const fullRule = (): DnsRule => ({
  kind: 'zone',
  target: null,
  types: [...dnsTypes],
  actions: [...dnsActions],
})
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Request failed'

function writeScopesOverlap(a: DnsRule, b: DnsRule, records: DnsLiveRecord[]) {
  if (
    !a.actions.some((v) => v !== 'read') ||
    !b.actions.some((v) => v !== 'read') ||
    !a.types.some((t) => b.types.includes(t))
  )
    return false
  if (a.kind === 'zone' || b.kind === 'zone') return true
  if (a.kind === 'record' || b.kind === 'record') {
    if (a.kind === 'record' && b.kind === 'record') return a.target === b.target
    const id = a.kind === 'record' ? a : b,
      scope = a.kind === 'record' ? b : a,
      record = records.find((r) => r.id === id.target)
    return (
      !!record &&
      scope.types.includes(record.type) &&
      id.types.includes(record.type) &&
      (scope.kind === 'name'
        ? record.name === scope.target
        : record.name === scope.target ||
          record.name.endsWith(`.${scope.target}`))
    )
  }
  if (a.kind === 'name' && b.kind === 'name') return a.target === b.target
  if (a.kind === 'name')
    return a.target === b.target || a.target!.endsWith(`.${b.target}`)
  if (b.kind === 'name')
    return b.target === a.target || b.target!.endsWith(`.${a.target}`)
  return (
    a.target === b.target ||
    a.target!.endsWith(`.${b.target}`) ||
    b.target!.endsWith(`.${a.target}`)
  )
}

export function DnsRuleEditor({
  rules,
  onChange,
  records = [],
  allowed = [fullRule()],
}: {
  rules: DnsRule[]
  onChange: (rules: DnsRule[]) => void
  records?: DnsLiveRecord[]
  allowed?: DnsRule[]
}) {
  const [kind, setKind] = useState<DnsRule['kind']>(allowed[0]?.kind ?? 'zone'),
    [target, setTarget] = useState(allowed[0]?.target ?? '')
  const availableTypes = dnsTypes.filter((t) =>
    allowed.some((r) => r.types.includes(t)),
  )
  const availableActions = dnsActions.filter(
    (a) =>
      (kind !== 'record' || a !== 'create') &&
      allowed.some((r) => r.actions.includes(a)),
  )
  const [types, setTypes] = useState<string[]>([]),
    [actions, setActions] = useState<DnsAction[]>(['read'])
  return (
    <div className="space-y-3 min-w-0">
      <ul className="space-y-2">
        {rules.map((r, i) => (
          <li
            key={i}
            className="flex flex-wrap items-center gap-3 rounded border border-border p-3 text-sm"
          >
            <span className="min-w-0 flex-1 break-all">
              {r.kind === 'zone' ? 'Whole zone' : `${r.kind}: ${r.target}`} ·{' '}
              {r.types.join(', ')} · {r.actions.join(', ')}
            </span>
            <Button
              type="button"
              aria-label={`Remove DNS rule ${i + 1}`}
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-3">
        <Label>
          Scope
          <NativeSelect
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as DnsRule['kind'])
              setTarget('')
            }}
          >
            {allowed.some((r) => r.kind === 'zone') && (
              <option value="zone">Whole zone</option>
            )}
            <option value="name">Exact name</option>
            {allowed.some((r) => r.kind === 'zone' || r.kind === 'subtree') && (
              <option value="subtree">Name and descendants</option>
            )}
            <option value="record">Existing record</option>
          </NativeSelect>
        </Label>
        {kind === 'record' ? (
          <Label>
            Record
            <NativeSelect
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Choose record</option>
              {records.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.type} · {r.content ?? r.id}
                </option>
              ))}
            </NativeSelect>
          </Label>
        ) : (
          kind !== 'zone' && (
            <Label>
              Fully qualified DNS name
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="voice.example.com"
              />
            </Label>
          )
        )}
      </div>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="text-sm text-muted-foreground mb-2">
          Record types
        </legend>
        {availableTypes.map((type) => (
          <Label key={type} className="checkbox">
            <Checkbox
              checked={types.includes(type)}
              onCheckedChange={(checked) =>
                setTypes(
                  checked ? [...types, type] : types.filter((t) => t !== type),
                )
              }
            />
            {type}
          </Label>
        ))}
      </fieldset>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="text-sm text-muted-foreground mb-2">Actions</legend>
        {availableActions.map((action) => (
          <Label key={action} className="checkbox">
            <Checkbox
              checked={actions.includes(action)}
              onCheckedChange={(checked) =>
                setActions(
                  checked
                    ? [...actions, action]
                    : actions.filter((a) => a !== action),
                )
              }
            />
            {action}
          </Label>
        ))}
      </fieldset>
      <Button
        type="button"
        disabled={
          !types.length ||
          !actions.some((a) => availableActions.includes(a)) ||
          (kind !== 'zone' && !target)
        }
        onClick={() => {
          onChange([
            ...rules,
            {
              kind,
              target: kind === 'zone' ? null : target,
              types: types.filter((t) => availableTypes.includes(t)),
              actions: actions.filter((a) => availableActions.includes(a)),
            },
          ])
        }}
      >
        <Plus size={14} />
        Add DNS rule
      </Button>
      <p className="text-sm text-muted-foreground">
        Write actions include read. Exact and subtree rules include future
        matching records. Wildcard names are literal.
      </p>
    </div>
  )
}

export function DnsProviders({
  projects,
  project,
}: {
  projects: Project[]
  project?: string
}) {
  const base = project
    ? `/projects/${project}/dns/providers`
    : '/admin/dns/providers'
  const [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const { data, error: loadError } = usePolling<Provider[]>(base, revision)
  const projectChoices = usePolling<Project[]>(
    project ? null : '/admin/dns/projects',
  )
  const [selected, setSelected] = useState('')
  async function action(path: string, method: string, body?: unknown) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api(path, method, body)
      setRevision((n) => n + 1)
      setNotice('Changes saved.')
      return true
    } catch (e) {
      setError(message(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-5">
      <ErrorMessage message={error || loadError || projectChoices.error} />
      {notice && <p role="status">{notice}</p>}
      <p className="text-muted-foreground">
        Connect a Cloudflare API token with Zone Read and DNS Read/Edit for the
        zones you want to manage. Discover zones, then explicitly grant project
        access.
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          const form = e.currentTarget,
            values = new FormData(form)
          if (
            await action(base, 'POST', {
              name: values.get('name'),
              token: values.get('token'),
            })
          )
            form.reset()
        }}
      >
        <Label>
          Connection name
          <Input required name="name" maxLength={100} />
        </Label>
        <Label>
          API token
          <Input
            required
            name="token"
            type="password"
            autoComplete="new-password"
          />
        </Label>
        <Button disabled={busy}>Connect provider</Button>
      </form>
      {!data && !loadError && <p>Loading providers…</p>}
      {data?.length === 0 && (
        <p className="text-muted-foreground">No DNS providers connected.</p>
      )}
      {data?.map((p) => (
        <Card size="compact" className="space-y-3" key={p.id}>
          <div className="flex flex-wrap gap-3 items-center">
            <Globe size={18} />
            <strong>{p.name}</strong>
            <span className="text-muted-foreground">
              {p.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <Button
              disabled={busy}
              onClick={() => void action(`${base}/${p.id}/test`, 'POST')}
            >
              Test connection
            </Button>
            <Button
              disabled={busy}
              onClick={() => void action(`${base}/${p.id}/discover`, 'POST')}
            >
              Discover zones
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void action(`${base}/${p.id}`, 'PUT', { enabled: !p.enabled })
              }
            >
              {p.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button onClick={() => setSelected(selected === p.id ? '' : p.id)}>
              {selected === p.id ? 'Close zones' : 'Manage zones'}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(`Disconnect ${p.name}? Live DNS records will remain.`)
                )
                  void action(`${base}/${p.id}`, 'DELETE')
              }}
            >
              Disconnect
            </Button>
          </div>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault()
              const form = e.currentTarget,
                values = new FormData(form),
                token = String(values.get('token') ?? '')
              if (
                await action(`${base}/${p.id}`, 'PUT', {
                  name: values.get('name'),
                  ...(token ? { token } : {}),
                })
              )
                form.reset()
            }}
          >
            <Label>
              Name
              <Input name="name" required defaultValue={p.name} />
            </Label>
            <Label>
              Replace token
              <Input
                name="token"
                type="password"
                autoComplete="new-password"
                placeholder="Leave blank to keep token"
              />
            </Label>
            <Button disabled={busy}>Save connection</Button>
          </form>
          {selected === p.id && (
            <ProviderZones
              base={`${base}/${p.id}`}
              projects={
                project
                  ? projects.filter((p) => p.slug === project)
                  : (projectChoices.data ?? projects)
              }
              revision={revision}
              action={action}
              disabled={busy}
            />
          )}
        </Card>
      ))}
    </div>
  )
}

function ProviderZones({
  base,
  projects,
  revision,
  action,
  disabled,
}: {
  base: string
  projects: Project[]
  revision: number
  action: (path: string, method: string, body?: unknown) => Promise<boolean>
  disabled: boolean
}) {
  const { data, error } = usePolling<ManagedZone[]>(`${base}/zones`, revision)
  const [zone, setZone] = useState(''),
    [target, setTarget] = useState(''),
    [editing, setEditing] = useState(false)
  const current = data?.find((z) => z.id === zone)
  const live = usePolling<DnsLiveRecord[]>(
    current && current.delegations.length > 1
      ? `${base}/zones/${zone}/records`
      : null,
    revision,
  )
  const overlaps =
    current?.delegations.flatMap((a, i) =>
      current.delegations
        .slice(i + 1)
        .filter((b) =>
          a.rules.some((ar) =>
            b.rules.some((br) => writeScopesOverlap(ar, br, live.data ?? [])),
          ),
        )
        .map(
          (b) =>
            `${projects.find((p) => p.slug === a.project)?.name ?? a.project} and ${projects.find((p) => p.slug === b.project)?.name ?? b.project}`,
        ),
    ) ?? []
  return (
    <div className="space-y-4 border-t border-border pt-4">
      <ErrorMessage message={error} />
      <Label>
        Discovered zone
        <NativeSelect
          value={zone}
          onChange={(e) => {
            setZone(e.target.value)
            setEditing(false)
          }}
        >
          <option value="">Choose zone</option>
          {data?.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </NativeSelect>
      </Label>
      {data?.length === 0 && (
        <p>Discover zones to begin. Discovery grants no project access.</p>
      )}
      {current && (
        <>
          <h3>Project delegations</h3>
          {current.delegations.map((d) => (
            <Card size="compact" key={d.project} className="space-y-2">
              <strong>
                {projects.find((p) => p.slug === d.project)?.name ?? d.project}
              </strong>
              <ul className="text-sm text-muted-foreground">
                {d.rules.map((r, i) => (
                  <li key={i}>
                    {r.kind}: {r.target ?? current.name} · {r.types.join(', ')}{' '}
                    · {r.actions.join(', ')}
                  </li>
                ))}
              </ul>
              <Button
                disabled={disabled}
                onClick={() => {
                  setTarget(d.project)
                  setEditing(true)
                }}
              >
                Edit delegation
              </Button>
              <Button
                disabled={disabled}
                variant="destructive"
                onClick={() => {
                  if (
                    confirm(
                      'Revoke this project’s zone access? Live DNS records will remain.',
                    )
                  )
                    void action(
                      `${base}/zones/${zone}/projects/${d.project}`,
                      'PUT',
                      { rules: [] },
                    )
                }}
              >
                Revoke access
              </Button>
            </Card>
          ))}
          {current.delegations.length > 1 && (
            <p className="text-sm text-muted-foreground">
              This zone is shared. Projects with matching writable scopes edit
              the same live records.
            </p>
          )}
          {overlaps.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Overlapping write access: {overlaps.join('; ')}. These projects
              can change the same records.
            </p>
          )}
          <Label>
            Project
            <NativeSelect
              value={target}
              onChange={(e) => {
                setTarget(e.target.value)
                setEditing(false)
              }}
            >
              <option value="">Choose project</option>
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Button
            disabled={!target || disabled}
            onClick={() => setEditing(true)}
          >
            Configure access
          </Button>
          {editing && target && (
            <DelegationEditor
              key={`${zone}:${target}:${revision}`}
              base={base}
              zone={current}
              target={target}
              action={action}
              disabled={disabled}
            />
          )}
        </>
      )}
    </div>
  )
}
function DelegationEditor({
  base,
  zone,
  target,
  action,
  disabled,
}: {
  base: string
  zone: ManagedZone
  target: string
  action: (path: string, method: string, body?: unknown) => Promise<boolean>
  disabled: boolean
}) {
  const [rules, setRules] = useState(
    zone.delegations.find((d) => d.project === target)?.rules ?? [],
  )
  const records = usePolling<DnsLiveRecord[]>(
    `${base}/zones/${zone.id}/records`,
  )
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <legend className="font-medium">Access to {zone.name}</legend>
      <ErrorMessage message={records.error} />
      <DnsRuleEditor rules={rules} onChange={setRules} records={records.data} />
      <Button
        onClick={() =>
          void action(`${base}/zones/${zone.id}/projects/${target}`, 'PUT', {
            rules,
          })
        }
      >
        Save project DNS access
      </Button>
    </fieldset>
  )
}

export function DnsPage({
  user,
  projects,
  project,
}: {
  user: User
  projects: Project[]
  project: string
}) {
  const [revision, setRevision] = useState(0),
    [zone, setZone] = useState(''),
    [query, setQuery] = useState(''),
    [type, setType] = useState('')
  const [edit, setEdit] = useState<DnsLiveRecord | 'new' | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const base = `/projects/${project}/dns`,
    zones = usePolling<{ can_manage_providers: boolean; zones: ZoneChoice[] }>(
      base,
      revision,
    )
  const selected = zones.data?.zones.find((z) => z.id === zone)
  useEffect(() => {
    if (zones.data && !zones.data.zones.some((z) => z.id === zone))
      setZone(zones.data.zones[0]?.id ?? '')
  }, [zones.data, zone])
  const [showProviders, setShowProviders] = useState(false)
  return (
    <Shell
      user={user}
      projects={projects}
      project={project}
      active="dns"
      title="Networking / Cloud DNS"
    >
      <section className="admin-content space-y-5">
        <div className="page-heading">
          <div>
            <p className="eyebrow">NETWORKING</p>
            <h1>Cloud DNS</h1>
          </div>
          {zones.data?.can_manage_providers && (
            <Button onClick={() => setShowProviders(!showProviders)}>
              Private providers
            </Button>
          )}
        </div>
        <ErrorMessage message={error || zones.error} />
        {showProviders && (
          <DnsProviders project={project} projects={projects} />
        )}
        {zones.data?.zones.length === 0 && (
          <p className="text-muted-foreground">
            No domains are available. A provider owner must grant this project
            access, and members need DNS permissions.
          </p>
        )}
        <div className="flex flex-wrap gap-3 items-end">
          <Label>
            Domain
            <NativeSelect
              value={zone}
              onChange={(e) => {
                setEdit(null)
                setZone(e.target.value)
              }}
            >
              <option value="">Choose domain</option>
              {zones.data?.zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name} · {z.provider_name} ({z.origin})
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Button onClick={() => setRevision((n) => n + 1)}>Refresh</Button>
        </div>
        {selected && (
          <DnsRecords
            key={zone}
            base={`${base}/zones/${zone}/records`}
            revision={revision}
            query={query}
            setQuery={setQuery}
            type={type}
            setType={setType}
            edit={edit}
            setEdit={setEdit}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            refresh={() => setRevision((n) => n + 1)}
          />
        )}
      </section>
    </Shell>
  )
}
function DnsRecords({
  base,
  revision,
  query,
  setQuery,
  type,
  setType,
  edit,
  setEdit,
  busy,
  setBusy,
  setError,
  refresh,
}: {
  base: string
  revision: number
  query: string
  setQuery: (v: string) => void
  type: string
  setType: (v: string) => void
  edit: DnsLiveRecord | 'new' | null
  setEdit: (v: DnsLiveRecord | 'new' | null) => void
  busy: boolean
  setBusy: (v: boolean) => void
  setError: (v: string) => void
  refresh: () => void
}) {
  const { data, error } = usePolling<ZoneRecords>(base, revision)
  async function remove(record: DnsLiveRecord) {
    if (!confirm(`Delete ${record.type} ${record.name}?`)) return
    setBusy(true)
    setError('')
    try {
      await api(`${base}/${record.id}`, 'DELETE')
      refresh()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const records = data?.records.filter(
    (r) =>
      (!type || r.type === type) &&
      `${r.name} ${r.content ?? JSON.stringify(r.data)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  )
  return (
    <div className="space-y-4">
      <ErrorMessage message={error} />
      <div className="flex flex-wrap gap-3 items-end">
        <Label>
          Search records
          <Input value={query} onChange={(e) => setQuery(e.target.value)} />
        </Label>
        <Label>
          Type
          <NativeSelect value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {dnsTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </NativeSelect>
        </Label>
        {!!data?.creation_scopes.length && (
          <Button onClick={() => setEdit('new')}>
            <Plus size={14} />
            Add record
          </Button>
        )}
      </div>
      {!data && !error && <p>Loading records…</p>}
      <TableCard>
        <table className="w-full min-w-160 text-left text-sm">
          <thead className="text-muted-foreground border-b border-border">
            <tr>
              {['Type', 'Name', 'Value', 'TTL', 'Proxy', 'Actions'].map((t) => (
                <th className="p-3" key={t}>
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records?.map((r) => (
              <tr key={r.id} className="border-b border-border">
                <td className="p-3">{r.type}</td>
                <td className="p-3 break-all">{r.name}</td>
                <td className="p-3 max-w-96 break-all">
                  {r.content ?? JSON.stringify(r.data)}
                </td>
                <td className="p-3">{r.ttl === 1 ? 'Auto' : r.ttl}</td>
                <td className="p-3">{r.proxied ? 'Proxied' : 'DNS only'}</td>
                <td className="p-3">
                  <div className="flex gap-2">
                    {r.actions?.includes('update') && (
                      <Button
                        disabled={busy}
                        aria-label={`Edit ${r.type} ${r.name}`}
                        onClick={() => setEdit(r)}
                      >
                        <Pencil size={14} />
                      </Button>
                    )}
                    {r.actions?.includes('delete') && (
                      <Button
                        disabled={busy}
                        variant="destructive"
                        aria-label={`Delete ${r.type} ${r.name}`}
                        onClick={() => void remove(r)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {data && !records?.length && (
              <tr>
                <td colSpan={6} className="p-6 text-muted-foreground">
                  No matching records.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableCard>
      <Dialog
        open={edit !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEdit(null)
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogTitle>
            {edit === 'new' ? 'Add DNS record' : 'Edit DNS record'}
          </DialogTitle>
          <DialogDescription>
            Changes are applied to live DNS at the provider.
          </DialogDescription>
          {edit && (
            <DnsRecordEditor
              key={typeof edit === 'string' ? edit : edit.id}
              record={edit === 'new' ? undefined : edit}
              scopes={data?.creation_scopes ?? []}
              busy={busy}
              onSave={async (body) => {
                setBusy(true)
                setError('')
                try {
                  await api(
                    edit === 'new' ? base : `${base}/${edit.id}`,
                    edit === 'new' ? 'POST' : 'PUT',
                    body,
                  )
                  setEdit(null)
                  refresh()
                } finally {
                  setBusy(false)
                }
              }}
            />
          )}
          <Button type="button" disabled={busy} onClick={() => setEdit(null)}>
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
export function DnsRecordEditor({
  record,
  scopes,
  busy,
  onSave,
}: {
  record?: DnsLiveRecord
  scopes: DnsRule[]
  busy: boolean
  onSave: (r: DnsRecord) => Promise<void>
}) {
  const permittedTypes = record
    ? dnsTypes
    : dnsTypes.filter((t) => scopes.some((s) => s.types.includes(t)))
  const [type, setType] = useState(record?.type ?? permittedTypes[0] ?? 'A'),
    [error, setError] = useState('')
  const [name, setName] = useState(
    record?.name ?? scopes.find((s) => s.kind === 'name')?.target ?? '',
  )
  const fields = dnsFields[type] ?? {}
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    const values = new FormData(e.currentTarget)
    const structured = !Object.hasOwn(fields, 'content')
    const entries = Object.fromEntries(
      Object.entries(fields).map(([key, spec]) => [
        key,
        typeof spec === 'number' ||
        (type === 'LOC' &&
          ['altitude', 'size', 'precision_horz', 'precision_vert'].includes(
            key,
          ))
          ? Number(values.get(key))
          : String(values.get(key) ?? ''),
      ]),
    )
    const body = {
      type,
      name,
      ttl: Number(values.get('ttl')),
      ...(structured ? { data: entries } : entries),
      ...(['A', 'AAAA', 'CNAME'].includes(type)
        ? {
            proxied: values.get('proxied') === 'on',
            settings: {
              ipv4_only: values.get('ipv4_only') === 'on',
              ipv6_only: values.get('ipv6_only') === 'on',
            },
          }
        : {}),
      comment: String(values.get('comment') ?? ''),
      tags: String(values.get('tags') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }
    const parsed = dnsRecordSchema.safeParse(body)
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      )
      return
    }
    void onSave(parsed.data).catch((e) => setError(message(e)))
  }
  return (
    <form onSubmit={submit} className="space-y-4 mt-4">
      <ErrorMessage message={error} />
      <fieldset disabled={busy} className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <Label>
            Record type
            <NativeSelect
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {permittedTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </NativeSelect>
          </Label>
          <Label>
            DNS name
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Label>
        </div>
        {!record && (
          <p className="text-sm text-muted-foreground">
            Allowed creation scopes:{' '}
            {scopes
              .map(
                (s) =>
                  `${s.kind}: ${s.target ?? 'whole zone'} (${s.types.join(', ')})`,
              )
              .join('; ')}
          </p>
        )}
        <div key={type} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Object.entries(fields).map(([key, spec]) => {
            const numeric =
              typeof spec === 'number' ||
              (type === 'LOC' &&
                [
                  'altitude',
                  'size',
                  'precision_horz',
                  'precision_vert',
                ].includes(key))
            const value =
              record?.type === type
                ? (record.data?.[key] ??
                  (record as unknown as Record<string, unknown>)[key])
                : undefined
            return (
              <Label key={key}>
                {key === 'content' ? spec : key.replaceAll('_', ' ')}
                <Input
                  name={key}
                  required
                  type={numeric ? 'number' : 'text'}
                  step={numeric ? 'any' : undefined}
                  max={typeof spec === 'number' ? spec : undefined}
                  defaultValue={String(value ?? (numeric ? 0 : ''))}
                />
              </Label>
            )
          })}
        </div>
        <Label>
          TTL (1 = automatic)
          <Input
            type="number"
            required
            name="ttl"
            defaultValue={record?.ttl ?? 1}
          />
        </Label>
        {['A', 'AAAA', 'CNAME'].includes(type) && (
          <Label className="checkbox">
            <Checkbox name="proxied" defaultChecked={record?.proxied} />
            Cloudflare proxy
          </Label>
        )}
        {['A', 'AAAA', 'CNAME'].includes(type) && (
          <div className="flex flex-wrap gap-3">
            <Label className="checkbox">
              <Checkbox
                name="ipv4_only"
                defaultChecked={record?.settings?.ipv4_only}
              />
              Proxy IPv4 only
            </Label>
            <Label className="checkbox">
              <Checkbox
                name="ipv6_only"
                defaultChecked={record?.settings?.ipv6_only}
              />
              Proxy IPv6 only
            </Label>
          </div>
        )}
        <Label>
          Comment
          <Input name="comment" defaultValue={record?.comment ?? ''} />
        </Label>
        <Label>
          Tags (comma-separated)
          <Input name="tags" defaultValue={record?.tags?.join(', ') ?? ''} />
        </Label>
        <Button disabled={busy} type="submit">
          {busy ? 'Saving…' : 'Save DNS record'}
        </Button>
      </fieldset>
    </form>
  )
}

export function DnsMemberGrants({
  project,
  grants,
  onChange,
  disabled,
}: {
  project: string
  grants: DnsGrant[]
  onChange: (v: DnsGrant[]) => void
  disabled: boolean
}) {
  const zones = usePolling<{ zones: (ZoneChoice & { rules: DnsRule[] })[] }>(
    `/projects/${project}/dns/access-scopes`,
  )
  const [zone, setZone] = useState(''),
    current = zones.data?.zones.find((z) => z.id === zone)
  const records = usePolling<ZoneRecords>(
    zone ? `/projects/${project}/dns/zones/${zone}/records` : null,
  )
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="font-medium">Cloud DNS permissions</legend>
      <ErrorMessage message={zones.error} />
      {disabled ? (
        <p className="text-sm text-muted-foreground">
          Project administrators receive all DNS access delegated to this
          project.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Members receive only these grants, within the project’s delegation.
          </p>
          <ul>
            {grants
              .filter((g) => !zones.data?.zones.some((z) => z.id === g.zone_id))
              .map((g, i) => (
                <li key={i}>
                  Unavailable zone · {g.kind}: {g.target ?? 'whole zone'}{' '}
                  <Button
                    type="button"
                    onClick={() =>
                      onChange(grants.filter((item) => item !== g))
                    }
                  >
                    Remove grant
                  </Button>
                </li>
              ))}
          </ul>
          <Label>
            Domain
            <NativeSelect
              value={zone}
              onChange={(e) => setZone(e.target.value)}
            >
              <option value="">Choose domain</option>
              {zones.data?.zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </NativeSelect>
          </Label>
          {current && (
            <>
              <p className="text-sm text-muted-foreground">
                Project limits:{' '}
                {current.rules
                  .map(
                    (r) =>
                      `${r.kind}: ${r.target ?? current.name} (${r.types.join(', ')}; ${r.actions.join(', ')})`,
                  )
                  .join('; ')}
              </p>
              <ErrorMessage message={records.error} />
              <DnsRuleEditor
                key={zone}
                allowed={current.rules}
                rules={grants
                  .filter((g) => g.zone_id === zone)
                  .map(({ zone_id: _, ...r }) => r)}
                records={records.data?.records}
                onChange={(rules) =>
                  onChange([
                    ...grants.filter((g) => g.zone_id !== zone),
                    ...rules.map((r) => ({ ...r, zone_id: zone })),
                  ])
                }
              />
            </>
          )}
        </>
      )}
    </fieldset>
  )
}
