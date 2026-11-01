import { useEffect, useRef, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { api } from './api'
import { Button, Input, NativeSelect } from './components/ui/controls'
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from './components/ui/field'
import { ErrorMessage } from './components'

// GitHub requires a cross-origin form POST for manifests. This transport form is
// internal to the reusable control; all visible controls use the shared UI.
function submitManifest(popup: Window, action: string, manifest: unknown) {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = action
  form.target = popup.name
  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = 'manifest'
  input.value = JSON.stringify(manifest)
  form.append(input)
  document.body.append(form)
  form.submit()
  form.remove()
}

export function GithubAppConnect({
  project,
  service,
  onConnected,
  administration = false,
  allowShared = false,
  projectAccess = false,
}: {
  project: string
  service?: string
  administration?: boolean
  allowShared?: boolean
  projectAccess?: boolean
  onConnected: (id: string) => Promise<void>
}) {
  const [name, setName] = useState('Kloud')
  const [organization, setOrganization] = useState('')
  const [scope, setScope] = useState(administration ? 'shared' : 'personal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const cleanup = useRef<() => void>(() => {})
  useEffect(() => () => cleanup.current(), [])

  async function connect() {
    const popup = window.open(
      'about:blank',
      `kloud-github-${crypto.randomUUID()}`,
      'popup,width=1000,height=800',
    )
    if (!popup) {
      setError('Allow popups to connect your GitHub App.')
      return
    }
    setError('')
    setBusy(true)
    setStatus(
      'Create the app on GitHub, then install it for the repositories you want to use.',
    )
    const base = `/projects/${project}/git-connections/github-app`
    let expectedState = '',
      callbackOrigin = '',
      processing = false,
      cancelled = false
    const stop = () => {
      cancelled = true
      window.removeEventListener('message', receive)
      window.clearInterval(timer)
      popup.close()
    }
    const fail = (error: unknown) => {
      stop()
      setBusy(false)
      setStatus('')
      setError(
        error instanceof Error ? error.message : 'Unable to connect GitHub.',
      )
    }
    const receive = (event: MessageEvent) => {
      if (
        cancelled ||
        processing ||
        event.source !== popup ||
        event.origin !== callbackOrigin ||
        event.data?.type !== 'kloud-github-app' ||
        event.data.state !== expectedState
      )
        return
      processing = true
      void (async () => {
        const result = await api<{
          state?: string
          install_url?: string
          id?: string
        }>(`${base}/finish`, 'POST', {
          service,
          state: expectedState,
          ...(event.data.code ? { code: event.data.code } : {}),
          ...(event.data.installation_id
            ? {
                installation_id: Number(event.data.installation_id),
                setup_action: event.data.setup_action,
              }
            : {}),
        })
        if (cancelled) return
        if (result.install_url && result.state) {
          expectedState = result.state
          popup.location.href = result.install_url
          setStatus(
            'Install the GitHub App and grant access to your repositories.',
          )
          processing = false
        } else if (result.id) {
          await onConnected(result.id)
          if (cancelled) return
          stop()
          setBusy(false)
          setStatus(
            administration
              ? 'GitHub connection saved. Select its repository when setting up a service.'
              : 'GitHub connected. Select a repository below.',
          )
        } else throw new Error('GitHub setup returned an incomplete response.')
      })().catch(fail)
    }
    const timer = window.setInterval(() => {
      if (popup.closed && !processing)
        fail(new Error('GitHub setup was closed. Start again to connect.'))
    }, 500)
    cleanup.current = stop
    window.addEventListener('message', receive)
    try {
      const result = await api<{
        state: string
        action: string
        manifest: { redirect_url: string }
      }>(`${base}/start`, 'POST', {
        service,
        name,
        scope,
        ...(administration ? { project_access: projectAccess } : {}),
        ...(organization.trim() ? { organization: organization.trim() } : {}),
      })
      if (cancelled) return
      expectedState = result.state
      callbackOrigin = new URL(result.manifest.redirect_url).origin
      submitManifest(popup, result.action, result.manifest)
    } catch (error) {
      fail(error)
    }
  }

  return (
    <FieldGroup className="rounded-md border border-border p-3">
      <Field>
        <FieldLabel>GitHub App name</FieldLabel>
        <Input
          value={name}
          disabled={busy}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        <FieldDescription>
          GitHub lets you confirm or change the name before creating the app.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel>GitHub organization (optional)</FieldLabel>
        <Input
          value={organization}
          disabled={busy}
          placeholder="Personal account if left empty"
          onChange={(e) => setOrganization(e.target.value)}
        />
      </Field>
      {!administration && (
        <Field>
          <FieldLabel>Ownership</FieldLabel>
          <NativeSelect
            value={scope}
            disabled={busy}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="personal">Personal</option>
            {allowShared && <option value="shared">Shared</option>}
          </NativeSelect>
        </Field>
      )}
      <ErrorMessage message={error} />
      {status && (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      )}
      <Button
        type="button"
        disabled={busy || !name.trim()}
        onClick={() => void connect()}
      >
        <GitBranch data-icon="inline-start" />
        {busy ? 'Waiting for GitHub…' : 'Create GitHub App'}
      </Button>
      {busy && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            cleanup.current()
            setBusy(false)
            setStatus('')
          }}
        >
          Cancel GitHub setup
        </Button>
      )}
    </FieldGroup>
  )
}
