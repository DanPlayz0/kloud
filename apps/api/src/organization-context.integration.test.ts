import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import {
  currentOrganization,
  runWithOrganization,
} from './organization-context.js'

test(
  'organization database contexts isolate concurrent queries and transactions and restore pooled connections',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
    const { pool, rawPool, transaction } = await import('./db.js')
    const suffix = randomUUID().replaceAll('-', '')
    const first = { slug: 'first', schema: `org_test_a_${suffix}` }
    const second = { slug: 'second', schema: `org_test_b_${suffix}` }
    const empty = { slug: 'empty', schema: `org_test_c_${suffix}` }
    const original = (await rawPool.query('SHOW search_path')).rows[0]
      .search_path
    try {
      for (const organization of [first, second, empty])
        await rawPool.query(`CREATE SCHEMA "${organization.schema}"`)
      for (const organization of [first, second])
        await runWithOrganization(organization, async () => {
          await pool.query(
            'CREATE TABLE context_probe (id integer PRIMARY KEY, value text NOT NULL)',
          )
          await pool.query('INSERT INTO context_probe VALUES (1,$1)', [
            organization.slug,
          ])
        })
      await Promise.all(
        Array.from({ length: 40 }, (_, index) => {
          const organization = index % 2 ? first : second
          return runWithOrganization(organization, async () => {
            assert.equal(currentOrganization()?.slug, organization.slug)
            const row = (
              await pool.query('SELECT value FROM context_probe WHERE id=1')
            ).rows[0]
            assert.equal(row.value, organization.slug)
            await transaction(async (db) => {
              assert.equal(
                (await db.query('SELECT current_schema() AS schema')).rows[0]
                  .schema,
                organization.schema,
              )
              assert.equal(
                (await db.query('SELECT value FROM context_probe WHERE id=1'))
                  .rows[0].value,
                organization.slug,
              )
            })
          })
        }),
      )
      await runWithOrganization(empty, async () => {
        assert.deepEqual(
          (await pool.query('SELECT current_schemas(false)::text[] AS schemas'))
            .rows[0].schemas,
          [empty.schema],
        )
        await assert.rejects(pool.query('SELECT * FROM context_probe'), {
          code: '42P01',
        })
      })
      assert.equal(currentOrganization(), undefined)
      const clients = await Promise.all(
        Array.from({ length: 10 }, () => rawPool.connect()),
      )
      try {
        for (const client of clients)
          assert.equal(
            (await client.query('SHOW search_path')).rows[0].search_path,
            original,
          )
      } finally {
        for (const client of clients) client.release()
      }
      assert.throws(
        () =>
          runWithOrganization(
            { slug: 'invalid', schema: 'public,other' },
            () => {},
          ),
        /Invalid organization schema/,
      )
    } finally {
      for (const organization of [first, second, empty])
        await rawPool.query(
          `DROP SCHEMA IF EXISTS "${organization.schema}" CASCADE`,
        )
      await pool.end()
    }
  },
)
