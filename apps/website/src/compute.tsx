import { StatusBadge } from './components/ui/status-badge'
import {
  usePolling,
  Shell,
  ErrorMessage,
  Notice,
  bytes,
  Icon,
} from './components'
import {
  resourceBase,
  type ResourceScope,
  type Connector,
  type User,
  type Project,
  type ContainerRow,
} from './api'
import QuickTip from './components/quickTip'
import { ContainerOperations } from './container-operations'
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
  const { data, error, now } = usePolling<ContainerRow[]>(
    resourceBase(scope) + '/containers',
  )
  const isStale = (row: ContainerRow) =>
    row.stale || !row.seen || now - Date.parse(row.seen) > 20000
  const stale = data?.some(isStale)
  return (
    <Shell
      user={user}
      projects={projects}
      project={project}
      connector={connector}
      title="Compute / Containers"
      active={connector ? 'compute/containers' : 'containers'}
    >
      <div className="compute-content">
        <div className="page-heading">
          <div>
            <p className="eyebrow">COMPUTE</p>
            <h1>Containers</h1>
          </div>
          <span
            className="live-indicator"
            data-tone={
              error
                ? 'danger'
                : stale
                  ? 'warning'
                  : data
                    ? 'success'
                    : 'neutral'
            }
          >
            <i className={stale || error ? 'warning' : ''} />
            {error
              ? 'Connection interrupted'
              : stale
                ? 'Hosts need attention'
                : 'Updates every 5s'}
          </span>
        </div>
        <ErrorMessage message={error} />
        {data === undefined && !error ? (
          <div className="table-skeleton" aria-label="Loading containers">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i}>
                <span />
                <span />
                <span />
              </div>
            ))}
          </div>
        ) : data?.length === 0 ? (
          <Notice
            title={
              connector ? 'No containers discovered' : 'No containers assigned'
            }
          >
            {connector
              ? 'This connector has no visible container inventory. Enable discovery to include unassigned containers.'
              : 'Add project and application labels to your containers, or ask an administrator to assign them.'}
          </Notice>
        ) : (
          data && (
            <>
              <div className="table-scroll">
                <table className="container-table">
                  <thead>
                    <tr>
                      <th>CONTAINER NAME</th>
                      <th>{connector ? 'PROJECT' : 'HOST'}</th>
                      <th>STATUS</th>
                      <th>CPU USAGE</th>
                      <th>RAM USAGE</th>
                      <th>ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row) => (
                      <tr
                        key={`${row.connector_id}:${row.container_id}`}
                        className={isStale(row) ? 'stale-row' : ''}
                      >
                        <td>
                          {project && row.application ? (
                            <a
                              href={`/projects/${project}/applications/${row.application}`}
                              className="container-link"
                            >
                              {row.data.name}
                              <Icon name="external" className="row-arrow" />
                            </a>
                          ) : (
                            <span className="font-medium">{row.data.name}</span>
                          )}
                        </td>
                        <td>
                          {connector ? (
                            row.project &&
                            projects.some((p) => p.slug === row.project) ? (
                              <a
                                className="hover:underline"
                                href={
                                  '/projects/' +
                                  encodeURIComponent(row.project) +
                                  '/compute/containers'
                                }
                              >
                                {
                                  projects.find((p) => p.slug === row.project)
                                    ?.name
                                }
                              </a>
                            ) : (
                              (row.project ?? 'Unassigned')
                            )
                          ) : (
                            <QuickTip portal content={row.connector_name}>
                              {row.host ?? row.connector_name}
                            </QuickTip>
                          )}
                        </td>
                        <td>
                          <StatusBadge
                            className={`status ${isStale(row) ? 'stale' : row.data.state}`}
                          >
                            {isStale(row) ? 'Stale' : row.data.state}
                          </StatusBadge>
                        </td>
                        <td>
                          <Meter
                            value={isStale(row) ? null : row.data.cpu}
                            label={
                              isStale(row) || row.data.cpu === null
                                ? '—'
                                : `${row.data.cpu.toFixed(1)}%`
                            }
                          />
                        </td>
                        <td>
                          <Meter
                            value={
                              isStale(row) ||
                              row.data.memory === null ||
                              !row.data.memoryLimit
                                ? null
                                : (row.data.memory / row.data.memoryLimit) * 100
                            }
                            label={
                              isStale(row)
                                ? '—'
                                : `${bytes(row.data.memory)}${row.data.memoryLimit ? ` / ${bytes(row.data.memoryLimit)}` : ''}`
                            }
                          />
                        </td>
                        <td>
                          <ContainerOperations scope={scope} container={row} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-footer">
                <span>
                  {data.length} container{data.length === 1 ? '' : 's'}
                </span>
                <span>Live Docker inventory</span>
              </div>
            </>
          )
        )}
      </div>
    </Shell>
  )
}
function Meter({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="metric">
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
      <small>{label}</small>
    </div>
  )
}
