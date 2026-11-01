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

export function Compute({
  user,
  projects,
  project,
  connector,
}: {
  user: User
  projects: Project[]
  project?: string
  connector?: Connector
}) {
  const scope: ResourceScope = connector
    ? { kind: 'connector', connector: connector.id }
    : { kind: 'project', project: project! }
  const [revision, setRevision] = useState(0)
  const { data, error, now } = usePolling<ContainerRow[]>(
    resourceBase(scope) + '/containers',
    revision,
  )
  const isStale = (row: ContainerRow) =>
    row.stale || !row.seen || now - Date.parse(row.seen) > 20000
  const stale = data?.some(isStale)
  return (
    <>
      <section className="compute-content flex flex-col gap-4">
        <div className="page-heading">
          <div>
            <p className="eyebrow">COMPUTE</p>
            <h1>Containers</h1>
          </div>
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
          <p role="status">Loading containers…</p>
        )}
        {data?.length === 0 && (
          <Notice
            title={
              connector ? 'No containers discovered' : 'No containers assigned'
            }
          >
            {connector
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
            className="text-left  break-all"
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

function Meter({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="flex min-w-24 flex-col gap-1.5">
      <span
        className="meter"
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
