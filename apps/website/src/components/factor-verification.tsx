import { Alert, AlertDescription } from './ui/alert'
import { Field, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { useState, type FormEvent } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import type { AuthenticationResult, FactorMethod } from '@kloud/protocol/auth'
import { api } from '../api'
import { Button, Input } from './ui/controls'
import { ErrorMessage } from '../components'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

export const factorLabels = {
  email: 'Email',
  totp: 'Authenticator app',
  passkey: 'Passkey',
  recovery: 'Recovery code',
}
export function FactorVerification({
  challenge,
  onComplete,
  onCancel,
}: {
  challenge: Extract<AuthenticationResult, { status: 'second_factor_required' }>
  onComplete: () => void | Promise<void>
  onCancel: () => void
}) {
  const [method, setMethod] = useState<FactorMethod | 'recovery'>(),
    [code, setCode] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sentAt, setSentAt] = useState(0)
  async function choose(next: FactorMethod | 'recovery') {
    setMethod(next)
    setCode('')
    setError('')
    if (next === 'totp' || next === 'recovery') return
    setBusy(true)
    try {
      if (next === 'email') {
        if (Date.now() < sentAt + 60000)
          throw new Error('Wait 60 seconds before requesting another email.')
        await api('/auth/factor/challenge', 'POST', { method: next })
        setSentAt(Date.now())
      } else {
        const { options } = await api<{
          options: Parameters<typeof startAuthentication>[0]['optionsJSON']
        }>('/auth/factor/challenge', 'POST', { method: next })
        await api(
          '/auth/verify',
          'POST',
          await startAuthentication({ optionsJSON: options }),
        )
        await onComplete()
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Verification failed. Choose a method to try again.',
      )
    } finally {
      setBusy(false)
    }
  }
  async function verify(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/auth/factor/verify', 'POST', { method, code })
      await onComplete()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="flex flex-col gap-4"
      aria-label="Second-factor verification"
    >
      <p>Verify your identity with one of your enabled methods.</p>
      <ToggleGroup
        type="single"
        value={method ?? ''}
        spacing={2}
        className="flex-wrap"
        aria-label="Verification method"
        onValueChange={(value) => {
          if (value) void choose(value as FactorMethod | 'recovery')
        }}
      >
        {challenge.methods.map((value) => (
          <ToggleGroupItem
            key={value}
            value={value}
            onClick={() => {
              if (method === value) void choose(value)
            }}
            disabled={
              busy ||
              (value === 'email' && !challenge.emailAvailable) ||
              (value === 'passkey' && challenge.passkeyAvailable === false) ||
              (value === 'totp' && !challenge.totpAvailable)
            }
          >
            {factorLabels[value]}
          </ToggleGroupItem>
        ))}
        <ToggleGroupItem value="recovery" disabled={busy}>
          Recovery code
        </ToggleGroupItem>
      </ToggleGroup>
      {challenge.methods.includes('email') && !challenge.emailAvailable && (
        <p className="text-muted-foreground">
          Email verification is unavailable until email delivery is configured.
          Use another method or a recovery code.
        </p>
      )}
      {challenge.methods.includes('totp') && !challenge.totpAvailable && (
        <p className="text-muted-foreground">
          Authenticator verification is unavailable until the server encryption
          key is configured. Use another method or a recovery code.
        </p>
      )}
      {method && method !== 'passkey' && (
        <Form onSubmit={(e) => void verify(e)} className="flex flex-col gap-3">
          {method === 'email' && sentAt > 0 && (
            <Alert role="status">
              <AlertDescription>
                Code sent. Check your email. You can resend after 60 seconds.
              </AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel>
              {method === 'recovery'
                ? 'Recovery code'
                : `${factorLabels[method]} code`}
            </FieldLabel>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode={method === 'recovery' ? 'text' : 'numeric'}
              maxLength={method === 'recovery' ? 100 : 6}
              required
            />
          </Field>
          <Button
            variant="primary"
            disabled={busy || (method === 'email' && !sentAt)}
          >
            {busy ? 'Verifying…' : 'Verify code'}
          </Button>
          {method === 'email' && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void choose('email')}
            >
              Resend email
            </Button>
          )}
        </Form>
      )}
      {challenge.methods.includes('passkey') &&
        challenge.passkeyAvailable === false && (
          <p className="text-muted-foreground">
            No passkey is available for this address. Passkeys require HTTPS on
            their registered domain or localhost. Use another enabled method or
            a recovery code.
          </p>
        )}
      <ErrorMessage message={error} />
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
        Start again
      </Button>
    </section>
  )
}
