import type { PoolClient } from 'pg'
export async function migrateRollouts(db: PoolClient) {
  if ((await db.query('SELECT 1 FROM migrations WHERE version=21')).rowCount) {
    if (
      !(await db.query('SELECT 1 FROM migrations WHERE version=25')).rowCount
    ) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS deployment_pauses(deployment uuid PRIMARY KEY REFERENCES deployments ON DELETE CASCADE,reason text NOT NULL,updated timestamptz NOT NULL DEFAULT now());
        ALTER TABLE service_runs ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES users ON DELETE SET NULL;
        ALTER TABLE service_runs ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;
        ALTER TABLE deployment_builds ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES users ON DELETE SET NULL;
        ALTER TABLE deployments ADD COLUMN IF NOT EXISTS configured_by uuid REFERENCES users ON DELETE SET NULL;
        ALTER TABLE service_release_state ADD COLUMN IF NOT EXISTS compose_state jsonb NOT NULL DEFAULT '{}';
        ALTER TABLE service_rollouts ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}';
        ALTER TABLE service_rollouts ADD COLUMN IF NOT EXISTS previous_state jsonb NOT NULL DEFAULT '{}';
        ALTER TABLE service_runs DROP CONSTRAINT service_runs_status_check;
        ALTER TABLE service_runs ADD CONSTRAINT service_runs_status_check CHECK(status IN ('queued','running','succeeded','failed','skipped'));
        ALTER TABLE service_rollouts DROP CONSTRAINT service_rollouts_stage_check;
        ALTER TABLE service_rollouts ADD CONSTRAINT service_rollouts_stage_check CHECK(stage IN ('prepared','dependency-restart','dependencies','started','ready','cutover','serving','retired','failed','uncertain'));
        INSERT INTO migrations(version) VALUES(25);
      `)
    }
    return
  }
  await db.query(`
    CREATE TABLE deployment_pauses(deployment uuid PRIMARY KEY REFERENCES deployments ON DELETE CASCADE,reason text NOT NULL,updated timestamptz NOT NULL DEFAULT now());
    ALTER TABLE service_runs ADD COLUMN manual boolean NOT NULL DEFAULT false;
    ALTER TABLE service_runs ADD COLUMN requested_by uuid REFERENCES users ON DELETE SET NULL;
    ALTER TABLE deployment_builds ADD COLUMN requested_by uuid REFERENCES users ON DELETE SET NULL;
    ALTER TABLE deployments ADD COLUMN configured_by uuid REFERENCES users ON DELETE SET NULL;
    ALTER TABLE service_runs DROP CONSTRAINT service_runs_status_check;
    ALTER TABLE service_runs ADD CONSTRAINT service_runs_status_check CHECK(status IN ('queued','running','succeeded','failed','skipped'));
    CREATE SEQUENCE deployment_receipt_sequence;
    ALTER TABLE service_runs ADD COLUMN receipt_order bigint NOT NULL DEFAULT nextval('deployment_receipt_sequence');
    ALTER TABLE deployment_builds ADD COLUMN receipt_order bigint NOT NULL DEFAULT nextval('deployment_receipt_sequence');
    CREATE INDEX service_runs_receipt ON service_runs(connector_id,receipt_order) WHERE status='queued';
    CREATE INDEX deployment_builds_receipt ON deployment_builds(receipt_order) WHERE status='queued';
    CREATE TABLE service_release_state (
      project text NOT NULL, service text NOT NULL,
      connector_id uuid NOT NULL REFERENCES connectors ON DELETE CASCADE,
      serving text, paused boolean NOT NULL DEFAULT false,
      compose_state jsonb NOT NULL DEFAULT '{}',
      reason text, updated timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(project,service),
      FOREIGN KEY(project,service) REFERENCES services(project_slug,slug) ON DELETE CASCADE
    );
    CREATE TABLE service_rollouts (
      run uuid PRIMARY KEY REFERENCES service_runs ON DELETE CASCADE,
      project text NOT NULL, service text NOT NULL,
      connector_id uuid NOT NULL REFERENCES connectors ON DELETE CASCADE,
      candidate text NOT NULL, previous text,
      stage text NOT NULL CHECK(stage IN ('prepared','dependency-restart','dependencies','started','ready','cutover','serving','retired','failed','uncertain')),
      details jsonb NOT NULL DEFAULT '{}', previous_state jsonb NOT NULL DEFAULT '{}',
      desired text, updated timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(project,service) REFERENCES services(project_slug,slug) ON DELETE CASCADE
    );
    INSERT INTO migrations(version) VALUES(21),(25);
  `)
}
