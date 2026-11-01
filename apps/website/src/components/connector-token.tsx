import { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, KeyRound, X } from 'lucide-react'
import { Alert, AlertTitle, AlertDescription } from './ui/alert'
import { Button, Input } from './ui/controls'
import { Field, FieldLabel } from './ui/field'
import { usePolling } from '../components'
import type { Organization } from '../api'

export function ConnectorToken({
  token,
  onDismiss,
  rotated = false,
}: {
  token: string
  onDismiss: () => void
  rotated?: boolean
}) {
  const { data: organization } = usePolling<Organization>(
    '/organizations/current',
  )
  const descriptionId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.closest('[data-slot="alert"]')?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
        block: 'center',
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  async function copy(source: HTMLElement, pointer: boolean) {
    try {
      await navigator.clipboard.writeText(token)
      input.current?.setSelectionRange(0, 0)
      if (pointer && document.activeElement === source) source.blur()
      setCopied(true)
      setStatus('Token copied to clipboard.')
    } catch {
      setCopied(false)
      input.current?.focus()
      input.current?.select()
      setStatus(
        'Unable to copy automatically. Copy the selected token manually.',
      )
    }
  }

  return (
    <Alert>
      <KeyRound aria-hidden="true" />
      <AlertTitle>Connector token {rotated ? 'rotated' : 'created'}</AlertTitle>
      <AlertDescription className="w-full min-w-0">
        <p id={descriptionId}>
          Copy and save this token now. It is shown only once and is required to
          connect your host.
        </p>
        {rotated && (
          <p>
            The old token no longer works. Update CONNECTOR_TOKEN in your host's
            connector configuration, then recreate the connector to reconnect.
          </p>
        )}
        <Field className="mt-3">
          <FieldLabel>Connector token</FieldLabel>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <Input
              ref={input}
              value={token}
              readOnly
              spellCheck={false}
              aria-describedby={descriptionId}
              aria-label="Connector token"
              className="min-w-0 flex-1 cursor-copy font-mono"
              onClick={(event) => {
                void copy(event.currentTarget, event.detail > 0)
              }}
            />
            <Button
              type="button"
              variant="primary"
              onClick={(event) =>
                void copy(event.currentTarget, event.detail > 0)
              }
            >
              {copied ? (
                <Check data-icon="inline-start" aria-hidden="true" />
              ) : (
                <Copy data-icon="inline-start" aria-hidden="true" />
              )}
              {copied ? 'Copied' : 'Copy token'}
            </Button>
          </div>
        </Field>
        {organization?.api_url && (
          <Field className="mt-3">
            <FieldLabel>Connector API URL</FieldLabel>
            <Input value={organization.api_url} readOnly />
            <p>
              Set API_URL to this organization-specific address on your host.
            </p>
          </Field>
        )}
        <p role="status">{status}</p>
        <Button type="button" variant="ghost" onClick={onDismiss}>
          <X data-icon="inline-start" aria-hidden="true" />
          Dismiss token
        </Button>
      </AlertDescription>
    </Alert>
  )
}
