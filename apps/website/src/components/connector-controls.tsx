import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
} from './ui/alert-dialog'
import QuickTip from './quickTip'
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
  const [confirmation, setConfirmation] = useState<'delete' | 'rotate'>()
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
              to="/connectors/$connectorId/overview"
              params={{ connectorId: c.id }}
            >
              Open connector{' '}
              <ArrowRight data-icon="inline-start" aria-hidden="true" />
            </Link>
          </Button>
        )}
        <QuickTip
          content={
            available
              ? 'Open host SSH terminal'
              : 'Host must be connected with SSH terminal enabled'
          }
          portal
        >
          <span tabIndex={available ? -1 : 0} className="inline-flex">
            <Button
              disabled={!available}
              onClick={() => {
                setError('')
                setTerminal(true)
              }}
            >
              <Terminal data-icon="inline-start" aria-hidden="true" />
              Host terminal
            </Button>
          </span>
        </QuickTip>
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
            setConfirmation('delete')
          }}
        >
          Delete connector
        </Button>
      </div>
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(undefined)
        }}
      >
        <AlertDialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            cancel.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            credentialTrigger.current?.focus()
          }}
        >
          <AlertDialogTitle>
            {confirmation === 'delete'
              ? `Delete connector ${c.name}?`
              : `Rotate token for ${c.name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-2">
            {confirmation === 'delete'
              ? 'This removes the connector from the dashboard, disconnects the host, and permanently invalidates its token. This cannot be undone. Workloads on the host continue running.'
              : 'This invalidates the current token and disconnects this host. Save the new token, update CONNECTOR_TOKEN on the host, and recreate the connector to reconnect.'}
          </AlertDialogDescription>
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
                    confirmation === 'delete'
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
                      'Unable to update the connector. Try again.',
                    )
                } catch {
                  setMutationError('Unable to update the connector. Try again.')
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy
                ? confirmation === 'delete'
                  ? 'Deleting connector…'
                  : 'Rotating token…'
                : confirmation === 'delete'
                  ? 'Delete connector'
                  : 'Rotate token'}
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
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
