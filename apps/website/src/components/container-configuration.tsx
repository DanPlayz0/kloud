import { useEffect, useId, useState, type FormEvent } from 'react'
import {
  containerSettingsSchema,
  type ContainerSettings,
} from '@kloud/protocol/platform'
import { api } from '../api'
import { ErrorMessage } from '../components'
import { Button, Input, NativeSelect } from './ui/controls'
import { Field, FieldDescription, FieldLabel } from './ui/field'
import { Form } from './ui/form'

export function ContainerConfiguration({ path }: { path: string }) {
  const id = useId()
  const [settings, setSettings] = useState<ContainerSettings>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    let cancelled = false
    setSettings(undefined)
    setError('')
    void api<{ settings: ContainerSettings }>(path, 'POST', {
      action: 'inspect',
    })
      .then((result) => {
        const checked = containerSettingsSchema.safeParse(result.settings)
        if (!checked.success)
          throw new Error(
            'Update this connector before changing container configuration.',
          )
        if (!cancelled) setSettings(checked.data)
      })
      .catch((error) => {
        if (!cancelled) setError(error.message)
      })
    return () => {
      cancelled = true
    }
  }, [path])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!settings) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const checked = containerSettingsSchema.safeParse(settings)
      if (!checked.success)
        throw new Error(
          checked.error.issues.map((issue) => issue.message).join('. '),
        )
      const result = await api<{ warnings?: string[] }>(path, 'POST', {
        action: 'update',
        settings: checked.data,
      })
      setMessage(
        result.warnings?.length
          ? `Settings saved. ${result.warnings.join(' ')}`
          : 'Container settings saved.',
      )
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to update container',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Form onSubmit={(event) => void submit(event)}>
      <p className="text-sm text-muted-foreground">
        Change this container's live resource limits and restart policy.
        Deployment configuration may replace these settings on the next
        deployment.
      </p>
      {settings ? (
        <>
          <Field>
            <FieldLabel htmlFor={id + '-cpus'}>CPU limit</FieldLabel>
            <Input
              type="number"
              min={0}
              max={1024}
              step="0.01"
              value={settings.cpus}
              disabled={busy}
              required
              onChange={(event) =>
                setSettings({ ...settings, cpus: Number(event.target.value) })
              }
            />
            <FieldDescription>
              Number of CPUs. Use 0 for unlimited.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={id + '-memory'}>Memory limit (MiB)</FieldLabel>
            <Input
              type="number"
              min={0}
              id={id + '-memory'}
              max={1048576}
              step={1}
              value={settings.memory_mib}
              disabled={busy}
              required
              onChange={(event) =>
                setSettings({
                  ...settings,
                  memory_mib: Number(event.target.value),
                })
              }
            />
            <FieldDescription>
              Use 0 for unlimited, or at least 6 MiB. Docker may reject limits
              incompatible with the existing swap configuration.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={id + '-restart'}>Restart policy</FieldLabel>
            <NativeSelect
              value={settings.restart_policy}
              disabled={busy}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  restart_policy: event.target
                    .value as ContainerSettings['restart_policy'],
                  retry_count: 0,
                })
              }
            >
              <option value="no">Never</option>
              <option value="always">Always</option>
              <option value="unless-stopped">Unless stopped</option>
              <option value="on-failure">On failure</option>
            </NativeSelect>
          </Field>
          {settings.restart_policy === 'on-failure' && (
            <Field>
              <FieldLabel htmlFor={id + '-retries'}>Maximum retries</FieldLabel>
              <Input
                type="number"
                min={0}
                id={id + '-retries'}
                max={100}
                step={1}
                value={settings.retry_count}
                disabled={busy}
                required
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    retry_count: Number(event.target.value),
                  })
                }
              />
              <FieldDescription>Use 0 for unlimited retries.</FieldDescription>
            </Field>
          )}
          <Button variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save container settings'}
          </Button>
        </>
      ) : (
        !error && <p role="status">Loading configuration…</p>
      )}
      <ErrorMessage message={error} />
      {message && <p role="status">{message}</p>}
    </Form>
  )
}
