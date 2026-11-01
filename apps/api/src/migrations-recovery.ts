import type { PoolClient } from 'pg'

export async function migrateRecovery(db: PoolClient) {
  if ((await db.query('SELECT 1 FROM migrations WHERE version=22')).rowCount)
    return
  await db.query(`
    CREATE TABLE database_resources (
      id uuid PRIMARY KEY, project text NOT NULL REFERENCES projects ON DELETE RESTRICT,
      slug text NOT NULL CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'), name text NOT NULL,
      connector_id uuid NOT NULL REFERENCES connectors ON DELETE RESTRICT,
      version text NOT NULL CHECK(version IN ('17.6')), encrypted_credentials text NOT NULL,
      state text NOT NULL DEFAULT 'pending', created timestamptz NOT NULL DEFAULT now(),
      UNIQUE(project,slug)
    );
    CREATE TABLE database_grants (
      user_id uuid NOT NULL, project text NOT NULL,
      resource uuid REFERENCES database_resources ON DELETE CASCADE,
      capability text NOT NULL CHECK(capability IN ('read','manage','backup','restore','destinations','reveal')),
      FOREIGN KEY(user_id,project) REFERENCES memberships ON DELETE CASCADE,
      UNIQUE NULLS NOT DISTINCT(user_id,project,resource,capability)
    );
    CREATE TABLE backup_destinations (
      id uuid PRIMARY KEY, project text NOT NULL REFERENCES projects ON DELETE RESTRICT,
      connector_id uuid NOT NULL REFERENCES connectors ON DELETE RESTRICT,
      name text NOT NULL, kind text NOT NULL CHECK(kind IN ('disk','s3')),
      encrypted_config text NOT NULL, created timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE backup_policies (
      id uuid PRIMARY KEY, resource uuid NOT NULL REFERENCES database_resources ON DELETE RESTRICT,
      name text NOT NULL, config jsonb NOT NULL, enabled boolean NOT NULL DEFAULT false,
      next_run timestamptz, created timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE database_jobs (
      id uuid PRIMARY KEY, resource uuid NOT NULL REFERENCES database_resources ON DELETE RESTRICT,
      connector_id uuid NOT NULL REFERENCES connectors ON DELETE RESTRICT,
      actor uuid REFERENCES users ON DELETE SET NULL,
      kind text NOT NULL CHECK(kind IN ('create','backup','restore','import','start','stop','restart','logs','test-destination','reconcile')),
      request_key uuid NOT NULL UNIQUE, config jsonb NOT NULL DEFAULT '{}',
      policy uuid REFERENCES backup_policies ON DELETE RESTRICT,
      state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','partial','failed','unknown','cancelled')),
      sequence bigint GENERATED ALWAYS AS IDENTITY, started timestamptz, finished timestamptz,
      log text NOT NULL DEFAULT '', result jsonb, created timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX database_jobs_claim ON database_jobs(connector_id,state,sequence);
    CREATE TABLE database_archives (
      id uuid PRIMARY KEY, job uuid NOT NULL REFERENCES database_jobs ON DELETE RESTRICT,
      resource uuid NOT NULL REFERENCES database_resources ON DELETE RESTRICT,
      policy uuid REFERENCES backup_policies ON DELETE RESTRICT,
      destination uuid REFERENCES backup_destinations ON DELETE RESTRICT,
      state text NOT NULL CHECK(state IN ('complete','failed','pruned')), metadata jsonb NOT NULL,
      created timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE database_imports (
      job uuid PRIMARY KEY REFERENCES database_jobs ON DELETE CASCADE,
      content bytea NOT NULL, checksum text NOT NULL,
      CHECK(octet_length(content)<=67108864)
    );
    INSERT INTO migrations(version) VALUES(22);
  `)
}
