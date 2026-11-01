import {
  accountsEnabled,
  withAccounts,
  getAccountSchema,
  linkOrganizationAccount,
} from './global-accounts.js'
import { accountTable, invitationRecord } from './account-invitations.js'
import {
  organizationContext,
  runWithOrganization,
  type OrganizationContext,
} from './organization-context.js'
import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { getCookie as readCookie, setCookie as writeCookie } from 'hono/cookie'
import { currentOrganization } from './organization-context.js'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { pool, transaction } from './db.js'
import {
  token,
  digest,
  hashPassword,
  verifyPassword,
  browserOrigin,
  secureCookies,
  relyingParty,
  rpID,
} from './security.js'
import {
  codeHash,
  decryptSecret,
  emailCode,
  encryptSecret,
  matchesCode,
  newTotp,
  recoveryCodes,
  smtpAvailable,
  sendEmailCode,
  totpAvailable,
  totpStep,
} from './auth-factors.js'
import {
  factorRequestSchema,
  factorVerificationSchema,
  credentialsSchema,
  enrollmentSchema,
  setupSchema,
  type FactorMethod,
  type AuthenticationResult,
} from '@kloud/protocol/auth'

export interface User {
  id: string
  username: string
  email?: string | null
  admin: boolean
  capabilities: import('./permissions.js').ServerCapability[]
}
export type Env = {
  Variables: { user: User; requestOrganization?: OrganizationContext }
}
export const auth = new Hono<Env>()
auth.use('*', async (c, next) => {
  c.set('requestOrganization', currentOrganization())
  return withAccounts(next)
})
export const cookieOptions = (c: Context) => ({
  httpOnly: true,
  secure: secureCookies(c),
  sameSite: 'Strict' as const,
  path: '/',
})
const cookieName = (name: string) => {
  const organization = currentOrganization()
  return !accountsEnabled() && organization && organization.slug !== 'default'
    ? `kloud_${organization.slug}_${name}`
    : name
}
const getCookie = (c: Context, name: string) => readCookie(c, cookieName(name))
const setCookie = (
  c: Context,
  name: string,
  value: string,
  options: Parameters<typeof writeCookie>[3],
) => writeCookie(c, cookieName(name), value, options)
const sessionHash = (c: Context) => digest(getCookie(c, 'session') ?? '')
const pendingToken = (c: Context) => getCookie(c, 'pending') ?? ''
export const currentIdentity = async (c: Context) => {
  const value = getCookie(c, 'session')
  if (!value) return undefined
  return withAccounts(
    async () =>
      (
        await pool.query<User>(
          `SELECT u.id,u.username,u.admin,u.capabilities,${accountsEnabled() ? 'u.account_email' : 'u.email'} AS email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires>now() AND NOT u.disabled`,
          [digest(value)],
        )
      ).rows[0],
  )
}
export const currentUser = async (c: Context) => {
  const identity = await currentIdentity(c)
  if (
    !identity ||
    !accountsEnabled() ||
    currentOrganization()?.schema === getAccountSchema()
  )
    return identity
  const member = (
    await pool.query<User>(
      'SELECT id,username,admin,capabilities FROM users WHERE id=$1 AND NOT disabled AND NOT invitation_pending',
      [identity.id],
    )
  ).rows[0]
  return member
    ? { ...identity, admin: member.admin, capabilities: member.capabilities }
    : undefined
}
export const requireIdentity = async (
  c: Context<Env>,
  next: () => Promise<void>,
) => {
  const identity = await currentIdentity(c)
  if (!identity) return c.json({ error: 'Authentication required' }, 401)
  c.set('user', identity)
  await next()
}
export const requireUser = async (
  c: Context<Env>,
  next: () => Promise<void>,
) => {
  const user = await currentUser(c)
  if (!user) {
    if (accountsEnabled() && (await currentIdentity(c)))
      return c.json({ error: 'Organization access required' }, 403)
    return c.json({ error: 'Authentication required' }, 401)
  }
  c.set('user', user)
  await next()
}
export const requireAdmin = async (
  c: Context<Env>,
  next: () => Promise<void>,
) => {
  if (!c.get('user').admin)
    return c.json({ error: 'Administrator access required' }, 403)
  await next()
}
async function hasAccounts(): Promise<boolean> {
  return (await pool.query('SELECT EXISTS(SELECT 1 FROM users) AS populated'))
    .rows[0].populated
}
function enabled(user: any): FactorMethod[] {
  return [
    ...(user.email_2fa ? ['email' as const] : []),
    ...(user.totp_secret ? ['totp' as const] : []),
    ...(user.passkey_2fa ? ['passkey' as const] : []),
  ]
}
async function result(user: any, c: Context): Promise<AuthenticationResult> {
  const requestRP = relyingParty(browserOrigin(c))
  const keys =
    requestRP && user.passkey_2fa
      ? await pool.query(
          'SELECT 1 FROM passkeys WHERE user_id=$1 AND COALESCE(rp_id,$2)=$3 LIMIT 1',
          [user.id, rpID, requestRP],
        )
      : null
  return {
    status: 'second_factor_required',
    methods: enabled(user),
    emailAvailable: smtpAvailable(),
    totpAvailable: totpAvailable(),
    passkeyAvailable: !!keys?.rowCount,
  }
}
async function rateLimit(key: string, maximum: number) {
  const r = await pool.query(
    `INSERT INTO login_attempts(key,attempts,expires) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.expires<=now() THEN 1 ELSE login_attempts.attempts+1 END, expires=CASE WHEN login_attempts.expires<=now() THEN now()+interval '15 minutes' ELSE login_attempts.expires END RETURNING attempts`,
    [key],
  )
  if (r.rows[0].attempts > maximum)
    throw new HTTPException(429, {
      message: 'Too many attempts. Try again in 15 minutes.',
    })
}
async function newSession(db: PoolClient, user: any) {
  const session = token()
  await db.query(
    `INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '8 hours')`,
    [digest(session), user.id],
  )
  await db.query('DELETE FROM login_attempts WHERE key=$1', [
    digest(user.username.toLowerCase()),
  ])
  return session
}
function sessionCookie(c: Context, value: string) {
  setCookie(c, 'session', value, { ...cookieOptions(c), maxAge: 28800 })
}
async function newPending(
  c: Context,
  db: PoolClient,
  user: any,
  purpose: string,
  session: string | null = null,
  data = {},
) {
  const value = token()
  await db.query(
    'DELETE FROM auth_pending WHERE user_id=$1 AND expires<=now()',
    [user.id],
  )
  await db.query(
    `INSERT INTO auth_pending(token,user_id,purpose,session_token,password_hash,version,data,expires) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes')`,
    [
      digest(value),
      user.id,
      purpose,
      session,
      user.password_hash,
      user.security_version,
      JSON.stringify({ ...data, origin: browserOrigin(c) }),
    ],
  )
  return value
}
// Always lock user before pending rows: reset, login and security changes serialize.
async function pendingUser(db: PoolClient, c: Context) {
  const value = pendingToken(c)
  const ref = (
    await db.query('SELECT user_id FROM auth_pending WHERE token=$1', [
      digest(value),
    ])
  ).rows[0]
  if (!ref) return null
  const user = (
    await db.query(
      'SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
      [ref.user_id],
    )
  ).rows[0]
  const pending = (
    await db.query(
      `SELECT * FROM auth_pending WHERE token=$1 AND purpose IN ('login','reauth') AND expires>now() AND attempts<5 FOR UPDATE`,
      [digest(value)],
    )
  ).rows[0]
  if (
    !user ||
    !pending ||
    pending.password_hash !== user.password_hash ||
    pending.version !== user.security_version ||
    pending.data.origin !== browserOrigin(c)
  )
    return null
  if (
    pending.purpose === 'reauth' &&
    (pending.session_token !== sessionHash(c) ||
      !(
        await db.query(
          'SELECT 1 FROM sessions WHERE token=$1 AND expires>now()',
          [sessionHash(c)],
        )
      ).rowCount)
  )
    return null
  return { user, pending, value }
}
async function pendingRate(c: Context) {
  const ref = (
    await pool.query('SELECT user_id FROM auth_pending WHERE token=$1', [
      digest(pendingToken(c)),
    ])
  ).rows[0]
  if (ref) await rateLimit(digest('factor:' + ref.user_id), 20)
}
async function emailLimit(db: PoolClient, user: string) {
  const r = await db.query(
    `INSERT INTO auth_email_limits(user_id,sent_at,window_start,sends) VALUES($1,now(),now(),1)
    ON CONFLICT(user_id) DO UPDATE SET sent_at=now(),window_start=CASE WHEN auth_email_limits.window_start<=now()-interval '15 minutes' THEN now() ELSE auth_email_limits.window_start END,
    sends=CASE WHEN auth_email_limits.window_start<=now()-interval '15 minutes' THEN 1 ELSE auth_email_limits.sends+1 END
    WHERE auth_email_limits.sent_at<=now()-interval '60 seconds' AND (auth_email_limits.sends<5 OR auth_email_limits.window_start<=now()-interval '15 minutes') RETURNING user_id`,
    [user],
  )
  if (!r.rowCount)
    throw new HTTPException(429, {
      message:
        'Wait 60 seconds before resending. At most five emails can be sent every 15 minutes.',
    })
}

auth.get('/setup', async (c) => c.json({ required: !(await hasAccounts()) }))
auth.post('/setup', async (c) => {
  if (await hasAccounts())
    return c.json({ error: 'Setup is complete. Sign in to your account.' }, 409)
  const body = setupSchema.parse(await c.req.json()),
    hashed = await hashPassword(body.password)
  if (accountsEnabled() && !body.email)
    throw new HTTPException(400, { message: 'Email is required' })
  const id = randomUUID()
  const initialOrganization = accountsEnabled()
    ? await (
        await import('./organizations.js')
      ).findOrganization(c.get('requestOrganization')?.slug ?? 'default')
    : undefined
  await transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(842192)')
    await db.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
    if ((await db.query('SELECT 1 FROM users LIMIT 1')).rowCount)
      throw new HTTPException(409, {
        message: 'Setup is complete. Sign in to your account.',
      })
    if (accountsEnabled()) {
      await db.query(
        'INSERT INTO users(id,username,password_hash,account_email) VALUES($1,$2,$3,$4)',
        [id, body.username.toLowerCase(), hashed, body.email!.toLowerCase()],
      )
      await db.query(
        `INSERT INTO "${initialOrganization!.schema}".users(id,username,account_email,password_hash,admin) VALUES($1,$2,$3,'global-account',true)`,
        [id, body.username.toLowerCase(), body.email!.toLowerCase()],
      )
    } else
      await db.query(
        'INSERT INTO users(id,username,password_hash,admin) VALUES($1,$2,$3,true)',
        [id, body.username.toLowerCase(), hashed],
      )
  })
  return c.json({ ok: true })
})
auth.post('/enroll', async (c) => {
  const body = enrollmentSchema.parse(await c.req.json()),
    hashed = await hashPassword(body.password)
  if (accountsEnabled()) {
    const invite = await invitationRecord(pool, body.token)
    if (invite) {
      if (invite.existing_account)
        throw new HTTPException(409, {
          message: 'Sign in to your existing account to accept this invitation',
        })
      await acceptInvitation(c, body.token, undefined, hashed)
      return c.json({ ok: true })
    }
  }
  const success = await transaction(async (db) => {
    const ref = (
      await db.query('SELECT user_id FROM invitations WHERE token=$1', [
        digest(body.token),
      ])
    ).rows[0]
    if (!ref) return false
    const user = (
      await db.query(
        'SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
        [ref.user_id],
      )
    ).rows[0]
    const invitation = await db.query(
      'DELETE FROM invitations WHERE token=$1 AND expires>now() RETURNING token',
      [digest(body.token)],
    )
    if (!user || user.password_hash || !invitation.rowCount) return false
    await db.query(
      'UPDATE users SET password_hash=$1,security_version=security_version+1 WHERE id=$2',
      [hashed, user.id],
    )
    for (const table of [
      'sessions',
      'auth_pending',
      'challenges',
      'invitations',
    ])
      await db.query(`DELETE FROM ${table} WHERE user_id=$1`, [user.id])
    return true
  })
  return success
    ? c.json({ ok: true })
    : c.json({ error: 'Invitation is invalid or expired' }, 400)
})
auth.post('/password', async (c) => {
  const body = credentialsSchema.parse(await c.req.json())
  await rateLimit(digest(body.username.toLowerCase()), 10)
  const outcome = await transaction(async (db) => {
    const user = (
      await db.query(
        accountsEnabled()
          ? 'SELECT * FROM users WHERE id=COALESCE((SELECT id FROM users WHERE lower(account_email)=$1),(SELECT id FROM users WHERE lower(username)=$1)) FOR UPDATE'
          : 'SELECT * FROM users WHERE lower(username)=$1 FOR UPDATE',
        [body.username.toLowerCase()],
      )
    ).rows[0]
    const valid = await verifyPassword(
      body.password,
      user?.password_hash ?? '0'.repeat(32) + ':' + '00'.repeat(64),
    )
    if (!user || user.disabled || !valid) return null
    if (!enabled(user).length)
      return { session: await newSession(db, user), user }
    return { pending: await newPending(c, db, user, 'login'), user }
  })
  // Replace the browser's partial-login cookie on a fresh password submission.
  if (!outcome) {
    setCookie(c, 'pending', '', { ...cookieOptions(c), maxAge: 0 })
    return c.json({ error: 'Invalid credentials' }, 401)
  }
  if (outcome.session) {
    setCookie(c, 'pending', '', { ...cookieOptions(c), maxAge: 0 })
    sessionCookie(c, outcome.session)
    return c.json({ status: 'authenticated' } satisfies AuthenticationResult)
  }
  setCookie(c, 'pending', outcome.pending!, {
    ...cookieOptions(c),
    maxAge: 300,
  })
  return c.json(await result(outcome.user, c))
})

auth.post('/factor/challenge', async (c) => {
  const { method } = factorRequestSchema.parse(await c.req.json())
  const outcome = await transaction(async (db) => {
    const state = await pendingUser(db, c)
    if (!state || !enabled(state.user).includes(method)) return null
    const { pending, user, value } = state
    if (method === 'email') {
      if (!smtpAvailable())
        return {
          error:
            'Email verification is unavailable. Use another factor or recovery code.',
        }
      await emailLimit(db, user.id)
      const code = emailCode()
      // Commit invalidation and rate counters even when SMTP fails.
      await db.query(
        `UPDATE auth_pending SET data=data-'email_hash'-'email_expires' WHERE token=$1`,
        [pending.token],
      )
      try {
        await sendEmailCode(user.email, code)
      } catch (e) {
        return { error: (e as Error).message }
      }
      await db.query(
        `UPDATE auth_pending SET data=data || $2::jsonb WHERE token=$1`,
        [
          pending.token,
          JSON.stringify({
            email_hash: codeHash(code, value),
            email_expires: Date.now() + 300000,
          }),
        ],
      )
      return { sent: true }
    }
    if (method === 'passkey') {
      const requestRP = relyingParty(browserOrigin(c))
      if (!requestRP)
        return {
          error:
            'Passkeys require HTTPS on a domain name or localhost. Use another factor or a recovery code for this address.',
        }
      const keys = (
        await db.query(
          'SELECT id,transports FROM passkeys WHERE user_id=$1 AND COALESCE(rp_id,$2)=$3',
          [user.id, rpID, requestRP],
        )
      ).rows
      if (!keys.length)
        return {
          error:
            'No passkey is registered for this hostname. Use another factor or a recovery code.',
        }
      const options = await generateAuthenticationOptions({
        rpID: requestRP,
        userVerification: 'required',
        allowCredentials: keys,
      })
      await db.query(
        'UPDATE auth_pending SET data=data || $2::jsonb WHERE token=$1',
        [
          pending.token,
          JSON.stringify({ challenge: options.challenge, rp_id: requestRP }),
        ],
      )
      return { options }
    }
    return { ok: true }
  })
  if (!outcome)
    return c.json({ error: 'Verification expired. Start again.' }, 401)
  if ('error' in outcome) return c.json({ error: outcome.error }, 503)
  return c.json(outcome)
})

async function verifyFactor(
  c: Context,
  method: FactorMethod | 'recovery',
  code?: string,
  response?: AuthenticationResponseJSON,
) {
  await pendingRate(c)
  const outcome = await transaction(async (db) => {
    const state = await pendingUser(db, c)
    if (!state) return null
    const { user, pending, value } = state
    await db.query(
      'UPDATE auth_pending SET attempts=attempts+1 WHERE token=$1',
      [pending.token],
    )
    let valid = false
    if (method === 'recovery') {
      valid = !!(
        await db.query(
          'DELETE FROM recovery_codes WHERE user_id=$1 AND hash=$2 RETURNING hash',
          [user.id, digest(code ?? '')],
        )
      ).rowCount
    } else if (!enabled(user).includes(method)) return null
    else if (method === 'email') {
      valid =
        smtpAvailable() &&
        pending.data.email_expires > Date.now() &&
        matchesCode(code ?? '', value, pending.data.email_hash ?? '')
    } else if (method === 'totp') {
      const step = totpStep(decryptSecret(user.totp_secret), code ?? '')
      if (
        step !== null &&
        (user.totp_last_step === null || step > Number(user.totp_last_step))
      ) {
        await db.query('UPDATE users SET totp_last_step=$1 WHERE id=$2', [
          step,
          user.id,
        ])
        valid = true
      }
    } else if (response && pending.data.challenge) {
      const key = (
        await db.query(
          'SELECT * FROM passkeys WHERE id=$1 AND user_id=$2 AND COALESCE(rp_id,$3)=$4 FOR UPDATE',
          [response.id, user.id, rpID, pending.data.rp_id],
        )
      ).rows[0]
      // Every WebAuthn assertion consumes its challenge, including invalid assertions.
      await db.query(
        `UPDATE auth_pending SET data=data-'challenge' WHERE token=$1`,
        [pending.token],
      )
      if (key) {
        try {
          const verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge: pending.data.challenge,
            expectedOrigin: pending.data.origin,
            expectedRPID: pending.data.rp_id,
            requireUserVerification: true,
            credential: {
              id: key.id,
              publicKey: new Uint8Array(key.public_key),
              counter: Number(key.counter),
              transports: key.transports,
            },
          })
          if (verification.verified) {
            await db.query('UPDATE passkeys SET counter=$1 WHERE id=$2', [
              verification.authenticationInfo.newCounter,
              key.id,
            ])
            valid = true
          }
        } catch {
          /* Invalid assertions count as failed attempts. */
        }
      }
    }
    if (!valid) return null
    await db.query('DELETE FROM auth_pending WHERE token=$1', [pending.token])
    if (pending.purpose === 'reauth')
      return {
        grant: await newPending(c, db, user, 'grant', pending.session_token),
      }
    return { session: await newSession(db, user) }
  })
  if (!outcome)
    return c.json(
      {
        error: 'Verification failed or expired. Check the code or start again.',
      },
      401,
    )
  setCookie(c, 'pending', '', { ...cookieOptions(c), maxAge: 0 })
  if (outcome.grant)
    setCookie(c, 'security_grant', outcome.grant, {
      ...cookieOptions(c),
      maxAge: 300,
    })
  if (outcome.session) sessionCookie(c, outcome.session)
  return c.json({ ok: true })
}
auth.post('/factor/verify', async (c) => {
  const body = factorVerificationSchema.parse(await c.req.json())
  return verifyFactor(c, body.method, body.code)
})
auth.post('/verify', async (c) =>
  verifyFactor(
    c,
    'passkey',
    undefined,
    z
      .record(z.string(), z.any())
      .parse(await c.req.json()) as unknown as AuthenticationResponseJSON,
  ),
)

auth.use('/security/*', requireUser)
auth.get('/security', requireUser, async (c) => {
  const user = (
    await pool.query('SELECT * FROM users WHERE id=$1', [c.get('user').id])
  ).rows[0]
  return c.json({
    methods: enabled(user),
    email: user.email,
    emailAvailable: smtpAvailable(),
    totpAvailable: totpAvailable(),
    passkeyAvailable: !!relyingParty(browserOrigin(c)),
    passkeys: (
      await pool.query(
        'SELECT id,name,COALESCE(rp_id,$2) AS "rpId" FROM passkeys WHERE user_id=$1 ORDER BY name,id',
        [user.id, rpID],
      )
    ).rows,
    recoveryCodesRemaining: Number(
      (
        await pool.query(
          'SELECT count(*) AS count FROM recovery_codes WHERE user_id=$1',
          [user.id],
        )
      ).rows[0].count,
    ),
  })
})
auth.post('/security/reauth', async (c) => {
  const body = z
    .object({ password: z.string().min(1).max(256) })
    .parse(await c.req.json())
  await rateLimit(digest('reauth:' + c.get('user').id), 10)
  const outcome = await transaction(async (db) => {
    const user = (
      await db.query(
        'SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
        [c.get('user').id],
      )
    ).rows[0]
    if (
      !user?.password_hash ||
      !(await verifyPassword(body.password, user.password_hash))
    )
      return null
    const needsFactor = enabled(user).length > 0
    return {
      user,
      needsFactor,
      value: await newPending(
        c,
        db,
        user,
        needsFactor ? 'reauth' : 'grant',
        sessionHash(c),
      ),
    }
  })
  if (!outcome) return c.json({ error: 'Invalid credentials' }, 401)
  setCookie(
    c,
    outcome.needsFactor ? 'pending' : 'security_grant',
    outcome.value,
    { ...cookieOptions(c), maxAge: 300 },
  )
  return c.json(
    outcome.needsFactor
      ? await result(outcome.user, c)
      : ({ status: 'authenticated' } satisfies AuthenticationResult),
  )
})

async function securityUser(db: PoolClient, c: Context<Env>) {
  const user = (
    await db.query(
      'SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
      [c.get('user').id],
    )
  ).rows[0]
  const grant = (
    await db.query(
      `SELECT * FROM auth_pending WHERE token=$1 AND user_id=$2 AND purpose='grant' AND expires>now()`,
      [digest(getCookie(c, 'security_grant') ?? ''), user?.id],
    )
  ).rows[0]
  if (
    !user ||
    !grant ||
    grant.version !== user.security_version ||
    grant.data.origin !== browserOrigin(c) ||
    grant.password_hash !== user.password_hash ||
    grant.session_token !== sessionHash(c) ||
    !(
      await db.query(
        'SELECT 1 FROM sessions WHERE token=$1 AND expires>now()',
        [sessionHash(c)],
      )
    ).rowCount
  )
    throw new HTTPException(401, {
      message:
        'Confirm your password and second factor again before changing security settings.',
    })
  return user
}
async function finishChange(db: PoolClient, user: any) {
  const after = (await db.query('SELECT * FROM users WHERE id=$1', [user.id]))
    .rows[0]
  let codes: string[] | undefined
  if (!enabled(user).length && enabled(after).length)
    codes = await recoveryCodes(db, user.id)
  if (!enabled(after).length)
    await db.query('DELETE FROM recovery_codes WHERE user_id=$1', [user.id])
  await db.query(
    'UPDATE users SET security_version=security_version+1 WHERE id=$1',
    [user.id],
  )
  for (const table of ['auth_pending', 'sessions', 'challenges'])
    await db.query(`DELETE FROM ${table} WHERE user_id=$1`, [user.id])
  return { session: await newSession(db, user), codes }
}
function changed(c: Context, outcome: { session: string; codes?: string[] }) {
  sessionCookie(c, outcome.session)
  setCookie(c, 'security_grant', '', { ...cookieOptions(c), maxAge: 0 })
  setCookie(c, 'factor_enrollment', '', { ...cookieOptions(c), maxAge: 0 })
  return c.json({ ok: true, recoveryCodes: outcome.codes })
}
auth.post('/security/enroll', async (c) => {
  const body = factorRequestSchema
    .extend({
      email: z.email().max(254).optional(),
      name: z.string().trim().min(1).max(100).optional(),
    })
    .parse(await c.req.json())
  const outcome = await transaction(async (db) => {
    const user = await securityUser(db, c)
    await db.query(
      `DELETE FROM auth_pending WHERE user_id=$1 AND purpose IN ('email','totp','passkey')`,
      [user.id],
    )
    if (body.method === 'email') {
      if (!body.email)
        throw new HTTPException(400, { message: 'Enter an email address.' })
      if (!smtpAvailable())
        throw new HTTPException(503, {
          message: 'Configure SMTP before enabling Email 2FA.',
        })
      await emailLimit(db, user.id)
      const value = await newPending(c, db, user, 'email', sessionHash(c)),
        code = emailCode()
      try {
        await sendEmailCode(body.email, code)
      } catch (e) {
        return { error: (e as Error).message }
      }
      await db.query('UPDATE auth_pending SET data=$2 WHERE token=$1', [
        digest(value),
        JSON.stringify({
          email: body.email,
          hash: codeHash(code, value),
          origin: browserOrigin(c),
        }),
      ])
      return { value, sent: true }
    }
    if (body.method === 'totp') {
      const totp = newTotp(user.username)
      const value = await newPending(c, db, user, 'totp', sessionHash(c), {
        secret: encryptSecret(totp.secret.base32),
      })
      return { value, secret: totp.secret.base32, uri: totp.toString() }
    }
    const requestRP = relyingParty(browserOrigin(c))
    if (!requestRP)
      throw new HTTPException(400, {
        message:
          'Passkey enrollment requires HTTPS on a domain name or localhost. Use TOTP or Email for direct-IP access.',
      })
    const keys = (
      await db.query(
        'SELECT id FROM passkeys WHERE user_id=$1 AND COALESCE(rp_id,$2)=$3',
        [user.id, rpID, requestRP],
      )
    ).rows
    const options = await generateRegistrationOptions({
      rpName: 'Kloud',
      rpID: requestRP,
      userName: user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: keys,
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    })
    const value = await newPending(c, db, user, 'passkey', sessionHash(c), {
      challenge: options.challenge,
      name: body.name ?? 'Passkey',
      rp_id: requestRP,
    })
    return { value, options }
  })
  if ('error' in outcome) return c.json({ error: outcome.error }, 503)
  setCookie(c, 'factor_enrollment', outcome.value!, {
    ...cookieOptions(c),
    maxAge: 300,
  })
  const { value: _value, ...response } = outcome
  return c.json(response)
})
auth.post('/security/confirm', async (c) => {
  const body = z
    .object({
      code: z.string().max(100).optional(),
      response: z.record(z.string(), z.any()).optional(),
    })
    .parse(await c.req.json())
  await rateLimit(digest('enroll:' + c.get('user').id), 20)
  const outcome = await transaction(async (db) => {
    const user = await securityUser(db, c),
      value = getCookie(c, 'factor_enrollment') ?? ''
    const pending = (
      await db.query(
        `SELECT * FROM auth_pending WHERE token=$1 AND user_id=$2 AND purpose IN ('email','totp','passkey') AND expires>now() AND attempts<5 FOR UPDATE`,
        [digest(value), user.id],
      )
    ).rows[0]
    if (
      !pending ||
      pending.version !== user.security_version ||
      pending.password_hash !== user.password_hash ||
      pending.session_token !== sessionHash(c) ||
      pending.data.origin !== browserOrigin(c)
    )
      return null
    await db.query(
      'UPDATE auth_pending SET attempts=attempts+1 WHERE token=$1',
      [pending.token],
    )
    if (pending.purpose === 'email') {
      if (
        !smtpAvailable() ||
        !matchesCode(body.code ?? '', value, pending.data.hash ?? '')
      )
        return null
      await db.query('UPDATE users SET email=$1,email_2fa=true WHERE id=$2', [
        pending.data.email,
        user.id,
      ])
    } else if (pending.purpose === 'totp') {
      const step = totpStep(decryptSecret(pending.data.secret), body.code ?? '')
      if (step === null) return null
      await db.query(
        'UPDATE users SET totp_secret=$1,totp_last_step=$2 WHERE id=$3',
        [pending.data.secret, step, user.id],
      )
    } else {
      await db.query('DELETE FROM auth_pending WHERE token=$1', [pending.token])
      try {
        const verification = await verifyRegistrationResponse({
          response: body.response as unknown as RegistrationResponseJSON,
          expectedChallenge: pending.data.challenge,
          expectedOrigin: pending.data.origin,
          expectedRPID: pending.data.rp_id,
          requireUserVerification: true,
        })
        if (!verification.verified || !verification.registrationInfo)
          return null
        const key = verification.registrationInfo.credential
        await db.query(
          'INSERT INTO passkeys(id,user_id,public_key,counter,transports,name,rp_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            key.id,
            user.id,
            Buffer.from(key.publicKey),
            key.counter,
            JSON.stringify(key.transports ?? []),
            pending.data.name,
            pending.data.rp_id,
          ],
        )
      } catch {
        return null
      }
      await db.query('UPDATE users SET passkey_2fa=true WHERE id=$1', [user.id])
    }
    return finishChange(db, user)
  })
  return outcome
    ? changed(c, outcome)
    : c.json(
        { error: 'Enrollment verification failed or expired. Try again.' },
        400,
      )
})
auth.post('/security/remove', async (c) => {
  const body = z
    .object({
      method: z.enum(['email', 'totp', 'passkey', 'all']),
      credentialId: z.string().max(2048).optional(),
    })
    .parse(await c.req.json())
  const outcome = await transaction(async (db) => {
    const user = await securityUser(db, c)
    if (body.method === 'email' || body.method === 'all')
      await db.query(
        'UPDATE users SET email=NULL,email_2fa=false WHERE id=$1',
        [user.id],
      )
    if (body.method === 'totp' || body.method === 'all')
      await db.query(
        'UPDATE users SET totp_secret=NULL,totp_last_step=NULL WHERE id=$1',
        [user.id],
      )
    if (body.method === 'passkey' || body.method === 'all') {
      await db.query(
        'DELETE FROM passkeys WHERE user_id=$1 AND ($2::text IS NULL OR id=$2)',
        [user.id, body.method === 'all' ? null : (body.credentialId ?? null)],
      )
      await db.query(
        'UPDATE users SET passkey_2fa=EXISTS(SELECT 1 FROM passkeys WHERE user_id=$1) WHERE id=$1',
        [user.id],
      )
    }
    return finishChange(db, user)
  })
  return changed(c, outcome)
})
auth.post('/security/recovery-codes', async (c) => {
  const outcome = await transaction(async (db) => {
    const user = await securityUser(db, c)
    if (!enabled(user).length)
      throw new HTTPException(400, {
        message: 'Enable a second factor before generating recovery codes.',
      })
    const codes = await recoveryCodes(db, user.id)
    return { ...(await finishChange(db, user)), codes }
  })
  return changed(c, outcome)
})
auth.post('/logout', async (c) => {
  await pool.query('DELETE FROM sessions WHERE token=$1', [sessionHash(c)])
  for (const name of [
    'session',
    'pending',
    'security_grant',
    'factor_enrollment',
  ])
    setCookie(c, name, '', { ...cookieOptions(c), maxAge: 0 })
  return c.json({ ok: true })
})
auth.get('/me', requireIdentity, async (c) => {
  const identity = c.get('user')
  if (!accountsEnabled()) return c.json(identity)
  const org = c.get('requestOrganization')
  const query = () =>
    pool.query(
      'SELECT admin,capabilities FROM users WHERE id=$1 AND NOT disabled AND NOT invitation_pending',
      [identity.id],
    )
  const member = (
    org
      ? await runWithOrganization(org, query)
      : await organizationContext.exit(query)
  ).rows[0]
  return c.json({
    ...identity,
    organization_member: !!member,
    admin: member?.admin ?? false,
    capabilities: member?.capabilities ?? [],
  })
})

auth.get('/invitation', async (c) => {
  const secret = z.string().min(32).max(100).parse(c.req.query('token'))
  if (accountsEnabled()) {
    const invite = await invitationRecord(pool, secret)
    if (invite) {
      const { findOrganization } = await import('./organizations.js')
      const org = await findOrganization(invite.organization)
      return c.json({
        email: invite.email,
        existing_account: invite.existing_account,
        organization: { slug: org.slug, name: org.name },
      })
    }
  }
  const legacy = (
    await pool.query(
      'SELECT u.email,u.username FROM invitations i JOIN users u ON u.id=i.user_id WHERE i.token=$1 AND i.expires>now()',
      [digest(secret)],
    )
  ).rows[0]
  if (!legacy)
    throw new HTTPException(404, {
      message: 'Invitation expired or unavailable',
    })
  return c.json({
    email: legacy.email,
    existing_account: false,
    organization: {
      slug: c.get('requestOrganization')?.slug ?? 'default',
      name: 'Organization',
    },
  })
})
auth.post('/invitations/accept', requireIdentity, async (c) => {
  const body = z
    .object({ token: z.string().min(32).max(100) })
    .strict()
    .parse(await c.req.json())
  await acceptInvitation(c, body.token, c.get('user'))
  return c.json({ ok: true })
})
auth.patch('/profile', requireIdentity, async (c) => {
  const body = z
    .object({ email: z.email().max(254), password: z.string().min(1).max(256) })
    .strict()
    .parse(await c.req.json())
  if (!accountsEnabled())
    throw new HTTPException(503, { message: 'Run account migrations first' })
  await rateLimit(digest('profile:' + c.get('user').id), 10)
  await transaction(async (db) => {
    const user = (
      await db.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [
        c.get('user').id,
      ])
    ).rows[0]
    if (!user || !(await verifyPassword(body.password, user.password_hash)))
      throw new HTTPException(403, { message: 'Current password is incorrect' })
    await db.query('UPDATE users SET account_email=$2 WHERE id=$1', [
      c.get('user').id,
      body.email.toLowerCase(),
    ])
  })
  return c.json({ email: body.email.toLowerCase() })
})
async function acceptInvitation(
  c: Context<Env>,
  secret: string,
  identity?: User,
  passwordHash?: string,
) {
  const { findOrganization } = await import('./organizations.js')
  await transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(842193)')
    const invite = await invitationRecord(db, secret, true)
    if (!invite)
      throw new HTTPException(409, {
        message: 'Invitation expired or already accepted',
      })
    if (identity && identity.id !== invite.user_id)
      throw new HTTPException(403, {
        message: 'Sign in with the account invited to this organization',
      })
    if (!identity && (invite.existing_account || !passwordHash))
      throw new HTTPException(409, {
        message: 'Sign in to accept this invitation',
      })
    const org = await findOrganization(invite.organization)
    const target = `"${org.schema}"`
    const creator = (
      await db.query(
        `SELECT id,username,admin,capabilities FROM ${target}.users WHERE id=$1 AND NOT disabled`,
        [invite.created_by],
      )
    ).rows[0]
    if (
      !creator ||
      (!creator.admin &&
        !creator.capabilities.includes('users.manage') &&
        !invite.project)
    )
      throw new HTTPException(403, {
        message: 'Invitation issuer no longer has permission',
      })
    if ((invite.admin || invite.capabilities.length) && !creator.admin)
      throw new HTTPException(403, {
        message: 'Invitation issuer no longer has administrator permission',
      })
    if (invite.project) {
      const { demandProjectAdmin } = await import('./permissions.js')
      await runWithOrganization(org, () =>
        demandProjectAdmin(creator, invite.project),
      )
    }
    if (passwordHash)
      await db.query(
        'UPDATE users SET password_hash=$2,security_version=security_version+1 WHERE id=$1',
        [invite.user_id, passwordHash],
      )
    const account = (
      await db.query(
        'SELECT id,username,account_email AS email,password_hash FROM users WHERE id=$1',
        [invite.user_id],
      )
    ).rows[0]
    await db.query(
      `UPDATE ${target}.users SET username=$2,email=$3,account_email=$3,disabled=false,invitation_pending=false,admin=CASE WHEN disabled THEN $4 ELSE admin END,capabilities=CASE WHEN disabled THEN $5 ELSE capabilities END,password_hash='global-account' WHERE id=$1`,
      [
        account.id,
        account.username,
        account.email,
        invite.admin,
        invite.capabilities,
      ],
    )
    if (invite.project) {
      await db.query("SELECT set_config('search_path',$1,true)", [org.schema])
      if (
        (
          await db.query(
            'SELECT 1 FROM memberships WHERE user_id=$1 AND project_slug=$2',
            [account.id, invite.project],
          )
        ).rowCount
      )
        throw new HTTPException(409, {
          message: 'Account is already a project member',
        })
      await db.query(
        'INSERT INTO memberships(user_id,project_slug,role) VALUES($1,$2,$3)',
        [account.id, invite.project, invite.project_role],
      )
      const { applyInvitedMemberGrants, memberBody } =
        await import('./project-permissions.js')
      await applyInvitedMemberGrants(
        db,
        creator,
        account.id,
        invite.project,
        memberBody.parse(invite.project_grants),
      )
    }
    await db.query(
      `UPDATE ${accountTable('organization_invitations')} SET accepted=now() WHERE token=$1`,
      [digest(secret)],
    )
  })
}
