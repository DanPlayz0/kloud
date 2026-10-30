import { pool, transaction } from './db.js'
export const migration = `
CREATE TABLE users (id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text, admin boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false);
CREATE TABLE projects (slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'), name text NOT NULL);
CREATE TABLE memberships (user_id uuid REFERENCES users ON DELETE CASCADE, project_slug text REFERENCES projects ON DELETE CASCADE, PRIMARY KEY(user_id, project_slug));
CREATE TABLE passkeys (id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, public_key bytea NOT NULL, counter bigint NOT NULL, transports jsonb NOT NULL);
CREATE TABLE sessions (token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, expires timestamptz NOT NULL);
CREATE TABLE invitations (token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, expires timestamptz NOT NULL);
CREATE TABLE challenges (token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, kind text NOT NULL CHECK(kind IN ('login','enroll')), challenge text NOT NULL, password_hash text, invitation text REFERENCES invitations ON DELETE CASCADE, expires timestamptz NOT NULL);
CREATE TABLE login_attempts (key text PRIMARY KEY, attempts integer NOT NULL, expires timestamptz NOT NULL);
CREATE TABLE connectors (id uuid PRIMARY KEY, name text NOT NULL, token text UNIQUE NOT NULL, discovery boolean NOT NULL DEFAULT false, revoked boolean NOT NULL DEFAULT false, host text, seen timestamptz);
CREATE TABLE inventory (connector_id uuid REFERENCES connectors ON DELETE CASCADE, container_id text, data jsonb NOT NULL, PRIMARY KEY(connector_id,container_id));
CREATE TABLE assignments (connector_id uuid REFERENCES connectors ON DELETE CASCADE, container_id text, project_slug text NOT NULL REFERENCES projects ON DELETE CASCADE, application text NOT NULL CHECK(application ~ '^[a-z0-9]+(-[a-z0-9]+)*$'), PRIMARY KEY(connector_id,container_id));
CREATE INDEX sessions_expiry ON sessions(expires);
CREATE INDEX passkeys_user ON passkeys(user_id);
`
export async function migrate() {
  await transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(842191)')
    await db.query(
      'CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, applied timestamptz NOT NULL DEFAULT now())',
    )
    const result = await db.query(
      'SELECT version FROM migrations WHERE version=1',
    )
    if (!result.rowCount) {
      await db.query(migration)
      await db.query('INSERT INTO migrations(version) VALUES(1)')
    }
    if (
      !(await db.query('SELECT version FROM migrations WHERE version=2'))
        .rowCount
    ) {
      await db.query(`CREATE TABLE setup_challenges (
        token text PRIMARY KEY, user_id uuid NOT NULL, username text NOT NULL,
        password_hash text NOT NULL, challenge text NOT NULL, expires timestamptz NOT NULL
      )`)
      await db.query('INSERT INTO migrations(version) VALUES(2)')
    }
    if (
      !(await db.query('SELECT version FROM migrations WHERE version=3'))
        .rowCount
    ) {
      await db.query(`
        ALTER TABLE users ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}'
          CHECK (capabilities <@ ARRAY['users.manage','projects.manage','connectors.manage','inventory.manage']::text[]);
        ALTER TABLE projects ADD COLUMN grant_mode text NOT NULL DEFAULT 'id' CHECK(grant_mode IN ('id','name'));
        ALTER TABLE memberships ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin'));
        CREATE TABLE container_grants (
          id uuid PRIMARY KEY, user_id uuid NOT NULL, project_slug text NOT NULL,
          capability text NOT NULL CHECK(capability IN ('view','logs','lifecycle','terminal','configuration')),
          kind text NOT NULL CHECK(kind IN ('all','id','name')),
          connector_id uuid REFERENCES connectors ON DELETE CASCADE, target text,
          FOREIGN KEY(user_id,project_slug) REFERENCES memberships ON DELETE CASCADE,
          CHECK ((kind='all' AND connector_id IS NULL AND target IS NULL) OR
                 (kind IN ('id','name') AND connector_id IS NOT NULL AND target IS NOT NULL AND length(target)>0))
        );
        CREATE INDEX container_grants_membership ON container_grants(user_id,project_slug);
        INSERT INTO container_grants(id,user_id,project_slug,capability,kind)
          SELECT gen_random_uuid(),user_id,project_slug,'view','all' FROM memberships;
      `)
      await db.query('INSERT INTO migrations(version) VALUES(3)')
    }
    if (
      !(await db.query('SELECT version FROM migrations WHERE version=4'))
        .rowCount
    ) {
      await db.query(`
        ALTER TABLE users DROP CONSTRAINT users_capabilities_check;
        ALTER TABLE users ADD CONSTRAINT users_capabilities_check
          CHECK (capabilities <@ ARRAY['users.manage','projects.create','projects.manage','connectors.manage','inventory.manage']::text[]);
        UPDATE users SET capabilities = array_append(capabilities, 'projects.create')
          WHERE 'projects.manage' = ANY(capabilities) AND NOT ('projects.create' = ANY(capabilities));
      `)
      await db.query('INSERT INTO migrations(version) VALUES(4)')
    }
  })
}
if (
  process.argv[1]?.endsWith('migrate.ts') ||
  process.argv[1]?.endsWith('migrate.js')
) {
  try {
    await migrate()
    console.log('Migrations complete')
  } finally {
    await pool.end()
  }
}
