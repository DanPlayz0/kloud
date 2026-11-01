import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import type { PoolClient } from 'pg'
import { getAccountSchema, accountsEnabled } from './global-accounts.js'
import { digest, token, publicOrigin } from './security.js'
import type { User } from './auth.js'

export function accountTable(table: string) {
  const schema = getAccountSchema()
  return schema ? `"${schema}".${table}` : table
}
export async function inviteAccount(
  db: PoolClient,
  actor: User,
  organization: string,
  body: {
    email: string
    username?: string
    admin?: boolean
    capabilities?: string[]
    project?: string
    project_role?: string
    project_grants?: unknown
  },
) {
  if (!accountsEnabled())
    throw new HTTPException(503, {
      message: 'Shared accounts require the current database migration',
    })
  const email = body.email.trim().toLowerCase()
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,842195))', [
    email,
  ])
  let account = (
    await db.query(
      `SELECT id,username,account_email AS email,password_hash,disabled FROM ${accountTable('users')} WHERE lower(account_email)=$1`,
      [email],
    )
  ).rows[0]
  if (!account) {
    const id = randomUUID()
    let username = (body.username || email)
      .toLowerCase()
      .replace(/[^a-z0-9_.@-]/g, '-')
      .slice(0, 90)
    if (
      (
        await db.query(
          `SELECT 1 FROM ${accountTable('users')} WHERE lower(username)=$1`,
          [username],
        )
      ).rowCount
    )
      username += '-' + id.slice(0, 8)
    account = (
      await db.query(
        `INSERT INTO ${accountTable('users')}(id,username,account_email,email) VALUES($1,$2,$3,$3) RETURNING id,username,account_email AS email,password_hash,disabled`,
        [id, username, email],
      )
    ).rows[0]
  }
  if (account.disabled)
    throw new HTTPException(409, { message: 'Account unavailable' })
  const member = (
    await db.query(
      'SELECT disabled,invitation_pending FROM users WHERE id=$1',
      [account.id],
    )
  ).rows[0]
  if (member?.disabled && !member.invitation_pending)
    throw new HTTPException(409, {
      message:
        'Organization membership is disabled; an organization administrator must restore it explicitly',
    })
  if (member && !member.disabled && !body.project)
    throw new HTTPException(409, {
      message: 'Account already belongs to this organization',
    })
  // A pending shadow is disabled until the recipient explicitly accepts.
  await db.query(
    `INSERT INTO users(id,username,email,account_email,admin,capabilities,disabled,invitation_pending,password_hash) VALUES($1,$2,$3,$3,false,'{}',true,true,$4) ON CONFLICT(id) DO NOTHING`,
    [
      account.id,
      account.username,
      email,
      account.password_hash ? 'global-account' : null,
    ],
  )
  await db.query(
    `DELETE FROM ${accountTable('organization_invitations')} WHERE user_id=$1 AND organization=$2 AND accepted IS NULL`,
    [account.id, organization],
  )
  const secret = token()
  await db.query(
    `INSERT INTO ${accountTable('organization_invitations')}(token,user_id,organization,created_by,admin,capabilities,project,project_role,project_grants) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      digest(secret),
      account.id,
      organization,
      actor.id,
      body.admin ?? false,
      body.capabilities ?? [],
      body.project ?? null,
      body.project_role ?? 'member',
      body.project_grants ? JSON.stringify(body.project_grants) : null,
    ],
  )
  return {
    email,
    invitationUrl: `${publicOrigin}/enroll?organization=${encodeURIComponent(organization)}#${secret}`,
    secret,
  }
}
export async function invitationRecord(
  db: Pick<PoolClient, 'query'>,
  secret: string,
  lock = false,
) {
  return (
    await db.query(
      `SELECT i.*,u.account_email AS email,u.username,(u.password_hash IS NOT NULL) AS existing_account FROM ${accountTable('organization_invitations')} i JOIN ${accountTable('users')} u ON u.id=i.user_id WHERE i.token=$1 AND i.expires>now() AND i.accepted IS NULL AND NOT u.disabled ${lock ? 'FOR UPDATE OF i,u' : ''}`,
      [digest(secret)],
    )
  ).rows[0]
}
