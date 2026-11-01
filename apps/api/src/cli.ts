import {
  initializeGlobalAccounts,
  accountsEnabled,
  withAccounts,
  linkOrganizationAccount,
} from './global-accounts.js'
import { rawPool } from './db.js'
import { findOrganization } from './organizations.js'
import {
  organizationContext,
  organizationBrowserQuery,
} from './organization-context.js'
import { randomUUID } from 'node:crypto'
import { pool, transaction } from './db.js'
import { token, digest, publicOrigin } from './security.js'
import { clearFactors } from './auth-factors.js'
const [command, username, organization] = process.argv.slice(2)
try {
  if (
    !['bootstrap', 'recover'].includes(command ?? '') ||
    !username ||
    !/^[a-zA-Z0-9_.@-]{1,100}$/.test(username)
  )
    throw new Error('Usage: cli bootstrap|recover <username> [organization]')
  if (organization)
    organizationContext.enterWith(await findOrganization(organization))
  const registered = (
    await rawPool.query(
      "SELECT to_regclass('kloud_account_store') AS registered",
    )
  ).rows[0].registered
  if (registered) await initializeGlobalAccounts()
  const localUser =
    command === 'recover'
      ? (
          await pool.query('SELECT id FROM users WHERE username=$1', [
            username.toLowerCase(),
          ])
        ).rows[0]
      : null
  if (
    accountsEnabled() &&
    command === 'bootstrap' &&
    (
      await pool.query(
        'SELECT 1 FROM users WHERE admin AND NOT disabled LIMIT 1',
      )
    ).rowCount
  )
    throw new Error('An Organization Administrator already exists; use recover')
  let accountId: string | undefined
  const invitation = token()
  await withAccounts(() =>
    transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(842192)')
      let id: string
      if (command === 'bootstrap') {
        if ((await db.query('SELECT 1 FROM users WHERE admin')).rowCount)
          throw new Error(
            'An Organization Administrator already exists; use recover',
          )
        id = randomUUID()
        await db.query(
          'INSERT INTO users(id,username,admin) VALUES($1,$2,true)',
          [id, username.toLowerCase()],
        )
      } else {
        const user = (
          await db.query(
            localUser
              ? 'SELECT id FROM users WHERE id=$1 FOR UPDATE'
              : 'SELECT id FROM users WHERE username=$1 FOR UPDATE',
            [localUser?.id ?? username.toLowerCase()],
          )
        ).rows[0]
        if (!user) throw new Error('User does not exist')
        id = user.id
        await db.query(
          'UPDATE users SET disabled=false,password_hash=NULL WHERE id=$1',
          [id],
        )
        await clearFactors(db, id)
      }
      accountId = id
      await db.query(
        `INSERT INTO invitations(token,user_id,expires) VALUES($1,$2,now()+interval '24 hours')`,
        [digest(invitation), id],
      )
    }),
  )
  if (accountsEnabled() && command === 'bootstrap')
    await transaction((db) =>
      linkOrganizationAccount(
        db,
        {
          id: accountId!,
          username: username.toLowerCase(),
          password_hash: null,
        },
        { admin: true, capabilities: [] },
      ),
    )
  console.log(
    `${publicOrigin}/enroll${organizationBrowserQuery()}#${invitation}`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Command failed')
  process.exitCode = 1
} finally {
  await pool.end()
}
