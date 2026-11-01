import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { rawPool } from './db.js'
import { runWithOrganization } from './organization-context.js'

let accountSchema: string | undefined
let initialization: Promise<void> | undefined
export const accountsEnabled = () => accountSchema !== undefined
export const getAccountSchema = () => accountSchema
export function withAccounts<T>(operation: () => T): T {
  return accountSchema
    ? runWithOrganization(
        { slug: '__accounts', schema: accountSchema },
        operation,
      )
    : operation()
}
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"'
const schemaName = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid account schema')
  return value
}

async function extraAccountTables(db: PoolClient) {
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_email text;
    CREATE UNIQUE INDEX IF NOT EXISTS users_account_email_unique ON users(lower(account_email)) WHERE account_email IS NOT NULL;
    CREATE TABLE IF NOT EXISTS organization_invitations (
      token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      organization text NOT NULL, created_by uuid NOT NULL REFERENCES users,
      admin boolean NOT NULL DEFAULT false, capabilities text[] NOT NULL DEFAULT '{}',
      project text, project_role text NOT NULL DEFAULT 'member' CHECK(project_role IN ('member','admin')),
      project_grants jsonb, expires timestamptz NOT NULL DEFAULT now()+interval '24 hours', accepted timestamptz
    );
    CREATE INDEX IF NOT EXISTS organization_invitations_user ON organization_invitations(user_id);
    CREATE INDEX IF NOT EXISTS organization_invitations_expiry ON organization_invitations(expires);
  `)
}

export async function initializeGlobalAccounts(
  runMigrationDatabase?: (db: PoolClient) => Promise<void>,
) {
  if (initialization) return initialization
  initialization = initialize(runMigrationDatabase).catch((error) => {
    initialization = undefined
    throw error
  })
  return initialization
}

async function initialize(
  runMigrationDatabase?: (db: PoolClient) => Promise<void>,
) {
  const migrate =
    runMigrationDatabase ?? (await import('./migrate.js')).migrateDatabase
  const db = await rawPool.connect()
  let resolved: string | undefined
  try {
    await db.query('BEGIN')
    await db.query('SELECT pg_advisory_xact_lock(842194)')
    const root = (await db.query('SELECT current_schema() AS schema')).rows[0]
      .schema as string
    if (!root)
      throw new Error(
        'The account registry requires a configured database schema',
      )
    const registry = `${identifier(root)}.kloud_account_store`
    await db.query(`CREATE TABLE IF NOT EXISTS ${registry} (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), schema_name text NOT NULL UNIQUE
    )`)
    const existing = (
      await db.query(
        `SELECT schema_name FROM ${registry} WHERE singleton FOR UPDATE`,
      )
    ).rows[0]
    resolved = existing
      ? schemaName(existing.schema_name)
      : `kloud_accounts_${randomUUID().replaceAll('-', '')}`
    const target = identifier(resolved)
    if (!existing) await db.query(`CREATE SCHEMA ${target}`)
    await db.query("SELECT set_config('search_path',$1,true)", [target])
    await migrate(db)
    await extraAccountTables(db)
    if (!existing) {
      const rootRegistry = `${identifier(root)}.kloud_organizations`
      const registryExists = (
        await db.query('SELECT to_regclass($1) AS table_name', [rootRegistry])
      ).rows[0].table_name
      const sources: { schema: string }[] = registryExists
        ? (
            await db.query(
              `SELECT schema_name AS schema FROM ${rootRegistry} ORDER BY CASE WHEN slug='default' THEN 0 ELSE 1 END,slug`,
            )
          ).rows
        : [{ schema: root }]
      // Preserve stable IDs and credentials. Similar names/emails never imply
      // that separately created legacy users are the same account.
      for (const source of sources) {
        const origin = identifier(schemaName(source.schema))
        await db.query(`LOCK TABLE ${origin}.users IN SHARE ROW EXCLUSIVE MODE`)
        const users = (
          await db.query(`SELECT * FROM ${origin}.users ORDER BY id`)
        ).rows
        for (const user of users) {
          const duplicate = (
            await db.query(
              'SELECT password_hash,email_2fa,totp_secret,passkey_2fa FROM users WHERE id=$1',
              [user.id],
            )
          ).rows[0]
          if (duplicate) {
            if (
              duplicate.password_hash !== user.password_hash ||
              duplicate.email_2fa !== user.email_2fa ||
              duplicate.totp_secret !== user.totp_secret ||
              duplicate.passkey_2fa !== user.passkey_2fa
            )
              throw new Error(
                'Legacy accounts with the same user ID have conflicting credentials; resolve them before migration',
              )
            continue
          }
          let username = user.username as string
          if (
            (
              await db.query(
                'SELECT 1 FROM users WHERE lower(username)=lower($1)',
                [username],
              )
            ).rowCount
          )
            username = `${username.slice(0, 63)}-${String(user.id).replaceAll('-', '')}`
          const suppliedEmail =
            typeof user.email === 'string'
              ? user.email.trim().toLowerCase()
              : null
          const email =
            suppliedEmail &&
            !(
              await db.query(
                'SELECT 1 FROM users WHERE lower(account_email)=$1',
                [suppliedEmail],
              )
            ).rowCount
              ? suppliedEmail
              : null
          await db.query(
            `INSERT INTO users(id,username,password_hash,admin,disabled,capabilities,security_version,email,email_2fa,totp_secret,totp_last_step,passkey_2fa,account_email)
            VALUES($1,$2,$3,false,$4,'{}',$5,$6,$7,$8,$9,$10,$11)`,
            [
              user.id,
              username,
              user.password_hash,
              false, // Legacy disablement is an organization membership state.
              user.security_version,
              user.email,
              user.email_2fa,
              user.totp_secret,
              user.totp_last_step,
              user.passkey_2fa,
              email,
            ],
          )
        }
      }
      for (const source of sources) {
        const origin = identifier(schemaName(source.schema))
        for (const [table, keys] of [
          ['passkeys', ['id']],
          ['sessions', ['token']],
          ['invitations', ['token']],
          ['challenges', ['token']],
          ['auth_pending', ['token']],
          ['recovery_codes', ['user_id', 'hash']],
          ['auth_email_limits', ['user_id']],
        ] as const) {
          const conflict = (
            await db.query(
              `SELECT 1 FROM ${origin}.${table} s JOIN ${target}.${table} d USING(${keys.join(',')}) WHERE s.user_id IS DISTINCT FROM d.user_id LIMIT 1`,
            )
          ).rowCount
          if (conflict)
            throw new Error(
              'Legacy authentication records conflict across accounts; resolve them before migration',
            )
          await db.query(
            `INSERT INTO ${target}.${table} SELECT * FROM ${origin}.${table} ON CONFLICT DO NOTHING`,
          )
        }
        // Outstanding login challenges cannot safely become cross-organization
        // challenges. Session tokens, enrolled factors and recovery codes remain.
        await db.query(
          `DELETE FROM ${target}.auth_pending WHERE user_id IN (SELECT id FROM ${origin}.users)`,
        )
        await scrubOrganizationAccounts(db, origin, target)
      }
      await db.query(`INSERT INTO ${registry}(schema_name) VALUES($1)`, [
        resolved,
      ])
    } else {
      const rootRegistry = `${identifier(root)}.kloud_organizations`
      const registryExists = (
        await db.query('SELECT to_regclass($1) AS table_name', [rootRegistry])
      ).rows[0].table_name
      const sources: { schema: string }[] = registryExists
        ? (await db.query(`SELECT schema_name AS schema FROM ${rootRegistry}`))
            .rows
        : [{ schema: root }]
      for (const source of sources)
        await db.query(
          `ALTER TABLE ${identifier(schemaName(source.schema))}.users ADD COLUMN IF NOT EXISTS invitation_pending boolean NOT NULL DEFAULT false`,
        )
    }
    await db.query('COMMIT')
    accountSchema = resolved
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally {
    db.release()
  }
}

async function scrubOrganizationAccounts(
  db: PoolClient,
  origin: string,
  target: string,
) {
  await db.query(
    `ALTER TABLE ${origin}.users ADD COLUMN IF NOT EXISTS account_email text, ADD COLUMN IF NOT EXISTS invitation_pending boolean NOT NULL DEFAULT false`,
  )
  await db.query(`UPDATE ${origin}.users l SET account_email=g.account_email,
    password_hash=CASE WHEN g.password_hash IS NOT NULL THEN 'global-account' ELSE NULL END,
    email=NULL,email_2fa=false,totp_secret=NULL,totp_last_step=NULL,passkey_2fa=false
    FROM ${target}.users g WHERE g.id=l.id`)
  // Keep membership/grant FKs local while ensuring every shadow points to an
  // existing central identity. Deleting an account removes its org memberships.
  await db.query(
    `ALTER TABLE ${origin}.users ADD CONSTRAINT users_global_account_fkey FOREIGN KEY(id) REFERENCES ${target}.users(id) ON DELETE CASCADE`,
  )
  for (const table of [
    'challenges',
    'auth_pending',
    'passkeys',
    'sessions',
    'invitations',
    'recovery_codes',
    'auth_email_limits',
    'setup_challenges',
    'login_attempts',
  ])
    await db.query(`DELETE FROM ${origin}.${table}`)
}

export async function linkOrganizationAccount(
  db: PoolClient,
  user: {
    id: string
    username: string
    email?: string | null
    password_hash?: string | null
  },
  role: { admin: boolean; capabilities?: string[] },
) {
  if (!accountSchema) throw new Error('Shared accounts are not initialized')
  await db.query(
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS account_email text, ADD COLUMN IF NOT EXISTS invitation_pending boolean NOT NULL DEFAULT false',
  )
  const constrained = (
    await db.query(
      "SELECT 1 FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_global_account_fkey'",
    )
  ).rowCount
  if (!constrained)
    await db.query(
      `ALTER TABLE users ADD CONSTRAINT users_global_account_fkey FOREIGN KEY(id) REFERENCES ${identifier(accountSchema)}.users(id) ON DELETE CASCADE`,
    )
  const existing = (
    await db.query('SELECT id,disabled FROM users WHERE id=$1 FOR UPDATE', [
      user.id,
    ])
  ).rows[0]
  if (existing) return existing
  let username = user.username
  if (
    (
      await db.query('SELECT 1 FROM users WHERE lower(username)=lower($1)', [
        username,
      ])
    ).rowCount
  )
    username = `${username.slice(0, 63)}-${user.id.replaceAll('-', '')}`
  return (
    await db.query(
      `INSERT INTO users(id,username,account_email,password_hash,admin,capabilities)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id,disabled`,
      [
        user.id,
        username,
        user.email ?? null,
        user.password_hash === null ? null : 'global-account',
        role.admin,
        role.capabilities ?? [],
      ],
    )
  ).rows[0]
}
