import { Separator } from '@/components/ui/separator'
import { FieldGroup, Field, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { useState, useEffect } from 'react'
import { api } from './api'
import { usePolling, ErrorMessage } from './components'
import { Button, Input, NativeSelect, Checkbox } from './components/ui/controls'
import { effectiveAddresses, type ServerAddresses } from './server-addresses'

export function DomainDns({
  project,
  service,
  route,
  hostname,
  server,
  status,
  onSaved,
}: {
  project: string
  service: string
  route: string
  hostname: string
  server?: ServerAddresses
  status?: Record<string, { status: string; address: string }>
  onSaved: () => void
}) {
  const addresses = effectiveAddresses(server)
  const [zone, setZone] = useState('')
  const [ipv4, setIpv4] = useState(addresses.ipv4)
  const [ipv6, setIpv6] = useState(addresses.ipv6)
  const [useV6, setUseV6] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setIpv4((value) => value || addresses.ipv4)
    setIpv6((value) => value || addresses.ipv6)
  }, [addresses.ipv4, addresses.ipv6])
  const { data } = usePolling<{ zones: { id: string; name: string }[] }>(
    `/projects/${project}/dns`,
  )
  const stale = (['ipv4', 'ipv6'] as const).some((f) => {
    const detected = server?.public_addresses?.[f]
    return (
      !server?.dns_targets?.[f] &&
      detected?.address &&
      (detected.status !== 'ready' ||
        !detected.last_success ||
        Date.now() - Date.parse(detected.last_success) > 30 * 60 * 1000)
    )
  })
  return (
    <div className="flex flex-col gap-3   pt-3">
      <Separator className="basis-full" />
      <h3 className="font-medium">DNS records</h3>
      <p className="text-xs text-muted-foreground">
        Manual DNS: point A / AAAA records for {hostname} to this server.
        HTTP-01 HTTPS requires public port 80. Detection does not prove inbound
        connectivity.
      </p>
      <p className="text-xs text-muted-foreground">
        Selected server suggests A {addresses.ipv4 || 'unknown'} · AAAA{' '}
        {addresses.ipv6 || 'unavailable'}.
      </p>
      {((status?.A?.address &&
        addresses.ipv4 &&
        status.A.address !== addresses.ipv4) ||
        (status?.AAAA?.address &&
          addresses.ipv6 &&
          status.AAAA.address !== addresses.ipv6)) && (
        <p role="status" className="text-sm">
          The server address differs from this domain's configured record.
          Review it explicitly in Cloud DNS; existing records have not been
          changed.
        </p>
      )}
      {Object.entries(status ?? {}).map(([type, value]) => (
        <p key={type} className="text-xs">
          {type}: {value.status} · {value.address} (record configuration;
          propagation is separate)
        </p>
      ))}
      <Form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError('')
          try {
            if (ipv4)
              await api(
                `/projects/${project}/services/${service}/domains/${route}/dns`,
                'POST',
                { zone, type: 'A', address: ipv4 },
              )
            if (useV6 && ipv6)
              await api(
                `/projects/${project}/services/${service}/domains/${route}/dns`,
                'POST',
                { zone, type: 'AAAA', address: ipv6 },
              )
            onSaved()
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to configure DNS')
          } finally {
            setBusy(false)
          }
        }}
      >
        <FieldGroup className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel>A address</FieldLabel>
            <Input
              value={ipv4}
              onChange={(e) => {
                setIpv4(e.target.value)
                setReviewed(false)
              }}
              placeholder="IPv4 unavailable; enter manually"
            />
          </Field>
          <Field>
            <FieldLabel>AAAA address</FieldLabel>
            <Input
              value={ipv6}
              onChange={(e) => {
                setIpv6(e.target.value)
                setReviewed(false)
              }}
              placeholder="Optional IPv6"
            />
          </Field>
        </FieldGroup>
        <Field orientation="horizontal" className="flex items-center gap-2">
          <Checkbox
            checked={useV6}
            onCheckedChange={(v) => {
              setUseV6(v === true)
              setReviewed(false)
            }}
          />
          <FieldLabel>Publish AAAA after verifying IPv6 ingress</FieldLabel>
        </Field>
        {stale && (
          <p className="text-xs text-muted-foreground">
            A detected address is stale or detection failed. Verify the target
            before creating DNS.
          </p>
        )}
        {!data?.zones.length ? (
          <p className="text-xs text-muted-foreground">
            No authorized DNS connection is available. Use the manual DNS
            instructions above.
          </p>
        ) : (
          <>
            <Field>
              <FieldLabel>Cloudflare zone</FieldLabel>
              <NativeSelect
                required
                value={zone}
                onChange={(e) => {
                  setZone(e.target.value)
                  setReviewed(false)
                }}
              >
                <option value="">Select an authorized zone</option>
                {data.zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="rounded border border-border bg-muted p-3 text-sm">
              {ipv4 && (
                <p>
                  A · {hostname} → {ipv4} · DNS only · automatic TTL
                </p>
              )}
              {useV6 && ipv6 && (
                <p>
                  AAAA · {hostname} → {ipv6} · DNS only · automatic TTL
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Identical records are preserved. Conflicts require an explicit
                update in Cloud DNS.
              </p>
            </div>
            <Field orientation="horizontal" className="flex items-center gap-2">
              <Checkbox
                checked={reviewed}
                onCheckedChange={(v) => setReviewed(v === true)}
              />
              <FieldLabel>
                I reviewed the exact DNS records and verified the target
                addresses
              </FieldLabel>
            </Field>
            <Button
              disabled={
                busy || !reviewed || !zone || (!ipv4 && !(useV6 && ipv6))
              }
            >
              Create DNS records
            </Button>
          </>
        )}
        <ErrorMessage message={error} />
      </Form>
    </div>
  )
}
