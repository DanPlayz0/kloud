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
        <CardHeader>
          <div className="auth-mark">
            <Icon icon={KeyRound} />
          </div>
          <p className="eyebrow">KLOUD</p>
          <CardTitle asChild>
            <h1>{done ? 'You’re ready' : 'Set up your account'}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {done ? (
            <>
              <p>
                Your password is registered. You can enable two-factor
                authentication in account security after signing in.
              </p>
              <Button asChild variant="primary">
                <Link to="/login" search={{ next: '/' }}>
                  Continue to sign in{' '}
                  <Icon data-icon="inline-start" icon={ArrowRight} />
                </Link>
              </Button>
            </>
          ) : !invitation ? (
            <Alert variant="destructive">
              <AlertDescription>
                Open the enrollment link provided by your administrator.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <p>Choose a password to activate your account.</p>
              <Form
                onSubmit={(e) => {
                  void submit(e)
                }}
              >
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
                <small>Use at least 12 characters.</small>
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
