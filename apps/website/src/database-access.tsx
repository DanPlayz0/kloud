import { CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { FieldSet, Field, FieldLabel } from '@/components/ui/field'
import { useEffect, useState } from 'react'
import { api } from './api'
import { ErrorMessage, usePolling } from './components'
import { Card } from './components/ui/card'
import { Button, Checkbox, NativeSelect } from './components/ui/controls'
const capabilities = [
  'read',
  'manage',
  'backup',
  'restore',
  'destinations',
  'reveal',
] as const
const labels: Record<(typeof capabilities)[number], string> = {
  read: 'View database status, logs and backup history',
  manage: 'Create and operate databases',
  backup: 'Run backups and configure policies',
  restore: 'Import archives and restore into new databases',
  destinations: 'Administer backup destinations',
  reveal: 'Reveal database connection credentials',
}
interface Grant {
  user_id: string
  resource: string | null
  capability: (typeof capabilities)[number]
}
export function DatabaseAccess({
  project,
  resources,
}: {
  project: string
  resources: { id: string; name: string }[]
}) {
  const base = `/projects/${project}/databases`
  const [refresh, setRefresh] = useState(0),
    [member, setMember] = useState(''),
    [target, setTarget] = useState(''),
    [checked, setChecked] = useState<string[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [dirty, setDirty] = useState(false)
  const { data: access } = usePolling<{
    members: { id: string; username: string }[]
  }>(`/projects/${project}/access`)
  const { data: grants, error: loadError } = usePolling<Grant[]>(
    `${base}/access/grants`,
    refresh,
  )
  useEffect(() => {
    if (dirty) return
    setChecked(
      (grants ?? [])
        .filter((g) => g.user_id === member && g.resource === (target || null))
        .map((g) => g.capability),
    )
    setSaved(false)
  }, [grants, member, target, dirty])
  async function save() {
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      await api(`${base}/access/grants`, 'PUT', {
        user_id: member,
        grants: [
          ...(grants ?? [])
            .filter(
              (g) => g.user_id === member && g.resource !== (target || null),
            )
            .map(({ resource, capability }) => ({ resource, capability })),
          ...checked.map((capability) => ({
            resource: target || null,
            capability,
          })),
        ],
      })
      setDirty(false)
      setRefresh((n) => n + 1)
      setSaved(true)
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Unable to save database access',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="flex flex-col gap-3">
      <CardHeader>
        <CardTitle asChild>
          <h2 className="font-semibold">Database permissions</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          Project administrators have all database rights. Teammates receive
          only explicit grants; ordinary app deployment access does not reveal
          database credentials.
        </p>
        <ErrorMessage message={error || loadError} />
        <FieldSet disabled={busy} className="flex flex-col gap-3">
          <Field>
            <FieldLabel>Project member</FieldLabel>
            <NativeSelect
              value={member}
              onChange={(e) => {
                setDirty(false)
                setMember(e.target.value)
              }}
            >
              <option value="">Select a member</option>
              {access?.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.username}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel>Database scope</FieldLabel>
            <NativeSelect
              value={target}
              onChange={(e) => {
                setDirty(false)
                setTarget(e.target.value)
              }}
            >
              <option value="">All databases in this project</option>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {capabilities.map((capability) => (
            <Field
              orientation="horizontal"
              key={capability}
              className="flex items-center gap-2"
            >
              <Checkbox
                checked={checked.includes(capability)}
                onCheckedChange={(v) => {
                  setDirty(true)
                  setChecked(
                    v
                      ? [...checked, capability]
                      : checked.filter((c) => c !== capability),
                  )
                  setSaved(false)
                }}
              />
              <FieldLabel>{labels[capability]}</FieldLabel>
            </Field>
          ))}
          <p className="text-xs text-muted-foreground">
            Creating databases, importing new archives and administering shared
            destinations require a project-wide grant. Restoring a selected
            database's backup may use a database-specific Restore grant.
            Revealing credentials always requires Reveal.
          </p>
          <Button disabled={!member || !grants} onClick={() => void save()}>
            Save database permissions
          </Button>
          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              Database permissions saved.
            </p>
          )}
        </FieldSet>
      </CardContent>
    </Card>
  )
}
