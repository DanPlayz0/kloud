import type { PoolClient } from 'pg'
export async function migrateConnectorUpdates(db: PoolClient) {
  if (
    (await db.query('SELECT version FROM migrations WHERE version=32')).rowCount
  )
    return
  await db.query(`
    ALTER TABLE connectors ADD COLUMN agent_status jsonb;
    ALTER TABLE connectors ADD COLUMN auto_update boolean;
    INSERT INTO migrations(version) VALUES(32);
  `)
}
