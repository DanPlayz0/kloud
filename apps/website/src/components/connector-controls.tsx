import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Field, FieldLabel } from '@/components/ui/field'
import { useEffect, useRef, useState } from 'react'
import { Terminal, ArrowRight, RotateCw } from 'lucide-react'
import type { Connector } from '../api'
import { Button, Checkbox } from './ui/controls'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './ui/dialog'
import { ContainerTerminal } from './container-terminal'

export type ConnectorAction = (
  path: string,
  method: string,
  body: unknown,
) => Promise<boolean>
export function ConnectorControls({
  connector: c,
  action,
  showOpen = false,
}: {
  connector: Connector
  action: ConnectorAction
  showOpen?: boolean
}) {
  const [pending, setPending] = useState<boolean>()
  const [busy, setBusy] = useState(false)
  const [terminal, setTerminal] = useState(false)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<'revoke' | 'rotate'>()
  const [mutationError, setMutationError] = useState('')
  const cancel = useRef<HTMLButtonElement>(null)
  const credentialTrigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => setPending(undefined), [c.discovery])
  const available =
    !c.revoked && !c.stale && c.capabilities?.includes('host-terminal')
  useEffect(() => {
    if (!available) setTerminal(false)
  }, [available])
  return (
    <>
      <div className="row-actions">
        {showOpen && (
          <Button asChild>
            <Link
              to="/connectors/$connectorId/compute/containers"
              params={{ connectorId: c.id }}
            >
              Open connector{' '}
              <ArrowRight data-icon="inline-start" aria-hidden="true" />
            </Link>
          </Button>
        )}
        <Button
          disabled={!available}
          title={
            available
              ? 'Open host SSH terminal'
              : 'Host must be connected with SSH terminal enabled'
          }
          onClick={() => {
            setError('')
            setTerminal(true)
          }}
        >
          <Terminal data-icon="inline-start" aria-hidden="true" />
          Host terminal
        </Button>
        <Field
          data-disabled={c.revoked || busy}
          orientation="horizontal"
          className="checkbox w-auto"
        >
          <Checkbox
            checked={pending ?? c.discovery}
            disabled={c.revoked || busy}
            onCheckedChange={(value) => {
              const discovery = value === true
              setPending(discovery)
              setBusy(true)
              void action('/admin/connectors/' + c.id, 'PUT', {
                discovery,
                revoked: false,
              })
                .then((ok) => {
                  if (!ok) setPending(undefined)
                })
                .finally(() => setBusy(false))
            }}
          />
          <FieldLabel>Discover unassigned containers</FieldLabel>
        </Field>
        <Button
          disabled={c.revoked || busy}
          onClick={(event) => {
            credentialTrigger.current = event.currentTarget
            setMutationError('')
            setConfirmation('rotate')
          }}
        >
          <RotateCw data-icon="inline-start" aria-hidden="true" />
          Rotate token
        </Button>
        <Button
          variant="destructive"
          disabled={c.revoked || busy}
          onClick={(event) => {
            credentialTrigger.current = event.currentTarget
            setMutationError('')
            setConfirmation('revoke')
          }}
        >
          Revoke token
        </Button>
      </div>
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(undefined)
        }}
      >
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            cancel.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            credentialTrigger.current?.focus()
          }}
        >
          <DialogTitle>
            {confirmation === 'revoke' ? 'Revoke' : 'Rotate'} token for {c.name}
            ?
          </DialogTitle>
          <DialogDescription className="mt-2">
            {confirmation === 'revoke'
              ? 'This permanently revokes the token and disconnects this host. This connector cannot reconnect or be restored.'
              : 'This invalidates the current token and disconnects this host. Save the new token, update CONNECTOR_TOKEN on the host, and recreate the connector to reconnect.'}
          </DialogDescription>
          {mutationError && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{mutationError}</AlertDescription>
            </Alert>
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button
              ref={cancel}
              disabled={busy}
              onClick={() => setConfirmation(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (busy) return
                setBusy(true)
                setMutationError('')
                try {
                  const ok =
                    confirmation === 'revoke'
                      ? await action('/admin/connectors/' + c.id, 'PUT', {
                          discovery: c.discovery,
                          revoked: true,
                        })
                      : await action(
                          '/admin/connectors/' + c.id + '/rotate',
                          'POST',
                          undefined,
                        )
                  if (ok) setConfirmation(undefined)
                  else
                    setMutationError(
                      'Unable to update the connector token. Try again.',
                    )
                } catch {
                  setMutationError(
                    'Unable to update the connector token. Try again.',
                  )
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy
                ? 'Updating token…'
                : confirmation === 'revoke'
                  ? 'Revoke token'
                  : 'Rotate token'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={terminal} onOpenChange={setTerminal}>
        <DialogContent className="max-w-5xl">
          <DialogTitle>Host terminal — {c.name}</DialogTitle>
          <DialogDescription>
            SSH shell on the configured host, using the connector's SSH account.
          </DialogDescription>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {terminal && (
            <ContainerTerminal
              key={c.id}
              path={'/admin/connectors/' + c.id + '/terminal'}
              onError={setError}
              label="Host SSH terminal"
            />
          )}
          <Button onClick={() => setTerminal(false)}>Disconnect</Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
