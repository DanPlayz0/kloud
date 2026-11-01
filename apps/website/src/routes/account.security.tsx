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
import { Shell, ErrorMessage } from '../components'
import { Card } from '../components/ui/card'
import { Button, Input, Label } from '../components/ui/controls'
import {
  FactorVerification,
  factorLabels,
} from '../components/factor-verification'

export const Route = createFileRoute('/account/security')({
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
    <Shell
      user={user}
      projects={projects}
      title="Account security"
      active="security"
    >
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Account security</h1>
          <p className="text-muted-foreground">
            Sign in with your username and password. Enable any combination of
            second factors for additional protection.
          </p>
        </div>
        <ErrorMessage message={error} />
        {notice && <p role="status">{notice}</p>}
        {codes && (
          <Card className="space-y-3 border-border bg-card p-5">
            <h2 className="text-lg font-semibold">Save your recovery codes</h2>
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
          </Card>
        )}
        <Card className="space-y-3 border-border bg-card p-5">
          <h2 className="text-lg font-semibold">Confirm your identity</h2>
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
            <form onSubmit={(e) => void reauth(e)} className="space-y-3">
              <Label>
                Current password
                <Input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={256}
                />
              </Label>
              <Button disabled={busy}>Confirm identity</Button>
            </form>
          )}
        </Card>
        <Card className="space-y-3 border-border bg-card p-5">
          <h2 className="text-lg font-semibold">
            Email{' '}
            {security.methods.includes('email') ? '— enabled' : '— disabled'}
          </h2>
          {security.email && <p>Verified address: {security.email}</p>}
          {!security.emailAvailable && (
            <p className="text-muted-foreground">
              Email verification is unavailable until an administrator
              configures SMTP delivery.
            </p>
          )}
          <Label>
            Email address
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              disabled={disabled || !security.emailAvailable}
            />
          </Label>
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
        </Card>
        <Card className="space-y-3 border-border bg-card p-5">
          <h2 className="text-lg font-semibold">
            Authenticator app{' '}
            {security.methods.includes('totp') ? '— enabled' : '— disabled'}
          </h2>
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
        </Card>
        {enrollment && (
          <Card className="space-y-3 border-border bg-card p-5">
            <h2 className="text-lg font-semibold">
              Verify {factorLabels[enrollment.method]}
            </h2>
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
            <form onSubmit={(e) => void confirm(e)} className="space-y-3">
              <Label>
                Verification code
                <Input
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  maxLength={6}
                />
              </Label>
              <Button disabled={disabled}>Verify and enable</Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => setEnrollment(undefined)}
              >
                Cancel enrollment
              </Button>
            </form>
          </Card>
        )}
        <Card className="space-y-3 border-border bg-card p-5">
          <h2 className="text-lg font-semibold">
            Passkeys{' '}
            {security.methods.includes('passkey') ? '— enabled' : '— disabled'}
          </h2>
          <ul className="space-y-2">
            {security.passkeys.map((key) => (
              <li
                key={key.id}
                className="flex items-center justify-between gap-3"
              >
                <span>{key.name}</span>
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
          <Label>
            Passkey name
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              disabled={disabled}
              placeholder="Personal device"
            />
          </Label>
          <Button disabled={disabled} onClick={() => void enroll('passkey')}>
            Add passkey
          </Button>
        </Card>
        <Card className="space-y-3 border-border bg-card p-5">
          <h2 className="text-lg font-semibold">
            Recovery and password-only login
          </h2>
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
        </Card>
      </div>
    </Shell>
  )
}
