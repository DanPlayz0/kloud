import { useEffect, useState } from 'react'
import { api } from './api'
import { ErrorMessage } from './components'
import {
  Button,
  Input,
  Label,
  NativeSelect,
  Checkbox,
} from './components/ui/controls'

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
    <div className="space-y-3 border-t border-border pt-3">
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
            {registry.owner ? 'personal' : 'shared'}
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
        <div className="grid gap-3 rounded border border-border p-3 md:grid-cols-2">
          <Label>
            Name
            <Input data-registry-name />
          </Label>
          <Label>
            Server
            <Input data-registry-server placeholder="ghcr.io" />
          </Label>
          <Label>
            Username
            <Input data-registry-username />
          </Label>
          <Label>
            Password / token
            <Input
              data-registry-password
              type="password"
              autoComplete="new-password"
            />
          </Label>
          <Label>
            Ownership
            <NativeSelect data-registry-scope>
              <option value="personal">Personal</option>
              <option value="shared">Shared (server administrators)</option>
            </NativeSelect>
          </Label>
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
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Credential owners authorize persistent app bindings. Removing an owner
        from the project, disabling them, or revoking credentials prevents
        future pulls without stopping the serving app.
      </p>
    </div>
  )
}
