import type { PoolClient } from 'pg'

export async function migrateGithubCallbacks(db: PoolClient) {
  if (
    (await db.query('SELECT version FROM migrations WHERE version=31')).rowCount
  )
    return
  await db.query(`
    ALTER TABLE github_app_setups ADD COLUMN opener_origin text;
    ALTER TABLE github_app_setups ADD COLUMN callback_payload text;
    INSERT INTO migrations(version) VALUES(31);
  `)
}
