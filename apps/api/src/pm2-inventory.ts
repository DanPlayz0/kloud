import { randomUUID } from 'node:crypto'
import { pm2SnapshotSchema } from '@kloud/protocol/pm2'
import { transaction } from './db.js'

export async function acceptPm2Snapshot(
  connector: string,
  raw: unknown,
  isCurrent = () => true,
) {
  const snapshot = pm2SnapshotSchema.parse(raw)
  return transaction(async (db) => {
    const host = (
      await db.query(
        'SELECT discovery FROM connectors WHERE id=$1 AND NOT revoked FOR UPDATE',
        [connector],
      )
    ).rows[0]
    if (!host || !isCurrent()) return false
    await db.query(
      'UPDATE connectors SET host=$2,seen=now(),pm2_available=$3 WHERE id=$1',
      [connector, snapshot.host, snapshot.available],
    )
    if (!snapshot.available) return true
    await db.query('UPDATE connectors SET pm2_seen=now() WHERE id=$1', [
      connector,
    ])
    await db.query(
      "UPDATE pm2_apps SET present=false,workers='[]' WHERE connector_id=$1",
      [connector],
    )
    const groups = new Map<string, typeof snapshot.workers>()
    for (const worker of snapshot.workers) {
      const key = JSON.stringify([worker.namespace, worker.name])
      groups.set(key, [...(groups.get(key) ?? []), worker])
    }
    const apps = [...groups.values()].map((workers) => ({
      id: randomUUID(),
      namespace: workers[0]!.namespace,
      name: workers[0]!.name,
      workers,
    }))
    if (apps.length)
      await db.query(
        `
      INSERT INTO pm2_apps(id,connector_id,namespace,name,workers)
      SELECT (x->>'id')::uuid,$1,x->>'namespace',x->>'name',x->'workers'
      FROM jsonb_array_elements($2::jsonb) x
      WHERE $3::boolean OR EXISTS (SELECT 1 FROM pm2_apps a WHERE a.connector_id=$1
        AND a.namespace=x->>'namespace' AND a.name=x->>'name' AND a.project_slug IS NOT NULL)
      ON CONFLICT(connector_id,namespace,name) DO UPDATE SET workers=EXCLUDED.workers,present=true`,
        [connector, JSON.stringify(apps), host.discovery],
      )
    return true
  })
}

export const pm2InventoryQuery = `SELECT a.id,a.connector_id,a.namespace,a.name,a.project_slug,a.workers,a.present,
  c.name AS connector_name,c.host,c.pm2_seen AS seen,
  (c.revoked OR NOT c.pm2_available OR c.pm2_seen IS NULL OR c.pm2_seen<now()-interval '20 seconds'
    OR NOT ('pm2'=ANY(c.capabilities))) AS stale
  FROM pm2_apps a JOIN connectors c ON c.id=a.connector_id`
