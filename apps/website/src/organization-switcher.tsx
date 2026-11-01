import { useId, useState, type FormEvent } from 'react'
import { Building2 } from 'lucide-react'
import {
  api,
  currentOrganization,
  switchOrganization,
  validOrganizationSlug,
  type Organization,
} from './api'
import { ErrorMessage, usePolling } from './components'
import { Button, Input } from './components/ui/controls'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog'
import { Field, FieldLabel } from './components/ui/field'
import { Form } from './components/ui/form'

/** Available before sign-in, because accounts and sessions belong to an organization. */
export function OrganizationSelector() {
  const id = useId()
  const [slug, setSlug] = useState(currentOrganization)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (!validOrganizationSlug(slug))
        throw new Error(
          'Use lowercase letters, numbers, and single hyphens for the organization slug.',
        )
      const organization = await api<Organization>(
        '/organizations/lookup/' + encodeURIComponent(slug),
      )
      switchOrganization(organization.slug)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Unable to switch organizations',
      )
      setBusy(false)
    }
  }
  return (
    <Form onSubmit={(event) => void submit(event)}>
      <Field>
        <FieldLabel htmlFor={id}>Organization slug</FieldLabel>
        <Input
          id={id}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={63}
          autoComplete="off"
          disabled={busy}
        />
      </Field>
      <ErrorMessage message={error} />
      <Button
        type="submit"
        variant="outline"
        disabled={busy || slug === currentOrganization()}
      >
        {busy ? 'Opening…' : 'Switch organization'}
      </Button>
    </Form>
  )
}

export function OrganizationSwitcher({ admin = false }: { admin?: boolean }) {
  const { data } = usePolling<Organization>('/organizations/current')
  const [create, setCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const id = useId()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setError('')
    setBusy(true)
    try {
      const result = await api<Organization>(
        '/organizations',
        'POST',
        Object.fromEntries(fields),
      )
      switchOrganization(result.slug)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Unable to create organization',
      )
      setBusy(false)
    }
  }
  return (
    <div className="border-b border-sidebar-border px-3 py-3">
      <Dialog
        onOpenChange={() => {
          setCreate(false)
          setError('')
        }}
      >
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            className="w-full justify-start"
            aria-label="Organization settings"
          >
            <Building2 data-icon="inline-start" aria-hidden="true" />
            <span className="truncate">
              {data?.name ?? currentOrganization()}
            </span>
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>
            {create ? 'Create organization' : 'Organization'}
          </DialogTitle>
          <DialogDescription>
            Organizations have separate accounts, servers, projects, and saved
            connections. Sign in separately after switching.
          </DialogDescription>
          <div className="mt-4 flex flex-col gap-4">
            {create ? (
              <Form onSubmit={(event) => void submit(event)}>
                <Field>
                  <FieldLabel htmlFor={id + '-name'}>
                    Organization name
                  </FieldLabel>
                  <Input
                    id={id + '-name'}
                    name="name"
                    required
                    maxLength={100}
                    disabled={busy}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={id + '-slug'}>
                    Organization slug
                  </FieldLabel>
                  <Input
                    id={id + '-slug'}
                    name="slug"
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    maxLength={63}
                    disabled={busy}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={id + '-username'}>
                    Administrator username
                  </FieldLabel>
                  <Input
                    id={id + '-username'}
                    name="username"
                    required
                    autoComplete="off"
                    pattern="[a-zA-Z0-9_.@\-]+"
                    maxLength={100}
                    disabled={busy}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={id + '-password'}>
                    Administrator password
                  </FieldLabel>
                  <Input
                    id={id + '-password'}
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    maxLength={256}
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </Field>
                <p className="text-sm text-muted-foreground">
                  Use at least 12 characters. Save these credentials to sign in
                  to the new organization.
                </p>
                <ErrorMessage message={error} />
                <Button disabled={busy} type="submit">
                  {busy ? 'Creating…' : 'Create organization'}
                </Button>
                <Button
                  disabled={busy}
                  type="button"
                  variant="ghost"
                  onClick={() => setCreate(false)}
                >
                  Back
                </Button>
              </Form>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Current organization: {data?.name ?? currentOrganization()} (
                  {currentOrganization()})
                </p>
                <OrganizationSelector />
                {data?.api_url && (
                  <Field>
                    <FieldLabel htmlFor={id + '-api'}>
                      Connector API URL
                    </FieldLabel>
                    <Input id={id + '-api'} readOnly value={data.api_url} />
                  </Field>
                )}
                {admin && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCreate(true)}
                  >
                    Create organization
                  </Button>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
