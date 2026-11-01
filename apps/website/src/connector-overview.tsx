import { ServerAddressDetails } from './server-addresses'
import { useState } from 'react'
import { api, hasServer, type Connector, type Project, type User } from './api'
import { Shell, usePolling, ErrorMessage } from './components'
import { Card } from './components/ui/card'
import { StatusBadge } from './components/ui/status-badge'
import { ConnectorControls } from './components/connector-controls'

export function ConnectorOverview({
  user,
  projects,
  connector,
}: {
  user: User
  projects: Project[]
  connector: Connector
}) {
  const [revision, setRevision] = useState(0)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const { data, error, now } = usePolling<Connector>(
    '/connectors/' + connector.id,
    revision,
  )
  const current = data ?? connector
  const stale =
    current.stale || !current.seen || now - Date.parse(current.seen) > 20000
  async function action(path: string, method: string, body: unknown) {
    setActionError('')
    setMessage('')
    try {
      await api(path, method, body)
      if ((body as { revoked?: boolean }).revoked) {
        location.assign('/admin/connectors')
        return true
      }
      setMessage('Changes saved.')
      setRevision((v) => v + 1)
      return true
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Unable to save changes')
      return false
    }
  }
  return (
    <Shell
      user={user}
      projects={projects}
      connector={current}
      active="overview"
      title="Overview"
    >
      <section className="compute-content flex flex-col gap-4">
        <div className="page-heading">
          <div>
            <p className="eyebrow">CONNECTOR</p>
            <h1>{current.name}</h1>
          </div>
          <StatusBadge>
            {current.revoked
              ? 'Revoked'
              : stale
                ? 'Offline / stale'
                : 'Connected'}
          </StatusBadge>
        </div>
        <ErrorMessage message={error || actionError} />
        {message && <p role="status">{message}</p>}
        <Card className="flex flex-col gap-4 p-5">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">Host</dt>
              <dd className="break-all">{current.host ?? 'Not connected'}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Last seen</dt>
              <dd>
                {current.seen
                  ? new Date(current.seen).toLocaleString()
                  : 'Never'}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Capabilities</dt>
              <dd>
                {current.capabilities.length
                  ? current.capabilities.join(', ')
                  : 'None reported'}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Discovery</dt>
              <dd>{current.discovery ? 'Enabled' : 'Disabled'}</dd>
            </div>
          </dl>
          <ServerAddressDetails
            key={JSON.stringify(current.dns_targets)}
            server={current}
            editable={hasServer(user, 'connectors.manage')}
            onSaved={() => setRevision((v) => v + 1)}
          />
          {hasServer(user, 'connectors.manage') && (
            <ConnectorControls
              connector={{ ...current, stale: stale || !!error }}
              action={action}
            />
          )}
        </Card>
      </section>
    </Shell>
  )
}
