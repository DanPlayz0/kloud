import type { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { unseal } from './platform-secrets.js'
import { pool, transaction } from './db.js'
const stages = [
  'prepared',
  'dependency-restart',
  'dependencies',
  'started',
  'ready',
  'cutover',
  'serving',
  'retired',
  'failed',
  'uncertain',
] as const
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/)
const detailsSchema = z
  .object({
    targets: z.record(
      z.string(),
      z
        .object({
          candidate: name,
          previous: name.nullable(),
          original: name,
          action: z.enum(['redeploy', 'restart']),
          stopGraceSeconds: z.number().int().min(0).max(86400).optional(),
        })
        .strict(),
    ),
    commits: z.record(z.string(), z.string().regex(/^[a-f0-9]{40}$/)),
    hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    images: z.record(z.string(), z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    dependencies: z.array(z.string()),
    directory: z.string().max(500).optional(),
    project: z.string().max(256).optional(),
  })
  .strict()
const bodySchema = z
  .object({
    stage: z.enum(stages),
    candidate: name,
    previous: name.nullable(),
    compose: detailsSchema.optional(),
  })
  .strict()
export async function routesHash(
  db: Pick<typeof pool, 'query'>,
  connector: string,
) {
  const routes = (
    await db.query(
      'SELECT project,service,config FROM service_domains WHERE connector_id=$1 ORDER BY id',
      [connector],
    )
  ).rows
  return createHash('sha256').update(JSON.stringify(routes)).digest('hex')
}
export function registerRolloutRoutes(
  worker: Hono<{ Variables: { connector: string } }>,
) {
  worker.post('/connectors/platform/:id/heartbeat', async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'))
    const active = await pool.query(
      "SELECT 1 FROM service_runs WHERE id=$1 AND connector_id=$2 AND status='running'",
      [id, c.get('connector')],
    )
    if (active.rowCount)
      await pool.query(
        'UPDATE service_rollouts SET updated=now() WHERE run=$1',
        [id],
      )
    return c.json({ ok: !!active.rowCount })
  })
  worker.post('/connectors/platform/:id/reconcile', async (c) => {
    const body = z
      .object({ previous_running: z.boolean(), candidate_running: z.boolean() })
      .strict()
      .parse(await c.req.json())
    const id = z.string().uuid().parse(c.req.param('id'))
    return c.json(
      await transaction(async (db) => {
        const row = (
          await db.query(
            `SELECT x.* FROM service_rollouts x JOIN service_runs r ON r.id=x.run WHERE x.run=$1 AND x.connector_id=$2 AND r.status='running' FOR UPDATE OF x,r`,
            [id, c.get('connector')],
          )
        ).rows[0]
        if (
          !row ||
          (!row.previous && !Object.keys(row.details?.targets ?? {}).length) ||
          !body.previous_running
        )
          throw new HTTPException(409, {
            message:
              'No verified previous release is available; preserve runtimes for manual repair',
          })
        if (Object.keys(row.details?.targets ?? {}).length) {
          for (const target of Object.values(row.details.targets) as any[]) {
            if (!target.previous)
              throw new HTTPException(409, {
                message:
                  'Initial Compose candidate has no previous release to restore',
              })
            await db.query(
              "UPDATE service_domains SET config=jsonb_set(config,'{container}',to_jsonb($1::text)) WHERE project=$2 AND service=$3 AND connector_id=$4 AND config->>'container'=$5",
              [
                target.previous,
                row.project,
                row.service,
                c.get('connector'),
                target.candidate,
              ],
            )
          }
        } else
          await db.query(
            "UPDATE service_domains SET config=jsonb_set(config,'{container}',to_jsonb($1::text)) WHERE project=$2 AND service=$3 AND connector_id=$4",
            [row.previous, row.project, row.service, c.get('connector')],
          )
        const desired = await routesHash(db, c.get('connector'))
        const applied = !!(
          await db.query(
            'SELECT 1 FROM proxy_status WHERE connector_id=$1 AND applied=$2 AND error IS NULL',
            [c.get('connector'), desired],
          )
        ).rowCount
        if (applied) {
          await db.query(
            'UPDATE service_release_state SET serving=$3,paused=false,reason=NULL,updated=now() WHERE project=$1 AND service=$2',
            [row.project, row.service, row.previous],
          )
          if (Object.keys(row.details?.targets ?? {}).length)
            await db.query(
              'UPDATE service_release_state SET compose_state=$3 WHERE project=$1 AND service=$2',
              [row.project, row.service, row.previous_state],
            )
          await db.query(
            "UPDATE service_rollouts SET stage='failed',updated=now() WHERE run=$1",
            [id],
          )
        }
        return { applied }
      }),
    )
  })
  worker.post('/connectors/platform/:id/rollout', async (c) => {
    const body = bodySchema.parse(await c.req.json())
    const id = z.string().uuid().parse(c.req.param('id'))
    const result = await transaction(async (db) => {
      const run = (
        await db.query(
          `SELECT r.status,v.project,v.service,v.encrypted_config FROM service_runs r JOIN service_revisions v ON v.id=r.revision WHERE r.id=$1 AND r.connector_id=$2 FOR UPDATE OF r`,
          [id, c.get('connector')],
        )
      ).rows[0]
      if (!run || run.status !== 'running')
        throw new HTTPException(409, { message: 'Rollout is no longer active' })
      if (body.compose) {
        const selected =
          unseal(run.encrypted_config).deployment?.compose?.services ?? {}
        if (
          Object.keys(body.compose.targets).length > 100 ||
          Object.keys(body.compose.targets).some(
            (key) => !Object.hasOwn(selected, key),
          )
        )
          throw new HTTPException(400, {
            message: 'Compose targets must match configured selected services',
          })
      }
      const expected = `kloud-${run.project}-${run.service}`
      if (
        body.candidate !== expected &&
        body.candidate !== `${expected}-release-${id}`
      )
        throw new HTTPException(400, { message: 'Invalid release identity' })
      const previous = (
        await db.query('SELECT * FROM service_rollouts WHERE run=$1', [id])
      ).rows[0]
      if (!previous && body.stage !== 'prepared')
        throw new HTTPException(409, {
          message: 'Prepare the release before reporting progress',
        })
      if (
        previous &&
        !(
          await db.query(
            'SELECT details=$2::jsonb AS same FROM service_rollouts WHERE run=$1',
            [id, JSON.stringify(body.compose ?? {})],
          )
        ).rows[0]?.same
      )
        throw new HTTPException(409, {
          message: 'Compose release plan cannot change after preparation',
        })
      if (
        previous &&
        (previous.candidate !== body.candidate ||
          previous.previous !== body.previous)
      )
        throw new HTTPException(409, {
          message: 'Release identity cannot change',
        })
      if (previous?.stage === 'retired' && body.stage !== 'retired')
        throw new HTTPException(409)
      const transitions: Record<string, string[]> = {
        prepared: [
          'prepared',
          'dependency-restart',
          'started',
          'failed',
          'uncertain',
        ],
        'dependency-restart': ['dependencies', 'uncertain'],
        dependencies: ['dependencies', 'started', 'failed', 'uncertain'],
        started: ['started', 'ready', 'failed', 'uncertain'],
        ready: ['ready', 'cutover', 'failed', 'uncertain'],
        cutover: ['cutover', 'serving', 'uncertain'],
        serving: ['serving', 'cutover', 'retired', 'uncertain'],
        retired: ['retired'],
        failed: ['failed'],
        uncertain: ['uncertain', 'cutover'],
      }
      if (previous && !transitions[previous.stage]?.includes(body.stage))
        throw new HTTPException(409, {
          message: 'Invalid rollout stage transition',
        })

      if (body.stage === 'prepared') {
        const state = (
          await db.query(
            'SELECT * FROM service_release_state WHERE project=$1 AND service=$2 FOR UPDATE',
            [run.project, run.service],
          )
        ).rows[0]
        if (state && state.connector_id !== c.get('connector'))
          throw new HTTPException(409, {
            message:
              'Moving a serving application between hosts requires a separate migration and cutover',
          })
        if (state?.paused)
          throw new HTTPException(409, {
            message: 'Serving release requires reconciliation',
          })
        await db.query(
          `INSERT INTO service_rollouts(run,project,service,connector_id,candidate,previous,details,previous_state,stage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared') ON CONFLICT(run) DO NOTHING`,
          [
            id,
            run.project,
            run.service,
            c.get('connector'),
            body.candidate,
            body.previous,
            body.compose ?? {},
            state?.compose_state ?? {},
          ],
        )
        await db.query(
          `INSERT INTO service_release_state(project,service,connector_id,serving) VALUES($1,$2,$3,$4) ON CONFLICT(project,service) DO NOTHING`,
          [run.project, run.service, c.get('connector'), body.previous],
        )
      }
      if (body.stage === 'dependency-restart')
        await db.query(
          'UPDATE service_release_state SET paused=true,reason=$3 WHERE project=$1 AND service=$2',
          [
            run.project,
            run.service,
            'Required dependency restart is in progress',
          ],
        )
      if (body.stage === 'dependencies' && body.compose) {
        const current =
          (
            await db.query(
              'SELECT compose_state FROM service_release_state WHERE project=$1 AND service=$2',
              [run.project, run.service],
            )
          ).rows[0]?.compose_state ?? {}
        const appliedHashes = Object.fromEntries(
          body.compose.dependencies.map((key) => [
            key,
            body.compose!.hashes[key],
          ]),
        )
        current.hashes = { ...(current.hashes ?? {}), ...appliedHashes }
        await db.query(
          'UPDATE service_release_state SET compose_state=$3,paused=false,reason=NULL WHERE project=$1 AND service=$2',
          [run.project, run.service, current],
        )
        const prior = previous?.previous_state ?? {}
        prior.hashes = { ...(prior.hashes ?? {}), ...appliedHashes }
        await db.query(
          'UPDATE service_rollouts SET previous_state=$2 WHERE run=$1',
          [id, prior],
        )
      }
      let applied = false
      if (body.stage === 'cutover') {
        if (
          !['ready', 'cutover', 'serving', 'uncertain'].includes(
            previous?.stage,
          )
        )
          throw new HTTPException(409, {
            message: 'Candidate readiness must precede cutover',
          })
        const domains = (
          await db.query(
            'SELECT id,config FROM service_domains WHERE project=$1 AND service=$2 AND connector_id=$3 FOR UPDATE',
            [run.project, run.service, c.get('connector')],
          )
        ).rows
        if (
          body.previous &&
          !domains.length &&
          unseal(run.encrypted_config).deployment?.strategy === 'blue-green'
        )
          throw new HTTPException(409, {
            message:
              'Attach a managed HTTP domain before replacing a blue/green release',
          })
        if (body.compose) {
          for (const target of Object.values(body.compose.targets)) {
            if (
              target.previous &&
              target.action === 'redeploy' &&
              !domains.some((domain) =>
                [target.previous, target.original, target.candidate].includes(
                  domain.config.container,
                ),
              )
            )
              throw new HTTPException(409, {
                message:
                  'Every replaced Compose service needs a managed route; resolve internal discovery before blue/green',
              })
          }
          for (const domain of domains) {
            const target = Object.values(body.compose.targets).find((target) =>
              [target.previous, target.original, target.candidate].includes(
                domain.config.container,
              ),
            )
            if (target)
              await db.query(
                "UPDATE service_domains SET config=jsonb_set(config,'{container}',to_jsonb($1::text)) WHERE id=$2",
                [target.candidate, domain.id],
              )
          }
        } else
          for (const domain of domains)
            await db.query(
              "UPDATE service_domains SET config=jsonb_set(config,'{container}',to_jsonb($1::text)) WHERE id=$2",
              [body.candidate, domain.id],
            )
        const desired = await routesHash(db, c.get('connector'))
        applied =
          !domains.length ||
          !!(
            await db.query(
              'SELECT 1 FROM proxy_status WHERE connector_id=$1 AND applied=$2 AND error IS NULL',
              [c.get('connector'), desired],
            )
          ).rowCount
        await db.query('UPDATE service_rollouts SET desired=$1 WHERE run=$2', [
          desired,
          id,
        ])
        await db.query(
          'UPDATE service_release_state SET paused=true,reason=$3,updated=now() WHERE project=$1 AND service=$2',
          [
            run.project,
            run.service,
            'Managed proxy cutover is being reconciled',
          ],
        )
      }
      if (body.stage === 'serving') {
        if (previous?.stage !== 'cutover' && previous?.stage !== 'serving')
          throw new HTTPException(409)
        const desired = await routesHash(db, c.get('connector'))
        const count = (
          await db.query(
            'SELECT 1 FROM service_domains WHERE project=$1 AND service=$2 AND connector_id=$3',
            [run.project, run.service, c.get('connector')],
          )
        ).rowCount
        if (
          count &&
          !(
            await db.query(
              'SELECT 1 FROM proxy_status WHERE connector_id=$1 AND applied=$2 AND error IS NULL',
              [c.get('connector'), desired],
            )
          ).rowCount
        )
          throw new HTTPException(409, {
            message: 'Managed proxy has not confirmed this release',
          })
        await db.query(
          'UPDATE service_release_state SET serving=$3,paused=false,reason=NULL,updated=now() WHERE project=$1 AND service=$2',
          [run.project, run.service, body.candidate],
        )
        if (body.compose) {
          const current =
            (
              await db.query(
                'SELECT compose_state FROM service_release_state WHERE project=$1 AND service=$2',
                [run.project, run.service],
              )
            ).rows[0]?.compose_state ?? {}
          const targets = {
            ...(current.targets ?? {}),
            ...Object.fromEntries(
              Object.entries(body.compose.targets).map(([key, target]) => [
                key,
                target.candidate,
              ]),
            ),
          }
          await db.query(
            'UPDATE service_release_state SET compose_state=$3 WHERE project=$1 AND service=$2',
            [
              run.project,
              run.service,
              {
                targets,
                commits: {
                  ...(current.commits ?? {}),
                  ...body.compose.commits,
                },
                hashes: body.compose.hashes,
              },
            ],
          )
        }
      }
      if (body.stage === 'uncertain')
        await db.query(
          'UPDATE service_release_state SET paused=true,reason=$3,updated=now() WHERE project=$1 AND service=$2',
          [
            run.project,
            run.service,
            'Serving state is uncertain; preserve both releases and reconcile before dispatch',
          ],
        )
      // A known candidate failure before switch leaves the existing release authoritative.
      if (
        body.stage === 'failed' &&
        previous &&
        ['cutover', 'serving', 'uncertain'].includes(previous.stage)
      )
        throw new HTTPException(409, {
          message: 'A cutover failure requires reconciliation',
        })
      await db.query(
        "UPDATE service_rollouts SET stage=CASE WHEN stage='dependency-restart' AND $1='uncertain' THEN stage ELSE $1 END,updated=now() WHERE run=$2",
        [body.stage, id],
      )
      return { applied }
    })
    return c.json(result)
  })
}
