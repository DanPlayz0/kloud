import { Link } from '@tanstack/react-router'
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table'
import { Fragment, useRef, useState } from 'react'
import { TableCard } from './components/ui/card'
import { Button } from './components/ui/controls'
import { StatusBadge } from './components/ui/status-badge'
import { usePolling, ErrorMessage, Notice, bytes } from './components'
import {
  resourceBase,
  hasServer,
  type ResourceScope,
  type Connector,
  type User,
  type Project,
  type ContainerRow,
} from './api'
import QuickTip from './components/quickTip'
import { ContainerOperations } from './container-operations'
import { ContainerAssignment } from './components/container-assignment'
import { storageEngine } from './storage-images'

export function Compute({
  user,
  projects,
  project,
  connector,
  storage,
}: {
  user: User
  projects: Project[]
  project?: string
  connector?: Connector
  storage?: 'all' | 'cache'
}) {
  const scope: ResourceScope = connector
    ? { kind: 'connector', connector: connector.id }
    : { kind: 'project', project: project! }
  const [revision, setRevision] = useState(0)
  const {
    data: inventory,
    error,
    now,
  } = usePolling<ContainerRow[]>(resourceBase(scope) + '/containers', revision)
  const data = inventory?.filter((row) => {
    if (!storage) return true
    const engine = storageEngine(row.data.image)
    return engine !== null && (storage === 'all' || engine.kind === 'cache')
  })
  const title =
    storage === 'all'
      ? 'Databases'
      : storage === 'cache'
        ? 'Cache'
        : 'Containers'
  const isStale = (row: ContainerRow) =>
    row.stale || !row.seen || now - Date.parse(row.seen) > 20000
  const stale = data?.some(isStale)
  return (
    <>
      <section className="compute-content flex flex-col gap-4">
        <div className="page-heading">
          <div>
            <p className="eyebrow">{storage ? 'STORAGE' : 'COMPUTE'}</p>
            <h1>{title}</h1>
            {storage && (
              <p className="text-muted-foreground">
                {storage === 'cache' ? 'Caches' : 'Databases and caches'}{' '}
                detected from container images. Deploy and configure them
                through Services.
              </p>
            )}
          </div>
          {storage && project && (
            <Button variant="outline" asChild>
              <Link
                to="/projects/$projectSlug/services"
                params={{ projectSlug: project }}
              >
                Manage services
              </Link>
            </Button>
          )}
          <span className="text-sm text-muted-foreground" role="status">
            {error
              ? 'Connection interrupted'
              : stale
                ? 'Hosts need attention'
                : 'Updates every 5s'}
          </span>
        </div>
        <ErrorMessage message={error} />
        {data === undefined && !error && (
          <p role="status">Loading {title.toLowerCase()}…</p>
        )}
        {data?.length === 0 && (
          <Notice
            title={
              storage
                ? `No ${storage === 'cache' ? 'caches' : 'databases'} detected`
                : connector
                  ? 'No containers discovered'
                  : 'No containers assigned'
            }
          >
            {storage
              ? 'Deploy a service using a database or cache image. Recognized containers appear here automatically once reported by the host.'
              : connector
                ? 'This connector has no visible container inventory. Enable discovery to include unassigned containers.'
                : 'Add project and application labels to your containers, or ask an administrator to assign them.'}
          </Notice>
        )}
        {data && data.length > 0 && (
          <>
            <TableCard>
              <Table className="w-full min-w-[640px] text-left text-sm">
                <TableHeader className="border-b border-border text-muted-foreground">
                  <TableRow>
                    {[
                      'Container',
                      connector ? 'Project' : 'Host',
                      'Status',
                      'CPU',
                      'Memory',
                    ].map((label) => (
                      <TableHead key={label} scope="col" className="p-3">
                        {label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((row) => (
                    <ContainerInventoryRow
                      key={`${row.connector_id}:${row.container_id}`}
                      row={row}
                      scope={scope}
                      projects={projects}
                      stale={isStale(row)}
                      assignable={
                        !!connector?.discovery &&
                        hasServer(user, 'inventory.manage')
                      }
                      onAssigned={() => setRevision((value) => value + 1)}
                    />
                  ))}
                </TableBody>
              </Table>
            </TableCard>
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {data.length} container{data.length === 1 ? '' : 's'}
              </span>
              <span>Live Docker inventory</span>
            </div>
          </>
        )}
      </section>
    </>
  )
}

function ContainerInventoryRow({
  row,
  scope,
  projects,
  stale,
  assignable,
  onAssigned,
}: {
  row: ContainerRow
  scope: ResourceScope
  projects: Project[]
  stale: boolean
  assignable: boolean
  onAssigned: () => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const assignedProject = projects.find(
    (project) => project.slug === row.project,
  )
  return (
    <Fragment>
      <TableRow
        className="cursor-pointer border-b border-border hover:bg-muted focus-within:bg-muted"
        onClick={() => setOpen(true)}
      >
        <TableCell className="min-w-48 p-3">
          <Button
            ref={trigger}
            className="h-auto justify-start whitespace-normal break-all p-0 text-left"
            variant="link"
            aria-label={`Manage ${row.data.name}`}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            {row.data.name}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            {row.container_id.slice(0, 12)}
          </p>
          {row.data.image && (
            <p className="mt-1 text-xs text-muted-foreground break-all">
              {storageEngine(row.data.image)?.name &&
                `${storageEngine(row.data.image)!.name} · `}
              {row.data.image}
            </p>
          )}
          {scope.kind === 'project' && row.application && (
            <Link
              className="mt-1 block text-xs text-muted-foreground hover:underline"
              to="/projects/$projectSlug/applications/$appSlug"
              params={{ projectSlug: scope.project, appSlug: row.application }}
              onClick={(event) => event.stopPropagation()}
            >
              View {row.application} application
            </Link>
          )}
        </TableCell>
        <TableCell className="p-3 break-words">
          {scope.kind === 'connector' ? (
            assignedProject ? (
              <Link
                className="hover:underline"
                to="/projects/$projectSlug/compute/containers"
                params={{ projectSlug: assignedProject.slug }}
                onClick={(event) => event.stopPropagation()}
              >
                {assignedProject.name}
              </Link>
            ) : (
              (row.project ?? 'Unassigned')
            )
          ) : (
            <QuickTip portal content={row.connector_name}>
              {row.host ?? row.connector_name}
            </QuickTip>
          )}
          {scope.kind === 'connector' &&
            assignable &&
            row.assignment !== 'label' && (
              <div
                className="mt-2"
                onClick={(event) => event.stopPropagation()}
              >
                <ContainerAssignment container={row} onSaved={onAssigned} />
              </div>
            )}
        </TableCell>
        <TableCell className="p-3 whitespace-nowrap">
          <StatusBadge>{stale ? 'Stale' : row.data.state}</StatusBadge>
        </TableCell>
        <TableCell className="p-3">
          <Meter
            name="CPU utilization"
            value={stale ? null : row.data.cpu}
            label={
              stale || row.data.cpu === null
                ? '—'
                : `${row.data.cpu.toFixed(1)}%`
            }
          />
        </TableCell>
        <TableCell className="p-3">
          <Meter
            name="Memory utilization"
            value={
              stale || row.data.memory === null || !row.data.memoryLimit
                ? null
                : (row.data.memory / row.data.memoryLimit) * 100
            }
            label={
              stale
                ? '—'
                : `${bytes(row.data.memory)}${row.data.memoryLimit ? ` / ${bytes(row.data.memoryLimit)}` : ''}`
            }
          />
        </TableCell>
      </TableRow>
      <ContainerOperations
        scope={scope}
        container={row}
        open={open}
        onOpenChange={setOpen}
        trigger={trigger}
      />
    </Fragment>
  )
}

function Meter({
  name,
  value,
  label,
}: {
  name: string
  value: number | null
  label: string
}) {
  return (
    <div className="flex min-w-24 flex-col gap-1.5">
      <span
        className="meter"
        role={value === null ? undefined : 'meter'}
        aria-label={value === null ? undefined : name}
        aria-hidden={value === null ? true : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          value === null ? undefined : Math.max(0, Math.min(100, value))
        }
        aria-valuetext={label}
        data-tone={
          value === null
            ? 'neutral'
            : value >= 90
              ? 'danger'
              : value >= 75
                ? 'warning'
                : 'success'
        }
      >
        <span style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
      </span>
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        {label}
      </span>
    </div>
  )
}
