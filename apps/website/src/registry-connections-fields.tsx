import { Separator } from '@/components/ui/separator'
import { FieldGroup, Field, FieldLabel } from '@/components/ui/field'
import { useEffect, useState } from 'react'
import { api } from './api'
import { ErrorMessage } from './components'
import { Button, Input, NativeSelect, Checkbox } from './components/ui/controls'

interface Registry {
  id: string
  name: string
  server: string
  owner: string | null
}
export function RegistryConnectionsFields({
  project,
  service,
  value,
  onChange,
}: {
  project: string
  service: string
  value: string[]
  onChange: (ids: string[]) => void
}) {
  const base = `/projects/${project}/registry-connections`
  const [registries, setRegistries] = useState<Registry[]>([]),
    [adding, setAdding] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function refresh() {
    setRegistries(
      await api<Registry[]>(`${base}?service=${encodeURIComponent(service)}`),
    )
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message))
  }, [project, service])
  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registry operation failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-3   pt-3">
      <Separator className="basis-full" />
      <h4 className="text-sm font-medium">Reusable registry connections</h4>
      <ErrorMessage message={error} />
      {registries.map((registry) => (
        <div key={registry.id} className="flex flex-wrap items-center gap-2">
          <Checkbox
            aria-label={`Use registry ${registry.name}`}
            checked={value.includes(registry.id)}
            onCheckedChange={(checked) =>
              onChange(
                checked === true
                  ? [...value, registry.id]
                  : value.filter((id) => id !== registry.id),
              )
            }
          />
          <span className="text-sm">
            {registry.name} · {registry.server} ·{' '}
            {registry.owner
              ? 'personal, reusable'
              : 'shared across authorized teams'}
          </span>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  'Revoke this registry connection for all future deployments? Serving apps keep running.',
                )
              )
                void run(async () => {
                  await api(`${base}/${registry.id}`, 'DELETE')
                  onChange(value.filter((id) => id !== registry.id))
                  await refresh()
                })
            }}
          >
            Revoke
          </Button>
        </div>
      ))}
      {value
        .filter((id) => !registries.some((registry) => registry.id === id))
        .map((id) => (
          <p key={id} className="text-xs text-muted-foreground">
            Unavailable connection {id}. Remove it or select another authorized
            credential.{' '}
            <Button
              type="button"
              onClick={() => onChange(value.filter((item) => item !== id))}
            >
              Remove
            </Button>
          </p>
        ))}
      <Button type="button" onClick={() => setAdding(!adding)}>
        {adding ? 'Cancel' : 'Add reusable registry'}
      </Button>
      {adding && (
        <FieldGroup className="grid gap-3 rounded border border-border p-3 md:grid-cols-2">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input data-registry-name />
          </Field>
          <Field>
            <FieldLabel>Server</FieldLabel>
            <Input data-registry-server placeholder="ghcr.io" />
          </Field>
          <Field>
            <FieldLabel>Username</FieldLabel>
            <Input data-registry-username />
          </Field>
          <Field>
            <FieldLabel>Password / token</FieldLabel>
            <Input
              data-registry-password
              type="password"
              autoComplete="new-password"
            />
          </Field>
          <Field>
            <FieldLabel>Ownership</FieldLabel>
            <NativeSelect data-registry-scope>
              <option value="personal">Personal</option>
              <option value="shared">Shared (server administrators)</option>
            </NativeSelect>
          </Field>
          <Button
            type="button"
            disabled={busy}
            onClick={(event) => {
              const box = event.currentTarget.parentElement!
              const read = (key: string) =>
                (
                  box.querySelector(`[data-registry-${key}]`) as
                    HTMLInputElement | HTMLSelectElement
                ).value
              void run(async () => {
                const result = await api<{ id: string }>(base, 'POST', {
                  service,
                  name: read('name'),
                  server: read('server'),
                  username: read('username'),
                  password: read('password'),
                  scope: read('scope'),
                })
                ;(
                  box.querySelector(
                    '[data-registry-password]',
                  ) as HTMLInputElement
                ).value = ''
                await refresh()
                onChange([...value, result.id])
                setAdding(false)
              })
            }}
          >
            Save encrypted registry
          </Button>
        </FieldGroup>
      )}
      <p className="text-xs text-muted-foreground">
        Saved credentials can be reused across project teams through authorized
        app bindings. A personal owner must keep access to each consuming
        project. Removing that access, disabling the owner, or revoking the
        connection blocks future pulls without stopping the serving app.
      </p>
    </div>
  )
}
