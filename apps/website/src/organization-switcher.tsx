import { useId, useState, type FormEvent } from 'react'
import { Building2, Check } from 'lucide-react'
import {
  api,
  currentOrganization,
  switchOrganization,
  type Organization,
} from './api'
import { ErrorMessage, usePolling } from './components'
import {
  Button,
  Input,
  Textarea,
  Checkbox,
  Label,
} from './components/ui/controls'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog'
import { Field, FieldLabel } from './components/ui/field'
import { Form } from './components/ui/form'

export function organizationSlug(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')
}

/** Only organizations associated with the signed-in account are offered. */
export function OrganizationSelector() {
  const { data, error } = usePolling<Organization[]>('/organizations')
  const organizations = Array.isArray(data) ? data : []
  return (
    <div className="flex flex-col gap-2" aria-label="Your organizations">
      {organizations.map((organization) => (
        <Button
          key={organization.slug}
          type="button"
          variant="outline"
          className="w-full justify-between"
          disabled={organization.slug === currentOrganization()}
          onClick={() => switchOrganization(organization.slug)}
        >
          <span className="truncate">{organization.name}</span>
          {organization.slug === currentOrganization() && (
            <Check aria-label="Current organization" className="size-4" />
          )}
        </Button>
      ))}
      {!organizations.length && !error && (
        <p className="text-sm text-muted-foreground">
          Loading your organizations…
        </p>
      )}
      <ErrorMessage message={error} />
    </div>
  )
}

type Metadata = {
  name: string
  slug?: string
  description: string
  website: string
}
function OrganizationFields({
  organization,
  busy,
  onSubmit,
}: {
  organization?: Organization
  busy: boolean
  onSubmit: (body: Metadata) => Promise<void>
}) {
  const id = useId()
  const [name, setName] = useState(organization?.name ?? '')
  const [slug, setSlug] = useState(organization?.slug ?? '')
  const [editedSlug, setEditedSlug] = useState(false)
  const [description, setDescription] = useState(
    organization?.description ?? '',
  )
  const [website, setWebsite] = useState(organization?.website ?? '')
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void onSubmit({
      name,
      description,
      website,
      ...(!organization && editedSlug ? { slug } : {}),
    })
  }
  return (
    <Form onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor={id + '-name'}>Organization name</FieldLabel>
        <Input
          id={id + '-name'}
          name="name"
          required
          maxLength={100}
          disabled={busy}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            if (!organization && !editedSlug)
              setSlug(organizationSlug(event.target.value))
          }}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id + '-slug'}>Organization slug</FieldLabel>
        <Input
          id={id + '-slug'}
          name="slug"
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={63}
          disabled={busy}
          readOnly={!!organization}
          value={slug}
          onChange={(event) => {
            setEditedSlug(true)
            setSlug(event.target.value)
          }}
        />
        <p className="text-sm text-muted-foreground">
          {organization
            ? 'The slug remains unchanged so connector and callback URLs keep working.'
            : 'Generated from the name. You can change it; a number is added automatically if the generated slug is already used.'}
        </p>
      </Field>
      <Field>
        <FieldLabel htmlFor={id + '-description'}>Description</FieldLabel>
        <Textarea
          id={id + '-description'}
          name="description"
          maxLength={1000}
          disabled={busy}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id + '-website'}>Website</FieldLabel>
        <Input
          id={id + '-website'}
          name="website"
          type="url"
          maxLength={2048}
          disabled={busy}
          placeholder="https://example.com"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </Field>
      {!organization && (
        <p className="text-sm text-muted-foreground">
          Your current account becomes the new organization’s administrator.
        </p>
      )}
      <Button disabled={busy} type="submit">
        {busy
          ? 'Saving…'
          : organization
            ? 'Save organization'
            : 'Create organization'}
      </Button>
    </Form>
  )
}

export function OrganizationSwitcher({ admin = false }: { admin?: boolean }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data } = usePolling<Organization>(
    '/organizations/current',
    refreshKey,
  )
  const [view, setView] = useState<'overview' | 'create' | 'edit' | 'invite'>(
    'overview',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [invitationUrl, setInvitationUrl] = useState('')
  const [inviteAdmin, setInviteAdmin] = useState(false)
  const id = useId()
  async function save(body: Metadata) {
    setError('')
    setBusy(true)
    setMessage('')
    try {
      const result = await api<Organization>(
        view === 'create' ? '/organizations' : '/organizations/current',
        view === 'create' ? 'POST' : 'PATCH',
        body,
      )
      if (view === 'create') switchOrganization(result.slug)
      else {
        setView('overview')
        setMessage('Organization details saved.')
        setRefreshKey((value) => value + 1)
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to save organization',
      )
    } finally {
      setBusy(false)
    }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setBusy(true)
    setMessage('')
    setInvitationUrl('')
    const fields = new FormData(event.currentTarget)
    try {
      const result = await api<{
        invitationUrl: string
        email: string
        sent: boolean
      }>('/organizations/invitations', 'POST', {
        email: fields.get('email'),
        admin: inviteAdmin,
      })
      setInvitationUrl(result.invitationUrl)
      setMessage(
        result.sent
          ? `Invitation sent to ${result.email}.`
          : `Invitation created for ${result.email}. Share the invitation link with them.`,
      )
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to invite member',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="border-b border-sidebar-border px-3 py-3">
      <Dialog
        onOpenChange={() => {
          setView('overview')
          setError('')
          setMessage('')
          setInvitationUrl('')
          setInviteAdmin(false)
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
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogTitle>
            {view === 'create'
              ? 'Create organization'
              : view === 'edit'
                ? 'Edit organization'
                : view === 'invite'
                  ? 'Invite by email'
                  : 'Organization'}
          </DialogTitle>
          <DialogDescription>
            Use one account across your organizations. Projects, servers,
            credentials, and permissions stay scoped to the selected
            organization.
          </DialogDescription>
          <div className="mt-4 flex flex-col gap-4">
            {view === 'create' || view === 'edit' ? (
              <OrganizationFields
                key={view}
                organization={view === 'edit' ? data : undefined}
                busy={busy}
                onSubmit={save}
              />
            ) : view === 'invite' ? (
              <Form onSubmit={(event) => void invite(event)}>
                <Field>
                  <FieldLabel htmlFor={id + '-email'}>Email address</FieldLabel>
                  <Input
                    id={id + '-email'}
                    type="email"
                    name="email"
                    required
                    maxLength={254}
                    autoComplete="email"
                    disabled={busy}
                  />
                </Field>
                <Label className="flex items-center gap-2">
                  <Checkbox
                    checked={inviteAdmin}
                    onCheckedChange={(value) => setInviteAdmin(value === true)}
                    disabled={busy}
                  />
                  Organization administrator
                </Label>
                <p className="text-sm text-muted-foreground">
                  The recipient can accept using their existing account or
                  create an account. An organization invitation does not grant
                  project access.
                </p>
                <Button disabled={busy} type="submit">
                  {busy ? 'Inviting…' : 'Create invitation'}
                </Button>
                {invitationUrl && (
                  <Field>
                    <FieldLabel htmlFor={id + '-invitation'}>
                      Invitation link
                    </FieldLabel>
                    <Input
                      id={id + '-invitation'}
                      value={invitationUrl}
                      readOnly
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </Field>
                )}
              </Form>
            ) : (
              <>
                <OrganizationSelector />
                {data?.description && (
                  <p className="text-sm text-muted-foreground">
                    {data.description}
                  </p>
                )}
                {data?.website && (
                  <a
                    href={data.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm underline"
                  >
                    {data.website}
                  </a>
                )}
                {data?.api_url && (
                  <Field>
                    <FieldLabel htmlFor={id + '-api'}>
                      Connector API URL
                    </FieldLabel>
                    <Input id={id + '-api'} readOnly value={data.api_url} />
                  </Field>
                )}
                {admin && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setView('edit')}
                    >
                      Edit organization
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setView('invite')}
                    >
                      Invite by email
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setView('create')}
                    >
                      Create organization
                    </Button>
                  </div>
                )}
              </>
            )}
            <ErrorMessage message={error} />
            {message && <p role="status">{message}</p>}
            {view !== 'overview' && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setView('overview')
                  setError('')
                  setMessage('')
                  setInvitationUrl('')
                }}
              >
                Back
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
