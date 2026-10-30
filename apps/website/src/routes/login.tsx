import { Button, Input, Label } from '../components/ui/controls'
import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import { api } from '../api'
import { ErrorMessage, Icon } from '../components'
export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>) => ({
    next:
      typeof search.next === 'string' &&
      search.next.startsWith('/') &&
      !search.next.includes('\\') &&
      !search.next.startsWith('//')
        ? search.next
        : '/',
  }),
  component: Login,
})
function Login() {
  const { next } = Route.useSearch(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [phase, setPhase] = useState('Sign in')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    try {
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
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-mark">
          <Icon />
        </div>
        <p className="eyebrow">DEDI DASH</p>
        <h1>Welcome back</h1>
        <p>Sign in to your infrastructure.</p>
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
            />
          </Label>
          <Label>
            Password
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
            />
          </Label>
          <ErrorMessage message={error} />
          <Button className="primary" disabled={busy}>
            {busy ? phase + '…' : 'Continue with password and passkey'}
            <span>→</span>
          </Button>
        </form>
        <p className="auth-foot">
          <Icon name="shield" /> Password and passkey required
        </p>
      </div>
    </main>
  )
}
