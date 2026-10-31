import { Fragment, useEffect, useRef, useState } from 'react'
import {
  Activity,
  ChevronDown,
  ChevronRight,
  FileText,
  Pause,
  Play,
  RotateCw,
  Square,
  Trash2,
} from 'lucide-react'
import {
  pm2Actions,
  type Pm2Action,
  type Pm2Logs,
  type Pm2Result,
  type Pm2Worker,
} from '@kloud/protocol/pm2'
import { api, type Project, type User } from './api'
import { Shell, usePolling, ErrorMessage, Notice, bytes } from './components'
import { Button, Checkbox, Label, NativeSelect } from './components/ui/controls'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './components/ui/dialog'
import QuickTip from './components/quickTip'

export interface Pm2App {
  id: string
  connector_id: string
  connector_name: string
  host: string | null
  name: string
  namespace: string
  project_slug: string | null
  workers: Pm2Worker[]
  present: boolean
  stale: boolean
  seen: string | null
}
type Permissions = {
  available: boolean
  view: boolean
  logs: boolean
  manage: boolean
  delete: boolean
}
const stale = (app: Pm2App) =>
  app.stale || !app.seen || Date.now() - Date.parse(app.seen) > 20000
const uptime = (workers: Pm2Worker[]) => {
  const times = workers
    .filter((w) => w.status === 'online' && w.uptime !== null)
    .map((w) => w.uptime!)
  if (!times.length) return '—'
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Math.min(...times)) / 1000),
  )
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h`
}
const status = (app: Pm2App) =>
  !app.present
    ? 'Unavailable'
    : stale(app)
      ? 'Stale'
      : new Set(app.workers.map((w) => w.status)).size > 1
        ? 'Mixed'
        : (app.workers[0]?.status ?? 'Unavailable')

export function Pm2Page({
  user,
  projects,
  project,
}: {
  user: User
  projects: Project[]
  project: string
}) {
  const [revision, setRevision] = useState(0)
  const { data, error } = usePolling<Pm2App[]>(
    `/projects/${project}/pm2`,
    revision,
  )
  return (
    <Shell
      user={user}
      projects={projects}
      project={project}
      title="Compute / PM2"
      active="pm2"
    >
      <section className="compute-content space-y-4">
        <div className="page-heading">
          <div>
            <p className="eyebrow">COMPUTE</p>
            <h1>PM2</h1>
          </div>
          <span className="text-sm text-muted-foreground">
            Updates every 5s
          </span>
        </div>
        <ErrorMessage message={error} />
        {!data && !error && <p role="status">Loading PM2 applications…</p>}
        {data?.length === 0 && (
          <Notice title="No PM2 applications assigned">
            Enable PM2 and discovery on your connector, then assign apps in
            Administration / Inventory.
          </Notice>
        )}
        {data && data.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  {[
                    'Application',
                    'Host',
                    'Status',
                    'Workers',
                    'CPU',
                    'Memory',
                    'Uptime',
                    'Restarts',
                    'Actions',
                  ].map((label) => (
                    <th key={label} scope="col" className="p-3">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((app) => (
                  <Pm2Row
                    key={app.id}
                    app={app}
                    project={project}
                    refresh={() => setRevision((v) => v + 1)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  )
}

function Pm2Row({
  app,
  project,
  refresh,
}: {
  app: Pm2App
  project: string
  refresh: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const current = app.present && !stale(app)
  const cpu = app.workers.some((w) => w.cpu !== null)
    ? `${app.workers.reduce((v, w) => v + (w.cpu ?? 0), 0).toFixed(1)}%`
    : '—'
  const memory = app.workers.some((w) => w.memory !== null)
    ? bytes(app.workers.reduce((v, w) => v + (w.memory ?? 0), 0))
    : '—'
  return (
    <Fragment>
      <tr className="border-b border-border">
        <td className="p-3">
          <Button
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${app.name} workers`}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {app.name}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">{app.namespace}</p>
        </td>
        <td className="p-3">{app.host ?? app.connector_name}</td>
        <td className="p-3">{status(app)}</td>
        <td className="p-3">{app.workers.length}</td>
        <td className="p-3">{current ? cpu : '—'}</td>
        <td className="p-3">{current ? memory : '—'}</td>
        <td className="p-3">{current ? uptime(app.workers) : '—'}</td>
        <td className="p-3">
          {current ? app.workers.reduce((v, w) => v + w.restarts, 0) : '—'}
        </td>
        <td className="p-3">
          <Pm2Operations app={app} project={project} refresh={refresh} />
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9} className="p-4 bg-background">
            <div className="space-y-2" aria-label={`${app.name} workers`}>
              {!app.workers.length && (
                <p className="text-muted-foreground">No current workers.</p>
              )}
              {app.workers.map((w) => (
                <p key={w.id} className="text-sm">
                  #{w.id} · PID {w.pid} · {w.mode} · {w.status} · CPU{' '}
                  {current && w.cpu !== null ? `${w.cpu}%` : '—'} · RAM{' '}
                  {current ? bytes(w.memory) : '—'} · uptime{' '}
                  {current ? uptime([w]) : '—'} · {w.restarts} restarts
                </p>
              ))}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  )
}

function Pm2Operations({
  app,
  project,
  refresh,
}: {
  app: Pm2App
  project: string
  refresh: () => void
}) {
  const [open, setOpen] = useState(false),
    [permissions, setPermissions] = useState<Permissions>(),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false),
    [confirmAction, setConfirmAction] = useState<Pm2Action>()
  const submitting = useRef(false)
  const base = `/projects/${project}/pm2/${app.id}`
  useEffect(() => {
    if (!open) return
    let active = true
    const load = () =>
      api<Permissions>(`${base}/permissions`)
        .then((value) => {
          if (active) setPermissions(value)
        })
        .catch((e) => {
          if (active) {
            setPermissions(undefined)
            setError(e.message)
          }
        })
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [open, base])
  async function perform(action: Pm2Action) {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await api<Pm2Result>(`${base}/operation`, 'POST', {
        action,
      })
      const failures = result.results.filter((r) => !r.ok)
      if (failures.length)
        setError(
          `${action}: ${result.results.length - failures.length} succeeded; workers ${failures.map((r) => r.id).join(', ')} failed or have an unknown outcome. Inspect host state before retrying.`,
        )
      else
        setMessage(`${action} completed for ${result.results.length} workers.`)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PM2 operation failed')
    } finally {
      submitting.current = false
      setBusy(false)
      setConfirmAction(undefined)
    }
  }
  const available = permissions?.available && app.present && !stale(app)
  const icons = {
    start: Play,
    stop: Square,
    restart: RotateCw,
    reload: Activity,
    delete: Trash2,
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next)
          if (!next) setConfirmAction(undefined)
        }
      }}
    >
      <Button
        onClick={() => {
          setError('')
          setMessage('')
          setOpen(true)
        }}
      >
        <FileText size={16} aria-hidden="true" />
        Open
      </Button>
      <DialogContent className="!max-w-4xl space-y-4">
        <DialogTitle className="text-lg font-semibold break-all">
          {app.name}
        </DialogTitle>
        <DialogDescription>
          {app.namespace} · {app.host ?? app.connector_name} · {status(app)}
        </DialogDescription>
        <ErrorMessage message={error} />
        {message && <p role="status">{message}</p>}
        {!permissions && !error && <p role="status">Loading permissions…</p>}
        {permissions && !available && (
          <p className="text-muted-foreground">
            PM2 host or application unavailable. Actions and logs are disabled.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {pm2Actions.map((action) => {
            const allowed =
              permissions?.[action === 'delete' ? 'delete' : 'manage']
            const Icon = icons[action]
            return (
              <QuickTip
                key={action}
                content={
                  !allowed
                    ? `PM2 ${action === 'delete' ? 'Delete' : 'Manage'} permission required`
                    : `${action} all workers in this application`
                }
              >
                <Button
                  disabled={!available || !allowed || busy}
                  variant={action === 'delete' ? 'destructive' : 'default'}
                  onClick={() =>
                    action === 'stop' || action === 'delete'
                      ? setConfirmAction(action)
                      : void perform(action)
                  }
                >
                  <Icon size={16} aria-hidden="true" />
                  {action}
                </Button>
              </QuickTip>
            )
          })}
        </div>
        {confirmAction && (
          <div
            className="rounded border border-border bg-background p-4 space-y-3"
            role="alert"
          >
            <p>
              {confirmAction} {app.name} ({app.namespace}) and all{' '}
              {app.workers.length} workers?
            </p>
            {confirmAction === 'delete' && (
              <p className="text-sm text-muted-foreground">
                This removes the application from PM2. Register it again on the
                server to start it afterward. The saved boot list is unchanged.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                disabled={busy}
                variant="destructive"
                onClick={() => void perform(confirmAction)}
              >
                Confirm {confirmAction}
              </Button>
              <Button
                disabled={busy}
                onClick={() => setConfirmAction(undefined)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {permissions?.logs ? (
          <Pm2LogViewer
            base={base}
            app={app}
            available={!!available && !busy}
          />
        ) : (
          permissions && (
            <p className="text-muted-foreground">
              PM2 Logs permission required to read output.
            </p>
          )
        )}
        <div className="flex justify-end">
          <Button disabled={busy} onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Pm2LogViewer({
  base,
  app,
  available,
}: {
  base: string
  app: Pm2App
  available: boolean
}) {
  const [channel, setChannel] = useState('stdout'),
    [worker, setWorker] = useState(''),
    [paused, setPaused] = useState(false),
    [autoScroll, setAutoScroll] = useState(true)
  const [output, setOutput] = useState(''),
    [error, setError] = useState(''),
    [received, setReceived] = useState(false),
    [retry, setRetry] = useState(0)
  const log = useRef<HTMLPreElement>(null)
  useEffect(() => {
    setOutput('')
    setError('')
    setReceived(false)
  }, [base, channel, worker])
  useEffect(() => {
    if (!available || paused) return
    setError('')
    const query = new URLSearchParams({
      stream: channel,
      ...(worker ? { worker } : {}),
    })
    const source = new EventSource(`/api${base}/logs?${query}`)
    source.onmessage = (event) => {
      const data = JSON.parse(event.data) as Pm2Logs
      setOutput(data.output)
      setReceived(true)
      setError(
        data.unavailable
          ? 'Some log files are unavailable. Check log mounts and permissions on the connector.'
          : '',
      )
    }
    const fail = () => {
      setError('Log access ended or PM2 host unavailable.')
      source.close()
    }
    source.addEventListener('unavailable', fail)
    source.onerror = fail
    return () => source.close()
  }, [base, channel, worker, available, paused, retry])
  useEffect(() => {
    if (autoScroll && log.current)
      log.current.scrollTop = log.current.scrollHeight
  }, [output, autoScroll])
  return (
    <section aria-label="PM2 logs" className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Label>
          Stream
          <NativeSelect
            aria-label="Log stream"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
          </NativeSelect>
        </Label>
        <Label>
          Worker
          <NativeSelect
            aria-label="Log worker"
            value={worker}
            onChange={(e) => setWorker(e.target.value)}
          >
            <option value="">All workers</option>
            {app.workers.map((w) => (
              <option key={w.id} value={w.id}>
                #{w.id}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Button onClick={() => setPaused((v) => !v)}>
          {paused ? <Play size={16} /> : <Pause size={16} />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Label className="!flex-row items-center gap-2">
          <Checkbox
            checked={autoScroll}
            onCheckedChange={(v) => setAutoScroll(v === true)}
          />
          Auto-scroll
        </Label>
        {error && (
          <Button
            disabled={!available || paused}
            onClick={() => setRetry((v) => v + 1)}
          >
            Reconnect logs
          </Button>
        )}
      </div>
      <ErrorMessage message={error} />
      <p className="text-xs text-muted-foreground">
        {paused
          ? 'Paused'
          : !available
            ? 'Unavailable'
            : 'Recent output · refreshes every 1.5s'}{' '}
        · up to 200 lines / 48 KB
      </p>
      <pre
        ref={log}
        aria-label="Log output"
        tabIndex={0}
        className="h-80 overflow-auto rounded border border-border bg-background p-4 text-xs text-foreground whitespace-pre-wrap break-all"
      >
        {output || (received ? 'No recent output.' : 'Waiting for logs…')}
      </pre>
    </section>
  )
}

export function Pm2Inventory({ projects }: { projects: Project[] }) {
  const choices = usePolling<Project[]>('/admin/containers/projects')
  const [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const { data, error: loadError } = usePolling<Pm2App[]>(
    '/admin/pm2',
    revision,
  )
  async function assign(app: string, project: string) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api(`/admin/pm2/${app}`, 'PUT', { project: project || null })
      setMessage('PM2 assignment saved.')
      setRevision((v) => v + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Assignment failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mt-6 space-y-4" aria-label="PM2 inventory">
      <h2>PM2 inventory</h2>
      <p className="text-sm text-muted-foreground">
        Enable PM2 and discovery on a connector to assign applications.
        Assignments follow the same host, namespace, and name across recreation.
      </p>
      <ErrorMessage message={error || loadError || choices.error} />
      {message && <p role="status">{message}</p>}
      {!data && !loadError && <p>Loading PM2 inventory…</p>}
      {data?.length === 0 && (
        <p className="text-muted-foreground">No PM2 applications discovered.</p>
      )}
      {data?.map((app) => (
        <form
          key={`${app.id}:${app.project_slug}:${revision}`}
          className="flex flex-wrap items-end gap-3 rounded border border-border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault()
            void assign(
              app.id,
              String(new FormData(e.currentTarget).get('project') ?? ''),
            )
          }}
        >
          <div className="min-w-40 flex-1">
            <strong className="break-all">{app.name}</strong>
            <p className="text-sm text-muted-foreground">
              {app.namespace} · {app.host ?? app.connector_name} · {status(app)}
            </p>
          </div>
          <Label>
            Project
            <NativeSelect
              name="project"
              aria-label={`Project for ${app.name} (${app.namespace})`}
              defaultValue={app.project_slug ?? ''}
              disabled={busy}
            >
              <option value="">Unassigned</option>
              {(choices.data ?? projects).map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Button type="submit" disabled={busy}>
            Save assignment
          </Button>
        </form>
      ))}
    </section>
  )
}
