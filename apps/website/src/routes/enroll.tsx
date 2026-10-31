import { Button, Input, Label } from '../components/ui/controls'
import { Card } from '../components/ui/card'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { startRegistration } from '@simplewebauthn/browser'
import { api } from '../api'
import { ErrorMessage, Icon } from '../components'
export const Route = createFileRoute('/enroll')({ component: Enroll })
function Enroll() {
  const [invitation] = useState(() => location.hash.slice(1))
  useEffect(() => {
    history.replaceState(null, '', '/enroll')
  }, [])
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (form.get('password') !== form.get('confirm')) {
      setError('Passwords must match')
      return
    }
    setBusy(true)
    setError('')
    try {
      const optionsJSON = await api<
        Parameters<typeof startRegistration>[0]['optionsJSON']
      >('/auth/enroll/options', 'POST', {
        token: invitation,
        password: form.get('password'),
      })
      await api(
        '/auth/enroll/verify',
        'POST',
        await startRegistration({ optionsJSON }),
      )
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enrollment failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="auth-page bg-background text-foreground">
      <Card className="auth-card">
        <div className="auth-mark">
          <Icon name="key" />
        </div>
        <p className="eyebrow">KLOUD</p>
        <h1>{done ? 'You’re ready' : 'Set up your account'}</h1>
        {done ? (
          <>
            <p>Your password and passkey are registered.</p>
            <Button asChild variant="primary">
              <a href="/login">
                Continue to sign in <Icon name="arrow" />
              </a>
            </Button>
          </>
        ) : !invitation ? (
          <p role="alert">
            Open the enrollment link provided by your administrator.
          </p>
        ) : (
          <>
            <p>Choose a password, then register your passkey.</p>
            <form
              onSubmit={(e) => {
                void submit(e)
              }}
            >
              <Label>
                Password
                <Input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={256}
                />
              </Label>
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
              <small>Use at least 12 characters.</small>
              <ErrorMessage message={error} />
              <Button className="primary" disabled={busy}>
                {busy ? 'Registering passkey…' : 'Register passkey'}
                <Icon name="key" />
              </Button>
            </form>
          </>
        )}
      </Card>
    </main>
  )
}
