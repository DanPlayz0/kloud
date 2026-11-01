import pg from 'pg'
import { currentOrganization } from './organization-context.js'

export const rawPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
})
rawPool.on('error', (error) =>
  console.error('PostgreSQL pool error:', error.message),
)

async function connect(): Promise<pg.PoolClient> {
  const organization = currentOrganization()
  const client = await rawPool.connect()
  if (!organization) return client
  let previous: string
  try {
    previous = (await client.query('SHOW search_path')).rows[0].search_path
    // Do not append public: a missing tenant table must fail, never fall back
    // to an existing organization's tables.
    await client.query("SELECT set_config('search_path',$1,false)", [
      `"${organization.schema}"`,
    ])
  } catch (error) {
    client.release(true)
    throw error
  }
  let released = false
  return new Proxy(client, {
    get(target, property) {
      if (property === 'release')
        return (error?: Error | boolean) => {
          if (released) throw new Error('Client already released')
          released = true
          if (error) {
            target.release(error)
            return
          }
          // Keep the connection checked out until its original search path is
          // restored. An aborted transaction destroys it rather than risking a
          // later request inheriting organization state.
          void target
            .query("SELECT set_config('search_path',$1,false)", [previous])
            .then(() => target.release())
            .catch(() => target.release(true))
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function query(...args: unknown[]) {
  const client = await connect()
  try {
    return await Reflect.apply(client.query, client, args)
  } finally {
    client.release()
  }
}

// Existing callers keep pg's typed interface. Every checked-out connection is
// scoped at the database boundary, including permission checks and transactions.
const scopedPool = Object.create(rawPool) as pg.Pool
scopedPool.connect = ((callback?: Parameters<pg.Pool['connect']>[0]) => {
  if (!callback) return connect()
  void connect().then(
    (client) => callback(undefined, client, client.release.bind(client)),
    (error) => callback(error, undefined, () => {}),
  )
}) as pg.Pool['connect']
scopedPool.query = ((...args: unknown[]) => {
  const callback = args.at(-1)
  if (typeof callback !== 'function') return query(...args)
  void query(...args.slice(0, -1)).then(
    (result) => callback(null, result),
    (error) => callback(error),
  )
}) as pg.Pool['query']
export const pool = new Proxy(scopedPool, {
  get(target, property) {
    if (property === 'connect' || property === 'query')
      return Reflect.get(target, property, target)
    const value = Reflect.get(rawPool, property, rawPool)
    return typeof value === 'function' ? value.bind(rawPool) : value
  },
})
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
