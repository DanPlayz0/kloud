import type { PoolClient } from 'pg'

export async function migrateGit(db: PoolClient) {
  if (
    !(await db.query('SELECT version FROM migrations WHERE version=28'))
      .rowCount
  ) {
    await db.query(`
      CREATE TABLE github_app_setups (
        state text PRIMARY KEY, actor uuid NOT NULL REFERENCES users ON DELETE CASCADE,
        project text NOT NULL, service text NOT NULL, name text NOT NULL,
        scope text NOT NULL CHECK(scope IN ('personal','shared')),
        phase text NOT NULL CHECK(phase IN ('manifest','install')),
        encrypted_credentials text, slug text,
        expires timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
        FOREIGN KEY(project,service) REFERENCES services(project_slug,slug) ON DELETE CASCADE
      );
      INSERT INTO migrations(version) VALUES(28);
    `)
  }
  if (
    !(await db.query('SELECT version FROM migrations WHERE version=20'))
      .rowCount
  ) {
    await db.query(`
    CREATE TABLE git_connections (
      id uuid PRIMARY KEY, project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
      name text NOT NULL, provider text NOT NULL CHECK(provider IN ('github','github_app','forgejo','gitea')),
      origin text NOT NULL, owner uuid REFERENCES users ON DELETE CASCADE,
      encrypted_credentials text NOT NULL, identity jsonb NOT NULL DEFAULT '{}',
      revoked boolean NOT NULL DEFAULT false, created timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE git_repository_bindings (
      connection uuid NOT NULL REFERENCES git_connections ON DELETE CASCADE,
      project text NOT NULL, service text NOT NULL, repository_id text NOT NULL, repository text NOT NULL,
      FOREIGN KEY(project,service) REFERENCES services(project_slug,slug) ON DELETE CASCADE,
      PRIMARY KEY(connection,project,service,repository_id)
    );
    CREATE INDEX git_repository_bindings_service ON git_repository_bindings(project,service);
    ALTER TABLE deployments ADD COLUMN webhook_mode text NOT NULL DEFAULT 'unconfigured';
    ALTER TABLE deployments ADD COLUMN webhook_error text;
    INSERT INTO migrations(version) VALUES(20);
  `)
  }
  if (
    !(await db.query('SELECT version FROM migrations WHERE version=24'))
      .rowCount
  ) {
    await db.query(`
    CREATE TABLE registry_connections (
      id uuid PRIMARY KEY, project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
      name text NOT NULL, server text NOT NULL, owner uuid REFERENCES users ON DELETE CASCADE,
      encrypted_credentials text NOT NULL, revoked boolean NOT NULL DEFAULT false, created timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE registry_bindings (
      connection uuid NOT NULL REFERENCES registry_connections ON DELETE CASCADE, project text NOT NULL, service text NOT NULL,
      FOREIGN KEY(project,service) REFERENCES services(project_slug,slug) ON DELETE CASCADE, PRIMARY KEY(connection,project,service)
    );
    ALTER TABLE service_runs ADD COLUMN encrypted_dispatch_secrets text;
    ALTER TABLE deployment_builds ADD COLUMN encrypted_dispatch_secrets text;
    INSERT INTO migrations(version) VALUES(24);
    `)
  }
  if (
    !(await db.query('SELECT version FROM migrations WHERE version=26'))
      .rowCount
  ) {
    await db.query(`
      CREATE TABLE legacy_source_grants (
        project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE, service text NOT NULL,
        repository text NOT NULL, connector_id uuid NOT NULL REFERENCES connectors ON DELETE CASCADE,
        PRIMARY KEY(project,service,repository,connector_id)
      );
      INSERT INTO legacy_source_grants(project,service,repository,connector_id)
        SELECT d.project,d.application,d.config->>'repository',d.connector_id FROM deployments d
        WHERE d.config->>'connection_id' IS NULL ON CONFLICT DO NOTHING;
      INSERT INTO migrations(version) VALUES(26);
    `)
  }
}
