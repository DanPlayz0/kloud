import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { createServer } from 'node:net'

// Opt-in: requires built kloud-api/connector images and Docker Desktop's
// host.docker.internal routing. All containers and the database schema are isolated.
test(
  'packaged connector sends live Docker metrics, reconnects and honors revocation',
  {
    skip: process.env.RUN_LIVE_DOCKER !== '1' || !process.env.TEST_DATABASE_URL,
    timeout: 120000,
  },
  async () => {
    const docker = (...args: string[]) =>
      execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim()
    const suffix = randomUUID().slice(0, 8),
      schema = `live_${suffix.replaceAll('-', '')}`
    const apiName = `kloud-verify-api-${suffix}`,
      websiteName = `kloud-verify-website-${suffix}`,
      connectorName = `kloud-verify-connector-${suffix}`,
      fixtureName = `kloud-verify-fixture-${suffix}`
    const names: string[] = []
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    await database.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    const { pool } = await import('./db.js'),
      { migrate } = await import('./migrate.js')
    const secret = randomBytes(32).toString('base64url'),
      connector = randomUUID()
    const waitUntil = async (check: () => Promise<boolean>) => {
      for (let count = 0; count < 40; count++) {
        if (await check()) return
        await delay(500)
      }
      throw new Error('Live Docker verification timed out')
    }
    try {
      await migrate()
      await pool.query(
        `INSERT INTO projects(slug,name) VALUES('live','Live verification')`,
      )
      await pool.query(
        `INSERT INTO connectors(id,name,token) VALUES($1,'Live connector',$2)`,
        [connector, createHash('sha256').update(secret).digest('hex')],
      )
      const remoteDB = new URL(url)
      remoteDB.hostname = 'host.docker.internal'
      const reservation = createServer()
      await new Promise<void>((resolve) =>
        reservation.listen(0, '127.0.0.1', resolve),
      )
      const port = String(
        (reservation.address() as import('node:net').AddressInfo).port,
      )
      await new Promise<void>((resolve) => reservation.close(() => resolve()))
      docker(
        'run',
        '--name',
        apiName,
        '--label',
        'kloud.internal=true',
        '-e',
        `DATABASE_URL=${remoteDB.href}`,
        '-e',
        'PUBLIC_ORIGIN=http://localhost:8080',
        '-e',
        'WEBAUTHN_RP_ID=localhost',
        '-p',
        `127.0.0.1:${port}:3000`,
        '-d',
        'kloud-api',
      )
      names.push(apiName)
      await waitUntil(async () => {
        try {
          return (await fetch(`http://localhost:${port}/health`)).ok
        } catch {
          return false
        }
      })
      docker(
        'run',
        '--name',
        websiteName,
        '--label',
        'kloud.internal=true',
        '-e',
        `API_UPSTREAM=host.docker.internal:${port}`,
        '-p',
        '127.0.0.1::8080',
        '-d',
        'kloud-website',
      )
      names.push(websiteName)
      const websitePort = docker('port', websiteName, '8080/tcp')
        .split(':')
        .at(-1)!
      await waitUntil(async () => {
        try {
          return (await fetch(`http://localhost:${websitePort}/api/health`)).ok
        } catch {
          return false
        }
      })
      assert.equal(
        (
          await fetch(
            `http://localhost:${websitePort}/projects/live/compute/containers`,
          )
        ).status,
        200,
      )
      assert.equal(
        (await fetch(`http://localhost:${websitePort}/api/openapi.json`))
          .status,
        401,
      )
      docker(
        'run',
        '--name',
        fixtureName,
        '--label',
        'kloud.project=live',
        '--label',
        'kloud.application=imgen',
        '-d',
        'postgres:17-alpine',
        'sleep',
        '120',
      )
      names.push(fixtureName)
      docker(
        'run',
        '--name',
        connectorName,
        '--label',
        'kloud.internal=true',
        '--group-add',
        '0',
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock:ro',
        '-e',
        `API_URL=http://host.docker.internal:${websitePort}/api/`,
        '-e',
        `CONNECTOR_TOKEN=${secret}`,
        '-e',
        'CONNECTOR_HOST=live-docker',
        '-d',
        'kloud-connector',
      )
      names.push(connectorName)
      await waitUntil(async () =>
        Boolean(
          (
            await pool.query(
              `SELECT 1 FROM inventory WHERE connector_id=$1 AND data->>'name'=$2`,
              [connector, fixtureName],
            )
          ).rowCount,
        ),
      )
      const inventory = (
        await pool.query('SELECT data FROM inventory WHERE connector_id=$1', [
          connector,
        ])
      ).rows
      assert.equal(inventory.length, 1)
      assert.equal(inventory[0].data.state, 'running')
      assert.equal(typeof inventory[0].data.memory, 'number')
      await waitUntil(async () => {
        const sample = (
          await pool.query('SELECT data FROM inventory WHERE connector_id=$1', [
            connector,
          ])
        ).rows[0]?.data
        return typeof sample?.cpu === 'number' && Number.isFinite(sample.cpu)
      })
      assert.equal(JSON.stringify(inventory).includes('DATABASE_URL'), false)
      const beforeRestart = new Date()
      docker('restart', apiName)
      await waitUntil(async () =>
        Boolean(
          (
            await pool.query(
              'SELECT 1 FROM connectors WHERE id=$1 AND seen>$2',
              [connector, beforeRestart],
            )
          ).rowCount,
        ),
      )
      assert.equal(
        (await pool.query('SELECT count(*) FROM inventory')).rows[0].count,
        '1',
      )
      await pool.query('UPDATE connectors SET revoked=true WHERE id=$1', [
        connector,
      ])
      const seen = (
        await pool.query('SELECT seen FROM connectors WHERE id=$1', [connector])
      ).rows[0].seen
      await delay(11000)
      assert.equal(
        (
          await pool.query('SELECT seen FROM connectors WHERE id=$1', [
            connector,
          ])
        ).rows[0].seen.toISOString(),
        seen.toISOString(),
      )
    } catch (error) {
      for (const name of names.filter((name) => name !== fixtureName)) {
        try {
          console.error(`${name}: ${docker('logs', name)}`)
        } catch {}
      }
      throw error
    } finally {
      for (const name of names.reverse()) {
        try {
          docker('rm', '-f', '-v', name)
        } catch {
          /* Preserve the primary test failure. */
        }
      }
      await pool.end()
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      await database.end()
    }
  },
)
