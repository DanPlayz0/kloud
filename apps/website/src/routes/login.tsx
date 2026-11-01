import { ArrowRight, ShieldCheck } from 'lucide-react'
import { Field, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { Button, Input } from '../components/ui/controls'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '../components/ui/card'
import { markFieldInvalid } from '@/components/ui/field-control'
import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import type { AuthenticationResult } from '@kloud/protocol/auth'
import { FactorVerification } from '../components/factor-verification'
import { api, ApiError, organizationPath } from '../api'
import { ErrorMessage, Icon } from '../components'
import { loginDestination } from '../navigation'
export const Route = createFileRoute('/login')({
  loader: async () => {
    try {
      return await api<{ required: boolean }>('/auth/setup')
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        return { required: false }
      throw error
    }
  },
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
    [created, setCreated] = useState(false),
    [challenge, setChallenge] =
      useState<
        Extract<AuthenticationResult, { status: 'second_factor_required' }>
      >()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    try {
      if (setup && !created) {
        if (data.get('password') !== data.get('confirm')) {
          markFieldInvalid(
            event.currentTarget.querySelector('[name="confirm"]'),
            'Passwords must match',
          )
          throw new Error('Passwords must match')
        }
        setPhase('Creating account')
        await api('/auth/setup', 'POST', {
          username: data.get('username'),
          email: data.get('email'),
          password: data.get('password'),
        })
        setCreated(true)
        setBusy(false)
        setPhase('Sign in')
        return
      }
      const result = await api<AuthenticationResult>('/auth/password', 'POST', {
        username: data.get('username'),
        password: data.get('password'),
      })
      if (result.status === 'authenticated')
        location.assign(organizationPath(next))
      else {
        setChallenge(result)
        setBusy(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed')
      setBusy(false)
      setPhase('Sign in')
    }
  }
  return (
    <main className="auth-page bg-background text-foreground">
      <Card className="auth-card">
        <CardHeader>
          <div className="auth-mark">
            <Icon />
          </div>
          <p className="eyebrow">KLOUD</p>
          <CardTitle asChild className="text-2xl leading-tight">
            <h1>
              {setup && !created
                ? 'Create your Organization Administrator account'
                : 'Welcome back'}
            </h1>
          </CardTitle>
          <CardDescription>
            {created
              ? 'Your Organization Administrator account is ready. Sign in with your password.'
              : setup
                ? 'No accounts exist yet. Choose a username and password to get started. You can enable two-factor authentication in account security.'
                : 'One account gives you access to all your organizations.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {challenge ? (
            <FactorVerification
              challenge={challenge}
              onComplete={() => location.assign(organizationPath(next))}
              onCancel={() => {
                setChallenge(undefined)
                setError('')
              }}
            />
          ) : (
            <Form
              onSubmit={(e) => {
                void submit(e)
              }}
            >
              <Field>
                <FieldLabel>Username</FieldLabel>
                <Input
                  name="username"
                  autoComplete="username"
                  required
                  maxLength={100}
                  pattern={setup && !created ? '[a-zA-Z0-9_.@\\-]+' : undefined}
                />
              </Field>
              {setup && !created && (
                <Field>
                  <FieldLabel>Email address</FieldLabel>
                  <Input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel>Password</FieldLabel>
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
              </Field>
              {setup && !created && (
                <>
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
                  <small className="text-muted-foreground">
                    Use at least 12 characters. Usernames may contain letters,
                    numbers, underscores, periods, @, and hyphens.
                  </small>
                </>
              )}
              <ErrorMessage message={error} />
              <Button variant="primary" disabled={busy}>
                {busy
                  ? phase + '…'
                  : setup && !created
                    ? 'Create Organization Administrator'
                    : 'Sign in'}
                <Icon data-icon="inline-start" icon={ArrowRight} />
              </Button>
            </Form>
          )}
        </CardContent>
        <CardFooter>
          <p className="auth-foot">
            <Icon icon={ShieldCheck} /> Optional two-factor authentication
          </p>
        </CardFooter>
      </Card>
    </main>
  )
}
