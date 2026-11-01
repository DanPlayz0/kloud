import { CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { startRegistration } from '@simplewebauthn/browser'
import QRCode from 'qrcode'
import type {
  AuthenticationResult,
  FactorMethod,
  SecurityStatus,
} from '@kloud/protocol/auth'
import { api, ApiError, session, type Project } from '../api'
import { ErrorMessage } from '../components'
import { Card } from '../components/ui/card'
import { Button, Input } from '../components/ui/controls'
import {
  FactorVerification,
  factorLabels,
} from '../components/factor-verification'

export const Route = createFileRoute('/_app/account/security')({
  remountDeps: ({ params }) => params,
  staticData: { shell: { title: 'Account security', active: 'security' } },
  loader: async () => ({
    user: await session(),
    projects: await api<Project[]>('/projects'),
    security: await api<SecurityStatus>('/auth/security'),
  }),
  component: AccountSecurity,
})
type Enrollment = { method: 'email' | 'totp'; secret?: string; qr?: string }
function AccountSecurity() {
  const { user, projects, security: initial } = Route.useLoaderData()
  const [security, setSecurity] = useState(initial),
    [unlocked, setUnlocked] = useState(false)
  const [challenge, setChallenge] =
    useState<
      Extract<AuthenticationResult, { status: 'second_factor_required' }>
    >()
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [savedEmail, setSavedEmail] = useState(user.email ?? '')
  const [profileEmail, setProfileEmail] = useState(user.email ?? '')
  const [email, setEmail] = useState(initial.email ?? ''),
    [name, setName] = useState(''),
    [code, setCode] = useState('')
  const [enrollment, setEnrollment] = useState<Enrollment>(),
    [codes, setCodes] = useState<string[]>()
  useEffect(() => {
    if (!unlocked) return
    const timeout = setTimeout(() => {
      setUnlocked(false)
      setEnrollment(undefined)
    }, 300000)
    return () => clearTimeout(timeout)
  }, [unlocked])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setUnlocked(false)
        setEnrollment(undefined)
        if (e.message === 'Authentication required')
          location.assign('/login?next=/account/security')
      }
      setError(
        e instanceof Error ? e.message : 'Unable to update security settings',
      )
    } finally {
      setBusy(false)
    }
  }
  async function reauth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget,
      password = new FormData(form).get('password')
    form.reset()
    await run(async () => {
      const result = await api<AuthenticationResult>(
        '/auth/security/reauth',
        'POST',
        { password },
      )
      if (result.status === 'authenticated') setUnlocked(true)
      else setChallenge(result)
    })
  }
  async function finish(result: { recoveryCodes?: string[] }) {
    setCodes(result.recoveryCodes)
    setUnlocked(false)
    setEnrollment(undefined)
    setCode('')
    setSecurity(await api<SecurityStatus>('/auth/security'))
    setNotice('Security settings updated. Other sessions have been signed out.')
  }
  async function enroll(method: FactorMethod) {
    await run(async () => {
      const result = await api<{
        secret?: string
        uri?: string
        options?: Parameters<typeof startRegistration>[0]['optionsJSON']
      }>('/auth/security/enroll', 'POST', {
        method,
        email: method === 'email' ? email : undefined,
        name: method === 'passkey' ? name || 'Passkey' : undefined,
      })
      if (method === 'passkey') {
        const response = await startRegistration({
          optionsJSON: result.options!,
        })
        await finish(await api('/auth/security/confirm', 'POST', { response }))
      } else {
        setEnrollment({
          method,
          secret: result.secret,
          qr: result.uri
            ? await QRCode.toDataURL(result.uri, { width: 240, margin: 2 })
            : undefined,
        })
        setCode('')
        if (method === 'email')
          setNotice(
            'Code sent. Check your email. You can resend after 60 seconds.',
          )
      }
    })
  }
  async function confirm(event: FormEvent) {
    event.preventDefault()
    await run(async () =>
      finish(await api('/auth/security/confirm', 'POST', { code })),
    )
  }
  const disabled = busy || !unlocked
  return (
    <>
      <div className="mx-auto w-full max-w-3xl flex flex-col gap-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Account security</h1>
          <p className="text-muted-foreground">
            Sign in with your username and password. Enable any combination of
            second factors for additional protection.
          </p>
        </div>
        <ErrorMessage message={error} />
        <Card className="flex flex-col gap-3 border-border bg-card p-5">
          <CardHeader>
            <CardTitle asChild>
              <h2 className="text-lg font-semibold">Shared account</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-muted-foreground">
              Your account and security settings follow you across
              organizations. Use this email address for organization
              invitations.
            </p>
            <Form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                const form = event.currentTarget
                const password = new FormData(form).get('password')
                void run(async () => {
                  await api('/auth/profile', 'PATCH', {
                    email: profileEmail,
                    password,
                  })
                  setSavedEmail(profileEmail)
                  form.reset()
                  setNotice(
                    'Account email updated. Your organization memberships are unchanged.',
                  )
                })
              }}
            >
              <Field>
                <FieldLabel>Account email address</FieldLabel>
                <Input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={profileEmail}
                  onChange={(event) => setProfileEmail(event.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field>
                <FieldLabel>Current password for account email</FieldLabel>
                <Input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={256}
                  disabled={busy}
                />
              </Field>
              <Button
                disabled={busy || !profileEmail || profileEmail === savedEmail}
              >
                Save account email
              </Button>
            </Form>
          </CardContent>
        </Card>
        {notice && <p role="status">{notice}</p>}
        {codes && (
          <Card className="flex flex-col gap-3 border-border bg-card p-5">
            <CardHeader>
              <CardTitle asChild>
                <h2 className="text-lg font-semibold">
                  Save your recovery codes
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p>
                Each code can be used once after your password. These codes are
                shown only now. Store them somewhere safe.
              </p>
              <ul className="grid gap-2 font-mono sm:grid-cols-2">
                {codes.map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
              <Button
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([codes.join('\n')], { type: 'text/plain' }),
                  )
                  const link = document.createElement('a')
                  link.href = url
                  link.download = 'kloud-recovery-codes.txt'
                  link.click()
                  setTimeout(() => URL.revokeObjectURL(url), 1000)
                }}
              >
                Download recovery codes
              </Button>
              <Button onClick={() => setCodes(undefined)}>
                I have saved these codes
              </Button>
            </CardContent>
          </Card>
        )}
        <Card className="flex flex-col gap-3 border-border bg-card p-5">
          <CardHeader>
            <CardTitle asChild>
              <h2 className="text-lg font-semibold">Confirm your identity</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {unlocked ? (
              <p role="status">
                Security settings unlocked for up to five minutes. Confirm again
                after each change.
              </p>
            ) : challenge ? (
              <FactorVerification
                challenge={challenge}
                onComplete={() => {
                  setChallenge(undefined)
                  setUnlocked(true)
                }}
                onCancel={() => setChallenge(undefined)}
              />
            ) : (
              <Form
                onSubmit={(e) => void reauth(e)}
                className="flex flex-col gap-3"
              >
                <Field>
                  <FieldLabel>Current password</FieldLabel>
                  <Input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={256}
                  />
                </Field>
                <Button disabled={busy}>Confirm identity</Button>
              </Form>
            )}
          </CardContent>
        </Card>
        <Card className="flex flex-col gap-3 border-border bg-card p-5">
          <CardHeader>
            <CardTitle asChild>
              <h2 className="text-lg font-semibold">
                Email{' '}
                {security.methods.includes('email')
                  ? '— enabled'
                  : '— disabled'}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {security.email && <p>Verified address: {security.email}</p>}
            {!security.emailAvailable && (
              <p className="text-muted-foreground">
                Email verification is unavailable until an administrator
                configures SMTP delivery.
              </p>
            )}
            <Field data-disabled={disabled || !security.emailAvailable}>
              <FieldLabel>Email address</FieldLabel>
              <Input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={254}
                disabled={disabled || !security.emailAvailable}
              />
            </Field>
            <Button
              disabled={disabled || !security.emailAvailable || !email}
              onClick={() => void enroll('email')}
            >
              {enrollment?.method === 'email'
                ? 'Resend verification email'
                : security.methods.includes('email')
                  ? 'Change verified email'
                  : 'Enable Email'}
            </Button>
            {security.methods.includes('email') && (
              <Button
                disabled={disabled}
                onClick={() =>
                  void run(async () =>
                    finish(
                      await api('/auth/security/remove', 'POST', {
                        method: 'email',
                      }),
                    ),
                  )
                }
              >
                Disable Email
              </Button>
            )}
          </CardContent>
        </Card>
        <Card className="flex flex-col gap-3 border-border bg-card p-5">
          <CardHeader>
            <CardTitle asChild>
              <h2 className="text-lg font-semibold">
                Authenticator app{' '}
                {security.methods.includes('totp') ? '— enabled' : '— disabled'}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Use a TOTP app to generate a new six-digit code every 30 seconds.
            </p>
            {!security.totpAvailable && (
              <p className="text-muted-foreground">
                An administrator must configure AUTH_ENCRYPTION_KEY before using
                authenticator verification.
              </p>
            )}
            <Button
              disabled={disabled || !security.totpAvailable}
              onClick={() => void enroll('totp')}
            >
              {security.methods.includes('totp')
                ? 'Replace authenticator'
                : 'Enable authenticator app'}
            </Button>
            {security.methods.includes('totp') && (
              <Button
                disabled={disabled}
                onClick={() =>
                  void run(async () =>
                    finish(
                      await api('/auth/security/remove', 'POST', {
                        method: 'totp',
                      }),
                    ),
                  )
                }
              >
                Disable authenticator app
              </Button>
            )}
          </CardContent>
        </Card>
        {enrollment && (
          <Card className="flex flex-col gap-3 border-border bg-card p-5">
            <CardHeader>
              <CardTitle asChild>
                <h2 className="text-lg font-semibold">
                  Verify {factorLabels[enrollment.method]}
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {enrollment.qr && (
                <img
                  src={enrollment.qr}
                  width={240}
                  height={240}
                  alt="Scan this QR code with your authenticator app"
                />
              )}
              {enrollment.secret && (
                <p>
                  Manual setup key:{' '}
                  <code className="break-all">{enrollment.secret}</code>
                </p>
              )}
              <Form
                onSubmit={(e) => void confirm(e)}
                className="flex flex-col gap-3"
              >
                <Field>
                  <FieldLabel>Verification code</FieldLabel>
                  <Input
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    maxLength={6}
                  />
                </Field>
                <Button disabled={disabled}>Verify and enable</Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => setEnrollment(undefined)}
                >
                  Cancel enrollment
                </Button>
              </Form>
            </CardContent>
          </Card>
        )}
        <Card className="flex flex-col gap-3 border-border bg-card p-5">
          <CardHeader>
            <CardTitle asChild>
              <h2 className="text-lg font-semibold">
                Passkeys{' '}
                {security.methods.includes('passkey')
                  ? '— enabled'
                  : '— disabled'}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {security.passkeyAvailable === false && (
              <p className="text-muted-foreground">
                Passkeys require HTTPS on a domain name or localhost. Enable
                TOTP or Email, or save recovery codes, for direct-IP access.
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {security.passkeys.map((key) => (
                <li
                  key={key.id}
                  className="flex items-center justify-between gap-3"
                >
                  <span>
                    {key.name}
                    {key.rpId && (
                      <small className="ml-2 text-muted-foreground">
                        {key.rpId}
                      </small>
                    )}
                  </span>
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      void run(async () =>
                        finish(
                          await api('/auth/security/remove', 'POST', {
                            method: 'passkey',
                            credentialId: key.id,
                          }),
                        ),
                      )
                    }
                  >
                    Remove {key.name}
                  </Button>
                </li>
              ))}
            </ul>
            <Field data-disabled={disabled}>
              <FieldLabel>Passkey name</FieldLabel>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                disabled={disabled}
                placeholder="Personal device"
              />
            </Field>
            <Button
              disabled={disabled || security.passkeyAvailable === false}
              onClick={() => void enroll('passkey')}
            >
              Add passkey
            </Button>
          </CardContent>
        </Card>
        <Card className="flex flex-col gap-3 border-border bg-card p-5">
          <CardHeader>
            <CardTitle asChild>
              <h2 className="text-lg font-semibold">
                Recovery and password-only login
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p>{security.recoveryCodesRemaining} recovery codes remaining.</p>
            <Button
              disabled={disabled || !security.methods.length}
              onClick={() =>
                void run(async () =>
                  finish(await api('/auth/security/recovery-codes', 'POST')),
                )
              }
            >
              Generate new recovery codes
            </Button>
            <p className="text-muted-foreground">
              Generating new codes invalidates your previous set. Disabling all
              second factors allows login with your password alone.
            </p>
            <Button
              disabled={disabled || !security.methods.length}
              onClick={() => {
                if (
                  window.confirm(
                    'Disable all second factors and allow password-only login?',
                  )
                )
                  void run(async () =>
                    finish(
                      await api('/auth/security/remove', 'POST', {
                        method: 'all',
                      }),
                    ),
                  )
              }}
            >
              Disable all second factors
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
