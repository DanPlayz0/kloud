import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
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
  publicOrigin,
  rpID,
} from './security.js'

export interface User {
  id: string
  username: string
  admin: boolean
}
export type Env = { Variables: { user: User } }
export const auth = new Hono<Env>()
const password = z.string().min(12).max(256)
const cookieOptions = {
  httpOnly: true,
  secure: publicOrigin.startsWith('https:'),
  sameSite: 'Strict' as const,
  path: '/',
}
export const currentUser = async (c: Context) => {
  const value = getCookie(c, 'session')
  if (!value) return undefined
  const result = await pool.query<User>(
    'SELECT u.id,u.username,u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires>now() AND NOT u.disabled',
    [digest(value)],
  )
  return result.rows[0]
}
export const requireUser = async (
  c: Context<Env>,
  next: () => Promise<void>,
) => {
  const user = await currentUser(c)
  if (!user) return c.json({ error: 'Authentication required' }, 401)
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

// Once populated, setup stays closed for this process's lifetime. Only cache
// positive results so an empty installation can still detect CLI bootstrap.
let accountsExist = false
let accountCheck: Promise<boolean> | undefined
async function hasAccounts(): Promise<boolean> {
  if (accountsExist) return true
  if (!accountCheck) {
    accountCheck = pool
      .query('SELECT EXISTS(SELECT 1 FROM users) AS populated')
      .then((result) => {
        accountsExist ||= result.rows[0].populated
        return accountsExist
      })
      .finally(() => {
        accountCheck = undefined
      })
  }
  return accountCheck
}

auth.get('/setup', async (c) => c.json({ required: !(await hasAccounts()) }))

// Reject repeated setup submissions before opening a database transaction.
auth.use('/setup/*', async (c, next) => {
  if (await hasAccounts())
    return c.json({ error: 'Setup is complete. Sign in to your account.' }, 409)
  await next()
})

// Lock against every user-creation path, including CLI bootstrap and invitations.
async function requireEmptyUsers(db: import('pg').PoolClient) {
  await db.query('SELECT pg_advisory_xact_lock(842192)')
  await db.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
  if ((await db.query('SELECT 1 FROM users LIMIT 1')).rowCount) {
    accountsExist = true
    throw new HTTPException(409, {
      message: 'Setup is complete. Sign in to your account.',
    })
  }
}

auth.post('/setup/options', async (c) => {
  const body = z
    .object({
      username: z.string().regex(/^[a-zA-Z0-9_.@-]{1,100}$/),
      password,
    })
    .parse(await c.req.json())
  const pending = token()
  const options = await transaction(async (db) => {
    await requireEmptyUsers(db)
    const userID = randomUUID()
    const options = await generateRegistrationOptions({
      rpName: 'Dedi Dash',
      rpID,
      userName: body.username.toLowerCase(),
      userID: new TextEncoder().encode(userID),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    })
    await db.query(
      'DELETE FROM setup_challenges WHERE expires<=now() OR token=$1',
      [digest(getCookie(c, 'setup') ?? '')],
    )
    await db.query(
      `INSERT INTO setup_challenges(token,user_id,username,password_hash,challenge,expires)
       VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')`,
      [
        digest(pending),
        userID,
        body.username.toLowerCase(),
        await hashPassword(body.password),
        options.challenge,
      ],
    )
    return options
  })
  setCookie(c, 'setup', pending, { ...cookieOptions, maxAge: 300 })
  return c.json(options)
})

auth.post('/setup/verify', async (c) => {
  const body = z.record(z.string(), z.any()).parse(await c.req.json())
  const success = await transaction(async (db) => {
    await requireEmptyUsers(db)
    const challenge = (
      await db.query(
        'DELETE FROM setup_challenges WHERE token=$1 AND expires>now() RETURNING *',
        [digest(getCookie(c, 'setup') ?? '')],
      )
    ).rows[0]
    if (!challenge) return false
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: body as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: publicOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
      })
    } catch {
      return false
    }
    if (!verification.verified || !verification.registrationInfo) return false
    const credential = verification.registrationInfo.credential
    await db.query(
      'INSERT INTO users(id,username,password_hash,admin) VALUES($1,$2,$3,true)',
      [challenge.user_id, challenge.username, challenge.password_hash],
    )
    await db.query(
      'INSERT INTO passkeys(id,user_id,public_key,counter,transports) VALUES($1,$2,$3,$4,$5)',
      [
        credential.id,
        challenge.user_id,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
      ],
    )
    await db.query('DELETE FROM setup_challenges')
    return true
  })
  // Publish only after the account and passkey transaction has committed.
  if (success) accountsExist = true
  setCookie(c, 'setup', '', { ...cookieOptions, maxAge: 0 })
  return success
    ? c.json({ ok: true })
    : c.json({ error: 'Setup failed or expired. Start again.' }, 400)
})

auth.post('/password', async (c) => {
  const body = z
    .object({
      username: z.string().min(1).max(100),
      password: z.string().min(1).max(256),
    })
    .parse(await c.req.json())
  const key = digest(body.username.toLowerCase())
  const attempt = await pool.query(
    `INSERT INTO login_attempts(key,attempts,expires) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.expires<now() THEN 1 ELSE login_attempts.attempts+1 END, expires=CASE WHEN login_attempts.expires<now() THEN now()+interval '15 minutes' ELSE login_attempts.expires END RETURNING attempts`,
    [key],
  )
  if (attempt.rows[0].attempts > 10)
    return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)
  const result = await pool.query(
    'SELECT * FROM users WHERE lower(username)=$1',
    [body.username.toLowerCase()],
  )
  const user = result.rows[0]
  const valid = await verifyPassword(
    body.password,
    user?.password_hash ??
      '00000000000000000000000000000000:' + '00'.repeat(64),
  )
  if (!user || user.disabled || !valid)
    return c.json({ error: 'Invalid credentials' }, 401)
  const keys = await pool.query(
    'SELECT id,transports FROM passkeys WHERE user_id=$1',
    [user.id],
  )
  if (!keys.rowCount)
    return c.json(
      { error: 'Passkey enrollment required. Contact your administrator.' },
      403,
    )
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: keys.rows.map((k) => ({
      id: k.id,
      transports: k.transports,
    })),
  })
  const pending = token()
  await pool.query(
    `INSERT INTO challenges(token,user_id,kind,challenge,password_hash,expires) VALUES($1,$2,'login',$3,$4,now()+interval '5 minutes')`,
    [digest(pending), user.id, options.challenge, user.password_hash],
  )
  setCookie(c, 'pending', pending, { ...cookieOptions, maxAge: 300 })
  return c.json(options)
})

auth.post('/verify', async (c) => {
  const pending = getCookie(c, 'pending') ?? ''
  const body = z.record(z.string(), z.any()).parse(await c.req.json())
  const result = await transaction(async (db) => {
    const challenge = (
      await db.query(
        `SELECT * FROM challenges WHERE token=$1 AND kind='login' AND expires>now()`,
        [digest(pending)],
      )
    ).rows[0]
    if (!challenge) return null
    const user = (
      await db.query(
        'SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
        [challenge.user_id],
      )
    ).rows[0]
    if (!user || user.password_hash !== challenge.password_hash) return null
    const consumed = await db.query(
      `DELETE FROM challenges WHERE token=$1 AND expires>now() RETURNING token`,
      [digest(pending)],
    )
    if (!consumed.rowCount) return null
    const key = (
      await db.query(
        'SELECT * FROM passkeys WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [typeof body.id === 'string' ? body.id : '', challenge.user_id],
      )
    ).rows[0]
    if (!key) return null
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response: body as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: publicOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: key.id,
          publicKey: new Uint8Array(key.public_key),
          counter: Number(key.counter),
          transports: key.transports,
        },
      })
    } catch {
      return null
    }
    if (!verification.verified) return null
    await db.query('UPDATE passkeys SET counter=$1 WHERE id=$2', [
      verification.authenticationInfo.newCounter,
      key.id,
    ])
    const session = token()
    await db.query(
      `INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '8 hours')`,
      [digest(session), user.id],
    )
    await db.query('DELETE FROM login_attempts WHERE key=$1', [
      digest(user.username.toLowerCase()),
    ])
    return session
  })
  setCookie(c, 'pending', '', { ...cookieOptions, maxAge: 0 })
  if (!result)
    return c.json({ error: 'Passkey verification failed. Start again.' }, 401)
  setCookie(c, 'session', result, { ...cookieOptions, maxAge: 28800 })
  return c.json({ ok: true })
})

auth.post('/enroll/options', async (c) => {
  const body = z
    .object({ token: z.string().min(32).max(100), password })
    .parse(await c.req.json())
  const invitation = (
    await pool.query(
      'SELECT i.*,u.username FROM invitations i JOIN users u ON u.id=i.user_id WHERE i.token=$1 AND i.expires>now() AND NOT u.disabled',
      [digest(body.token)],
    )
  ).rows[0]
  if (!invitation)
    return c.json({ error: 'Invitation is invalid or expired' }, 400)
  const options = await generateRegistrationOptions({
    rpName: 'Dedi Dash',
    rpID,
    userName: invitation.username,
    userID: new TextEncoder().encode(invitation.user_id),
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  })
  const pending = token()
  await pool.query(
    `INSERT INTO challenges(token,user_id,kind,challenge,password_hash,invitation,expires) VALUES($1,$2,'enroll',$3,$4,$5,now()+interval '5 minutes')`,
    [
      digest(pending),
      invitation.user_id,
      options.challenge,
      await hashPassword(body.password),
      digest(body.token),
    ],
  )
  setCookie(c, 'enrollment', pending, { ...cookieOptions, maxAge: 300 })
  return c.json(options)
})

auth.post('/enroll/verify', async (c) => {
  const pending = getCookie(c, 'enrollment') ?? ''
  const body = z.record(z.string(), z.any()).parse(await c.req.json())
  const success = await transaction(async (db) => {
    const challenge = (
      await db.query(
        `SELECT * FROM challenges WHERE token=$1 AND kind='enroll' AND expires>now()`,
        [digest(pending)],
      )
    ).rows[0]
    if (!challenge) return false
    const user = (
      await db.query(
        'SELECT id FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
        [challenge.user_id],
      )
    ).rows[0]
    if (!user) return false
    const consumed = await db.query(
      `DELETE FROM challenges WHERE token=$1 AND expires>now() RETURNING token`,
      [digest(pending)],
    )
    if (!consumed.rowCount) return false
    const invitation = (
      await db.query(
        'SELECT token FROM invitations WHERE token=$1 AND expires>now() FOR UPDATE',
        [challenge.invitation],
      )
    ).rows[0]
    if (!user || !invitation) return false
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: body as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: publicOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
      })
    } catch {
      return false
    }
    if (!verification.verified || !verification.registrationInfo) return false
    const credential = verification.registrationInfo.credential
    await db.query('DELETE FROM sessions WHERE user_id=$1', [user.id])
    await db.query('DELETE FROM passkeys WHERE user_id=$1', [user.id])
    await db.query(
      'INSERT INTO passkeys(id,user_id,public_key,counter,transports) VALUES($1,$2,$3,$4,$5)',
      [
        credential.id,
        user.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
      ],
    )
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [
      challenge.password_hash,
      user.id,
    ])
    await db.query('DELETE FROM challenges WHERE user_id=$1', [user.id])
    await db.query('DELETE FROM invitations WHERE user_id=$1', [user.id])
    return true
  })
  setCookie(c, 'enrollment', '', { ...cookieOptions, maxAge: 0 })
  return success
    ? c.json({ ok: true })
    : c.json({ error: 'Enrollment failed or expired. Start again.' }, 400)
})

auth.post('/logout', async (c) => {
  await pool.query('DELETE FROM sessions WHERE token=$1', [
    digest(getCookie(c, 'session') ?? ''),
  ])
  setCookie(c, 'session', '', { ...cookieOptions, maxAge: 0 })
  return c.json({ ok: true })
})
auth.get('/me', requireUser, (c) => c.json(c.get('user')))
