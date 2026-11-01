import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { KeyRound, ArrowRight } from 'lucide-react'
import { Field, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { Button, Input } from '../components/ui/controls'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card'
import { markFieldInvalid } from '@/components/ui/field-control'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import {
  api,
  ApiError,
  currentOrganization,
  organizationPath,
  type User,
} from '../api'
import { ErrorMessage, Icon } from '../components'
export const Route = createFileRoute('/enroll')({ component: Enroll })
type Invitation = {
  email: string | null
  existing_account: boolean
  organization: { slug: string; name: string }
}
const invitationKey = () => 'kloud-invitation-' + currentOrganization()
function savedInvitation() {
  const token = location.hash.slice(1)
  try {
    if (token) sessionStorage.setItem(invitationKey(), token)
    return token || sessionStorage.getItem(invitationKey()) || ''
  } catch {
    return token
  }
}
function Enroll() {
  const [invitation] = useState(savedInvitation)
  const [details, setDetails] = useState<Invitation>()
  const [account, setAccount] = useState<User>()
  const [loading, setLoading] = useState(!!invitation)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false)
  useEffect(() => {
    history.replaceState(null, '', organizationPath('/enroll'))
    if (!invitation) return
    let cancelled = false
    void Promise.all([
      api<Invitation>(
        '/auth/invitation?token=' + encodeURIComponent(invitation),
      ).catch((error) => {
        if (error instanceof ApiError && error.status === 404) return undefined
        throw error
      }),
      api<User>('/auth/me').catch(() => undefined),
    ])
      .then(([details, account]) => {
        if (cancelled) return
        if (details && typeof details.existing_account === 'boolean')
          setDetails(details)
        setAccount(account)
      })
      .catch((error) => {
        if (!cancelled)
          setError(
            error instanceof Error
              ? error.message
              : 'Unable to load invitation',
          )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [invitation])
  const existing = details?.existing_account === true
  const matchingAccount =
    account &&
    (!details?.email ||
      account.email?.toLowerCase() === details.email.toLowerCase())
  function finish() {
    try {
      sessionStorage.removeItem(invitationKey())
    } catch {
      /* Storage can be disabled. */
    }
    setDone(true)
  }
  async function accept() {
    setBusy(true)
    setError('')
    try {
      await api('/auth/invitations/accept', 'POST', { token: invitation })
      finish()
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to accept invitation',
      )
    } finally {
      setBusy(false)
    }
  }
  async function signIn() {
    setBusy(true)
    setError('')
    try {
      if (account) await api('/auth/logout', 'POST')
      location.assign(
        '/login?next=' + encodeURIComponent(organizationPath('/enroll')),
      )
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to sign in')
      setBusy(false)
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (form.get('password') !== form.get('confirm')) {
      setError('Passwords must match')
      markFieldInvalid(
        event.currentTarget.querySelector('[name="confirm"]'),
        'Passwords must match',
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      await api('/auth/enroll', 'POST', {
        token: invitation,
        password: form.get('password'),
      })
      finish()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Enrollment failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="auth-page bg-background text-foreground">
      <Card className="auth-card">
        <CardHeader>
          <div className="auth-mark">
            <Icon icon={KeyRound} />
          </div>
          <p className="eyebrow">KLOUD</p>
          <CardTitle asChild className="text-2xl leading-tight">
            <h1>
              {done
                ? 'You’re ready'
                : existing
                  ? 'Join organization'
                  : 'Set up your account'}
            </h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {done ? (
            <>
              <p>
                {existing
                  ? 'Your account now has access to this organization. Your password and security settings are unchanged.'
                  : 'Your password is registered. Sign in to access your organization.'}
              </p>
              {existing ? (
                <Button
                  variant="primary"
                  onClick={() => location.assign(organizationPath('/'))}
                >
                  Open organization
                  <Icon data-icon="inline-start" icon={ArrowRight} />
                </Button>
              ) : (
                <Button asChild variant="primary">
                  <Link to="/login" search={{ next: organizationPath('/') }}>
                    Continue to sign in{' '}
                    <Icon data-icon="inline-start" icon={ArrowRight} />
                  </Link>
                </Button>
              )}
            </>
          ) : !invitation ? (
            <Alert variant="destructive">
              <AlertDescription>
                Open the enrollment link provided by your administrator.
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <p role="status">Loading invitation…</p>
          ) : existing ? (
            <div className="flex flex-col gap-4">
              <p>
                You were invited{details.email ? ` as ${details.email}` : ''} to{' '}
                {details.organization.name}. Use your existing account to accept
                this invitation.
              </p>
              <ErrorMessage message={error} />
              {matchingAccount ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void accept()}
                >
                  {busy ? 'Joining…' : 'Accept invitation'}
                </Button>
              ) : (
                <>
                  {account && (
                    <p className="text-sm text-muted-foreground">
                      You are signed in as {account.email ?? account.username}.
                      Sign in with the invited account to continue.
                    </p>
                  )}
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => void signIn()}
                  >
                    Sign in to accept invitation
                    <Icon data-icon="inline-start" icon={ArrowRight} />
                  </Button>
                </>
              )}
            </div>
          ) : (
            <>
              <p>
                Choose a password to activate your account
                {details?.email ? ` for ${details.email}` : ''} in{' '}
                {details?.organization.name ?? currentOrganization()}.
              </p>
              <Form onSubmit={(event) => void submit(event)}>
                <Field>
                  <FieldLabel>Password</FieldLabel>
                  <Input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={256}
                  />
                </Field>
                <Field>
                  <FieldLabel>Confirm password</FieldLabel>
                  <Input
                    name="confirm"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={256}
                  />
                </Field>
                <small>
                  Use at least 12 characters. Your account can join multiple
                  organizations.
                </small>
                <ErrorMessage message={error} />
                <Button variant="primary" disabled={busy}>
                  {busy ? 'Creating account…' : 'Set password'}
                  <Icon data-icon="inline-start" icon={KeyRound} />
                </Button>
              </Form>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
