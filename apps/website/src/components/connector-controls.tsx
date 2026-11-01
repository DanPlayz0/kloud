import { Alert, AlertDescription } from '@/components/ui/alert'
import { FieldGroup, Field, FieldLabel } from '@/components/ui/field'
import { useEffect, useState } from 'react'
import { Terminal, ArrowRight } from 'lucide-react'
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
  useEffect(() => setPending(undefined), [c.discovery])
  const available =
    !c.revoked && !c.stale && c.capabilities?.includes('host-terminal')
  useEffect(() => {
    if (!available) setTerminal(false)
  }, [available])
  return (
    <>
      <FieldGroup className="row-actions">
        {showOpen && (
          <Button asChild>
            <a
              href={
                '/connectors/' +
                encodeURIComponent(c.id) +
                '/compute/containers'
              }
            >
              Open connector{' '}
              <ArrowRight data-icon="inline-start" aria-hidden="true" />
            </a>
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
          className="checkbox"
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
          variant="destructive"
          disabled={c.revoked || busy}
          onClick={() => {
            if (
              confirm(
                'Revoke ' +
                  c.name +
                  '? Its token will stop working permanently.',
              )
            ) {
              setBusy(true)
              void action('/admin/connectors/' + c.id, 'PUT', {
                discovery: c.discovery,
                revoked: true,
              }).finally(() => setBusy(false))
            }
          }}
        >
          Revoke token
        </Button>
      </FieldGroup>
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
