import { Button, Input, Label } from '../components/ui/controls'
import { Card } from '../components/ui/card'
import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { api } from '../api'
import { ErrorMessage, Icon } from '../components'
import { loginDestination } from '../navigation'
export const Route = createFileRoute('/login')({
  loader: () => api<{ required: boolean }>('/auth/setup'),
  staleTime: 0,
  validateSearch: (search: Record<string, unknown>) => ({
    next: loginDestination(search.next),
  }),
  component: Login,
})
function Login() {
  const setup = Route.useLoaderData().required
  const { next } = Route.useSearch(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [phase, setPhase] = useState('Sign in'),
    [created, setCreated] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    try {
      if (setup && !created) {
        if (data.get('password') !== data.get('confirm'))
          throw new Error('Passwords must match')
        setPhase('Registering passkey')
        const optionsJSON = await api<
          Parameters<typeof startRegistration>[0]['optionsJSON']
        >('/auth/setup/options', 'POST', {
          username: data.get('username'),
          password: data.get('password'),
        })
        await api(
          '/auth/setup/verify',
          'POST',
          await startRegistration({ optionsJSON }),
        )
        setCreated(true)
        setBusy(false)
        setPhase('Sign in')
        return
      }
      const optionsJSON = await api<
        Parameters<typeof startAuthentication>[0]['optionsJSON']
      >('/auth/password', 'POST', {
        username: data.get('username'),
        password: data.get('password'),
      })
      setPhase('Verify your passkey')
      const response = await startAuthentication({ optionsJSON })
      await api('/auth/verify', 'POST', response)
      location.assign(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed')
      setBusy(false)
      setPhase('Sign in')
    }
  }
  return (
    <main className="auth-page bg-background text-foreground">
      <Card className="auth-card">
        <div className="auth-mark">
          <Icon />
        </div>
        <p className="eyebrow">DEDI DASH</p>
        <h1>
          {setup && !created
            ? 'Create your Server Administrator account'
            : 'Welcome back'}
        </h1>
        <p className="text-muted-foreground">
          {created
            ? 'Your Server Administrator account is ready. Sign in with your password and passkey.'
            : setup
              ? 'No accounts exist yet. Choose a username and password, then register a passkey to get started.'
              : 'Sign in to your infrastructure.'}
        </p>
        <form
          onSubmit={(e) => {
            void submit(e)
          }}
        >
          <Label>
            Username
            <Input
              name="username"
              autoComplete="username"
              required
              maxLength={100}
              pattern={setup && !created ? '[a-zA-Z0-9_.@\\-]+' : undefined}
            />
          </Label>
          <Label>
            Password
            <Input
              name="password"
              type="password"
              autoComplete={
                setup && !created ? 'new-password' : 'current-password'
              }
              required
              minLength={setup && !created ? 12 : undefined}
              maxLength={256}
            />
          </Label>
          {setup && !created && (
            <>
              <Label>
                Confirm password
                <Input
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={256}
                />
              </Label>
              <small className="text-muted-foreground">
                Use at least 12 characters. Usernames may contain letters,
                numbers, underscores, periods, @, and hyphens.
              </small>
            </>
          )}
          <ErrorMessage message={error} />
          <Button className="primary" disabled={busy}>
            {busy
              ? phase + '…'
              : setup && !created
                ? 'Create Server Administrator and register passkey'
                : 'Continue with password and passkey'}
            <Icon name="arrow" />
          </Button>
        </form>
        <p className="auth-foot">
          <Icon name="shield" /> Password and passkey required
        </p>
      </Card>
    </main>
  )
}
