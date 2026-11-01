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
    if (
      !(await db.query('SELECT version FROM migrations WHERE version=5'))
        .rowCount
    ) {
      await db.query(`
        CREATE TABLE deployments (
          id uuid PRIMARY KEY, project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
          application text NOT NULL, connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
          config jsonb NOT NULL, webhook_secret text NOT NULL,
          UNIQUE(project, application)
        );
        CREATE UNIQUE INDEX deployment_container ON deployments(connector_id, (config->>'container_name'));
        CREATE TABLE deployment_builds (
          id uuid PRIMARY KEY, deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
          delivery text NOT NULL, commit text NOT NULL, config jsonb NOT NULL,
          status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')),
          created timestamptz NOT NULL DEFAULT now(), started timestamptz, finished timestamptz,
          log text NOT NULL DEFAULT '', UNIQUE(deployment_id, delivery)
        );
        CREATE INDEX deployment_builds_queue ON deployment_builds(status, created);
      `)
      await db.query('INSERT INTO migrations(version) VALUES(5)')
    }
    if (
      !(await db.query('SELECT version FROM migrations WHERE version=6'))
        .rowCount
    ) {
      await db.query(`
        CREATE TABLE services (
          project_slug text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
          slug text NOT NULL CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
          name text NOT NULL, description text NOT NULL DEFAULT '',
          type text NOT NULL CHECK(type IN ('application','compose')),
          created timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_slug,slug)
        );
        CREATE TABLE service_grants (
          user_id uuid NOT NULL, project_slug text NOT NULL,
          capability text NOT NULL CHECK(capability IN ('read','create','update','delete','deploy')),
          service text, FOREIGN KEY(user_id,project_slug) REFERENCES memberships ON DELETE CASCADE,
          CHECK(capability != 'create' OR service IS NULL),
          UNIQUE NULLS NOT DISTINCT(user_id,project_slug,capability,service)
        );
        INSERT INTO services(project_slug,slug,name,type)
          SELECT DISTINCT p.slug,i.data->>'application',i.data->>'application','application'
          FROM inventory i JOIN projects p ON p.slug=i.data->>'project'
          WHERE i.data->>'application' ~ '^[a-z0-9]+(-[a-z0-9]+)*$' ON CONFLICT DO NOTHING;
        INSERT INTO services(project_slug,slug,name,type)
          SELECT DISTINCT project_slug,application,application,'application' FROM assignments ON CONFLICT DO NOTHING;
        INSERT INTO services(project_slug,slug,name,type)
          SELECT project,application,application,CASE WHEN config->>'kind'='compose' THEN 'compose' ELSE 'application' END FROM deployments
          ON CONFLICT(project_slug,slug) DO UPDATE SET type=EXCLUDED.type;
      `)
      await db.query('INSERT INTO migrations(version) VALUES(6)')
    }
    if (
      !(await db.query('SELECT version FROM migrations WHERE version=7'))
        .rowCount
    ) {
      await db.query(`
        ALTER TABLE users DROP CONSTRAINT users_capabilities_check;
        ALTER TABLE users ADD CONSTRAINT users_capabilities_check CHECK
          (capabilities <@ ARRAY['dns.manage','users.manage','projects.create','projects.manage','connectors.manage','inventory.manage']::text[]);
        CREATE TABLE dns_providers (
          id uuid PRIMARY KEY, name text NOT NULL, type text NOT NULL DEFAULT 'cloudflare' CHECK(type='cloudflare'),
          owner_project text REFERENCES projects(slug) ON DELETE CASCADE,
          encrypted_token text NOT NULL, enabled boolean NOT NULL DEFAULT true
        );
        CREATE TABLE dns_zones (
          id uuid PRIMARY KEY, provider_id uuid NOT NULL REFERENCES dns_providers ON DELETE CASCADE,
          external_id text NOT NULL, name text NOT NULL, UNIQUE(provider_id,external_id)
        );
        CREATE TABLE dns_delegations (
          zone_id uuid NOT NULL REFERENCES dns_zones ON DELETE CASCADE,
          project_slug text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
          rules jsonb NOT NULL CHECK(jsonb_typeof(rules)='array'), PRIMARY KEY(zone_id,project_slug)
        );
        CREATE TABLE dns_member_grants (
          user_id uuid NOT NULL, project_slug text NOT NULL, zone_id uuid NOT NULL, rule jsonb NOT NULL,
          FOREIGN KEY(user_id,project_slug) REFERENCES memberships ON DELETE CASCADE,
          FOREIGN KEY(zone_id,project_slug) REFERENCES dns_delegations ON DELETE CASCADE
        );
        CREATE INDEX dns_member_grants_member ON dns_member_grants(user_id,project_slug);
      `)
      await db.query('INSERT INTO migrations(version) VALUES(7)')
    }
    if (
      !(await db.query('SELECT version FROM migrations WHERE version=8'))
        .rowCount
    ) {
      await db.query(`
        ALTER TABLE connectors ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}';
        CREATE TABLE service_revisions (
          id uuid PRIMARY KEY, project text NOT NULL, service text NOT NULL,
          encrypted_config text NOT NULL, source_label text NOT NULL, connector_id uuid NOT NULL REFERENCES connectors ON DELETE CASCADE, created timestamptz NOT NULL DEFAULT now(),
          FOREIGN KEY(project,service) REFERENCES services(project_slug,slug) ON DELETE CASCADE
        );
        CREATE TABLE service_runs (
          id uuid PRIMARY KEY, revision uuid NOT NULL REFERENCES service_revisions ON DELETE CASCADE,
          connector_id uuid NOT NULL REFERENCES connectors ON DELETE CASCADE,
          status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')),
          created timestamptz NOT NULL DEFAULT now(), started timestamptz, finished timestamptz,
          log text NOT NULL DEFAULT '', artifacts jsonb, commit text, request_key uuid UNIQUE NOT NULL
        );
        CREATE INDEX service_runs_queue ON service_runs(connector_id,status,created);
        ALTER TABLE deployments ADD COLUMN service_revision uuid REFERENCES service_revisions ON DELETE SET NULL;
        CREATE TABLE service_domains (
          id uuid PRIMARY KEY, project text NOT NULL, service text NOT NULL,
          connector_id uuid NOT NULL REFERENCES connectors ON DELETE CASCADE,
          config jsonb NOT NULL,
          FOREIGN KEY(project,service) REFERENCES services(project_slug,slug) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX service_domains_route ON service_domains((config->>'hostname'),(config->>'path'));
        CREATE TABLE proxy_status (
          connector_id uuid PRIMARY KEY REFERENCES connectors ON DELETE CASCADE,
          desired text, applied text, error text, updated timestamptz NOT NULL DEFAULT now()
        );
      `)
      await db.query('INSERT INTO migrations(version) VALUES(8)')
    }
    if (
      !(await db.query('SELECT version FROM migrations WHERE version=9'))
        .rowCount
    ) {
      await db.query(`
        ALTER TABLE connectors ADD COLUMN docker_seen timestamptz;
        UPDATE connectors SET docker_seen=seen;
        ALTER TABLE connectors ADD COLUMN pm2_seen timestamptz;
        ALTER TABLE connectors ADD COLUMN pm2_available boolean NOT NULL DEFAULT false;
        CREATE TABLE pm2_apps (
          id uuid PRIMARY KEY, connector_id uuid NOT NULL REFERENCES connectors ON DELETE CASCADE,
          namespace text NOT NULL, name text NOT NULL,
          project_slug text REFERENCES projects ON DELETE SET NULL,
          workers jsonb NOT NULL DEFAULT '[]', present boolean NOT NULL DEFAULT true,
          UNIQUE(connector_id,namespace,name)
        );
        CREATE INDEX pm2_apps_project ON pm2_apps(project_slug);
        CREATE TABLE pm2_grants (
          user_id uuid NOT NULL, project_slug text NOT NULL,
          capability text NOT NULL CHECK(capability IN ('view','logs','manage','delete')),
          app uuid REFERENCES pm2_apps ON DELETE CASCADE,
          FOREIGN KEY(user_id,project_slug) REFERENCES memberships ON DELETE CASCADE,
          UNIQUE NULLS NOT DISTINCT(user_id,project_slug,capability,app)
        );
        INSERT INTO migrations(version) VALUES(9);
      `)
    }
    if (
      !(await db.query('SELECT version FROM migrations WHERE version=10'))
        .rowCount
    ) {
      await db.query(`
        ALTER TABLE users DROP CONSTRAINT users_capabilities_check;
        ALTER TABLE users ADD CONSTRAINT users_capabilities_check CHECK
          (capabilities <@ ARRAY['dns.manage','users.manage','projects.create','projects.manage','connectors.manage','connectors.operate','inventory.manage']::text[]);
        INSERT INTO migrations(version) VALUES(10);
      `)
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
