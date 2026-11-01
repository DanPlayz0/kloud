import {
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
} from './components/ui/field'
import { useState } from 'react'
import { api, hasServer, type Connector, type User } from './api'
import { Button, Checkbox } from './components/ui/controls'
import { ErrorMessage } from './components'

export function ConnectorUpdateControls({
  connector,
  user,
  onSaved,
}: {
  connector: Connector
  user: User
  onSaved: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const status = connector.agent_status
  const updater = status?.updater
  const editable = hasServer(user, 'connectors.manage')
  const enabled = connector.auto_update ?? updater?.enabled ?? false
  async function save(action: 'check' | 'configure', enabled?: boolean) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await api<{ pending?: boolean }>(
        `/connectors/${connector.id}/updates${action === 'check' ? '/check' : ''}`,
        action === 'check' ? 'POST' : 'PUT',
        action === 'check' ? {} : { enabled },
      )
      setMessage(
        action === 'check'
          ? 'Update check requested. The connector may briefly disconnect while restarting.'
          : result.pending
            ? 'Update policy saved; it will apply when the connector reconnects.'
            : 'Update policy saved.',
      )
      onSaved()
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to update connector',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="flex flex-col gap-3 border-t border-border pt-4"
      aria-label="Connector version and updates"
    >
      <h2 className="font-semibold">Version and updates</h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">Running version</dt>
          <dd>{status?.version ?? 'Not reported by this connector'}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Commit</dt>
          <dd className="break-all font-mono text-sm">
            {status?.revision ?? 'Unknown'}
          </dd>
        </div>
        {status?.started_at && (
          <div>
            <dt className="text-sm text-muted-foreground">Started</dt>
            <dd>{new Date(status.started_at).toLocaleString()}</dd>
          </div>
        )}
        {updater?.checked_at && (
          <div>
            <dt className="text-sm text-muted-foreground">Last update check</dt>
            <dd>
              {new Date(updater.checked_at).toLocaleString()} ({updater.state})
            </dd>
          </div>
        )}
      </dl>
      {updater?.configured ? (
        <>
          <Field orientation="horizontal" data-disabled={!editable || busy}>
            <Checkbox
              checked={enabled}
              disabled={!editable || busy}
              onCheckedChange={(value) =>
                void save('configure', value === true)
              }
            />
            <FieldContent>
              <FieldLabel>Automatic connector updates</FieldLabel>
              <FieldDescription>
                Uses the trusted updater configured on this server. Running
                version and commit change after a successful restart.
              </FieldDescription>
            </FieldContent>
          </Field>
          {editable && (
            <div>
              <Button
                disabled={
                  busy || connector.stale || updater.state === 'checking'
                }
                onClick={() => void save('check')}
              >
                Check for updates now
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Automatic updates require a trusted updater configured on the
          connector host. See the connector update guide.
        </p>
      )}
      <ErrorMessage message={error || updater?.error || ''} />
      {message && <p role="status">{message}</p>}
    </section>
  )
}
