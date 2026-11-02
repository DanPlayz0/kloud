export interface StorageEngine {
  name: string
  kind: 'database' | 'cache'
}

const engines: Record<string, StorageEngine> = {
  postgres: { name: 'PostgreSQL', kind: 'database' },
  postgresql: { name: 'PostgreSQL', kind: 'database' },
  'postgresql-repmgr': { name: 'PostgreSQL', kind: 'database' },
  'pgvector/pgvector': { name: 'PostgreSQL', kind: 'database' },
  'timescale/timescaledb': { name: 'TimescaleDB', kind: 'database' },
  'timescale/timescaledb-ha': { name: 'TimescaleDB', kind: 'database' },
  mysql: { name: 'MySQL', kind: 'database' },
  mariadb: { name: 'MariaDB', kind: 'database' },
  mongo: { name: 'MongoDB', kind: 'database' },
  mongodb: { name: 'MongoDB', kind: 'database' },
  'percona/percona-server': { name: 'MySQL', kind: 'database' },
  'cockroachdb/cockroach': { name: 'CockroachDB', kind: 'database' },
  'clickhouse/clickhouse-server': { name: 'ClickHouse', kind: 'database' },
  redis: { name: 'Redis', kind: 'cache' },
  'redis/redis-stack': { name: 'Redis', kind: 'cache' },
  'redis/redis-stack-server': { name: 'Redis', kind: 'cache' },
  'valkey/valkey': { name: 'Valkey', kind: 'cache' },
  valkey: { name: 'Valkey', kind: 'cache' },
  'eqalpha/keydb': { name: 'KeyDB', kind: 'cache' },
  keydb: { name: 'KeyDB', kind: 'cache' },
  memcached: { name: 'Memcached', kind: 'cache' },
}

/** Match image repositories, never container names or loose substrings. */
export function storageEngine(image?: string): StorageEngine | null {
  if (!image) return null
  const repository = image
    .toLowerCase()
    .split('@')[0]!
    .replace(/:[^/]*$/, '')
  const parts = repository.split('/')
  const leaf = parts.at(-1)!
  const qualified = parts.slice(-2).join('/')
  return (
    (Object.hasOwn(engines, qualified) ? engines[qualified] : null) ??
    (Object.hasOwn(engines, leaf) ? engines[leaf] : null) ??
    null
  )
}
