import { useState } from 'react'
import type { PublicAddresses } from '@kloud/protocol/addresses'
import { Button, Input, Label } from './components/ui/controls'
import { ErrorMessage } from './components'
import { api } from './api'

export interface ServerAddresses {
  public_addresses?: PublicAddresses | null
  dns_targets?: { ipv4?: string | null; ipv6?: string | null }
  private_addresses?: string[]
}
export function effectiveAddresses(server?: ServerAddresses) {
  return {
    ipv4:
      server?.dns_targets?.ipv4 || server?.public_addresses?.ipv4.address || '',
    ipv6:
      server?.dns_targets?.ipv6 || server?.public_addresses?.ipv6.address || '',
  }
}
export function ServerAddressDetails({
  server,
  editable = false,
  onSaved,
}: {
  server: ServerAddresses & { id: string }
  editable?: boolean
  onSaved?: () => void
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="space-y-3">
      <h2 className="font-semibold">Network addresses</h2>
      <dl className="grid gap-4 sm:grid-cols-2">
        {(['ipv4', 'ipv6'] as const).map((family) => {
          const value = server.public_addresses?.[family]
          return (
            <div key={family}>
              <dt className="text-sm text-muted-foreground">
                Detected public {family === 'ipv4' ? 'IPv4' : 'IPv6'}
              </dt>
              <dd>
                {value?.address ?? 'Unknown'} · {value?.status ?? 'unknown'}
                {value?.last_success &&
                  ` · last successful ${new Date(value.last_success).toLocaleString()}`}
              </dd>
              {value?.error && (
                <dd className="text-xs text-muted-foreground">{value.error}</dd>
              )}
            </div>
          )
        })}
      </dl>
      <p className="text-xs text-muted-foreground">
        Outbound detection suggests an ingress target; it does not verify
        inbound reachability. Address changes never rewrite DNS automatically.
      </p>
      {editable && (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setError('')
            setBusy(true)
            const form = new FormData(e.currentTarget)
            try {
              await api(`/connectors/${server.id}/addresses`, 'PUT', {
                dns_targets: {
                  ipv4: String(form.get('ipv4') || '') || null,
                  ipv6: String(form.get('ipv6') || '') || null,
                },
                private_addresses: String(form.get('private') || '')
                  .split(/[\s,]+/)
                  .filter(Boolean),
              })
              onSaved?.()
            } catch (e) {
              setError(
                e instanceof Error ? e.message : 'Unable to save addresses',
              )
            } finally {
              setBusy(false)
            }
          }}
        >
          <Label>
            DNS IPv4 override
            <Input
              name="ipv4"
              defaultValue={server.dns_targets?.ipv4 ?? ''}
              placeholder="Use detected address"
            />
          </Label>
          <Label>
            DNS IPv6 override
            <Input
              name="ipv6"
              defaultValue={server.dns_targets?.ipv6 ?? ''}
              placeholder="Use detected address"
            />
          </Label>
          <Label>
            Private / VPN addresses
            <Input
              name="private"
              defaultValue={server.private_addresses?.join(', ') ?? ''}
              placeholder="Configured separately; comma-separated addresses"
            />
          </Label>
          <ErrorMessage message={error} />
          <Button disabled={busy}>Save address settings</Button>
        </form>
      )}
    </div>
  )
}
