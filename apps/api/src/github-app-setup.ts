import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { requireUser, type Env } from './auth.js'
import { transaction } from './db.js'
import { permissionTransaction } from './permissions.js'
import { demandGitCreation, demandGitSharing } from './git-permissions.js'
import {
  validateGitAvailability,
  saveGitAvailability,
} from './git-availability.js'
import {
  browserOrigin,
  digest,
  isAllowedOrigin,
  publicOrigin,
  token,
} from './security.js'
import { seal, unseal } from './platform-secrets.js'
import {
  appJwt,
  accessToken,
  providerRequest,
  type Credentials,
  type GitConnection,
} from './git-provider.js'

const path = '/projects/:project/git-connections/github-app'
const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const github = { provider: 'github_app' as const, origin: 'https://github.com' }
export const githubAppSetup = new Hono<Env>()

function setupRequest<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new HTTPException(400, {
      message: `Invalid GitHub setup request: ${result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')}`,
    })
  return result.data
}
githubAppSetup.use(`${path}/*`, requireUser)

export function appManifest(name: string) {
  return {
    name,
    url: publicOrigin,
    redirect_url: `${publicOrigin}/api/git/github/manifest`,
    setup_url: `${publicOrigin}/api/git/github/setup`,
    // This integration authenticates installations with the App ID and private
    // key. It does not request user OAuth or register an unused OAuth callback.
    public: false,
    request_oauth_on_install: false,
    default_permissions: {
      contents: 'read',
      metadata: 'read',
      repository_hooks: 'write',
    },
  }
}

const callbackSchema = z.discriminatedUnion('phase', [
  z
    .object({
      phase: z.literal('manifest'),
      code: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    })
    .strict(),
  z
    .object({
      phase: z.literal('install'),
      installation_id: z.coerce.number().int().positive().safe(),
      setup_action: z.literal('install'),
    })
    .strict(),
])
// The public cross-site redirect cannot use SameSite=Strict cookies. Its state
// proves only which pending ceremony receives the payload; the authenticated
// original window still performs every permission check and provider exchange.
async function callback(
  c: Context<Env>,
  expectedPhase?: 'manifest' | 'install',
) {
  const state = setupRequest(stateSchema, c.req.query('state'))
  const received = await transaction(async (db) => {
    const setup = (
      await db.query(
        'SELECT opener_origin,phase,callback_payload FROM github_app_setups WHERE state=$1 AND expires>now() FOR UPDATE',
        [digest(state)],
      )
    ).rows[0]
    if (!setup || (expectedPhase && setup.phase !== expectedPhase))
      throw new HTTPException(403, {
        message:
          'GitHub setup expired, was already used, or returned to the wrong callback. Start again.',
      })
    const opener = setup.opener_origin ?? publicOrigin
    if (!isAllowedOrigin(opener))
      throw new HTTPException(400, {
        message: 'The original setup origin is no longer allowed.',
      })
    if (c.req.query('code') && c.req.query('installation_id'))
      throw new HTTPException(400, {
        message: 'GitHub returned conflicting setup callback parameters.',
      })
    const payload = c.req.query('error')
      ? {
          phase: setup.phase,
          error:
            c.req.query('error') === 'access_denied'
              ? 'GitHub setup was denied. Start again when ready.'
              : 'GitHub could not complete app setup. Start again.',
        }
      : setupRequest(
          callbackSchema,
          c.req.query('code')
            ? { phase: 'manifest', code: c.req.query('code') }
            : {
                phase: 'install',
                installation_id: c.req.query('installation_id'),
                setup_action: c.req.query('setup_action'),
              },
        )
    if (payload.phase !== setup.phase)
      throw new HTTPException(400, {
        message: 'GitHub returned to the wrong setup callback.',
      })
    if (
      setup.callback_payload &&
      JSON.stringify(unseal(setup.callback_payload)) !== JSON.stringify(payload)
    )
      throw new HTTPException(409, {
        message: 'This setup callback was already received.',
      })
    await db.query(
      'UPDATE github_app_setups SET callback_payload=$2 WHERE state=$1',
      [digest(state), seal(payload)],
    )
    return { origin: opener, payload }
  })
  const nonce = token()
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cross-Origin-Resource-Policy', 'same-origin')
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
  )
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>GitHub App setup</title><body><p>Return to connection setup to finish connecting GitHub or review the setup error. You may close this window after setup completes.</p><script nonce="${nonce}">
    if (window.opener) window.opener.postMessage(${JSON.stringify({ type: 'kloud-github-app', state, ...received.payload }).replaceAll('<', '\\u003c')}, ${JSON.stringify(received.origin)});
    history.replaceState(null, '', location.pathname);
  </script></body></html>`)
}
githubAppSetup.get('/git/github/manifest', (c) => callback(c, 'manifest'))
githubAppSetup.get('/git/github/setup', (c) => callback(c, 'install'))
// Preserve callbacks of Apps created before the distinct URI migration. The
// query's opener_origin is deliberately ignored: the state owns that authority.
githubAppSetup.get('/git/github/callback', (c) => callback(c))

githubAppSetup.post(`${path}/status`, async (c) => {
  const body = setupRequest(
    z
      .object({ service: z.string().min(1).optional(), state: stateSchema })
      .strict(),
    await c.req.json(),
  )
  const result = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      await demandGitCreation(db, actor, c.req.param('project'), body.service)
      const setup = (
        await db.query(
          'SELECT callback_payload,scope,project_access FROM github_app_setups WHERE state=$1 AND actor=$2 AND project=$3 AND service IS NOT DISTINCT FROM $4::text AND expires>now()',
          [
            digest(body.state),
            actor.id,
            c.req.param('project'),
            body.service ?? null,
          ],
        )
      ).rows[0]
      if (!setup)
        throw new HTTPException(403, {
          message: 'GitHub setup expired or was already used. Start again.',
        })
      demandGitSharing(actor, setup.scope, setup.project_access)
      return {
        callback: setup.callback_payload
          ? unseal(setup.callback_payload)
          : null,
      }
    },
  )
  return c.json(result)
})

githubAppSetup.post(`${path}/start`, async (c) => {
  const body = setupRequest(
    z
      .object({
        service: z.string().min(1).optional(),
        name: z.string().trim().min(1).max(34),
        scope: z.enum(['personal', 'shared']).default('personal'),
        project_access: z.boolean().default(false),
        all_projects: z.boolean().default(false),
        available_projects: z.array(z.string().min(1)).max(200).optional(),
        organization: z
          .string()
          .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)
          .optional(),
      })
      .strict(),
    await c.req.json(),
  )
  const state = token()
  await permissionTransaction(c.get('user'), async (db, actor) => {
    await demandGitCreation(db, actor, c.req.param('project'), body.service)
    demandGitSharing(actor, body.scope, body.project_access)
    const availability = await validateGitAvailability(
      db,
      actor,
      body.scope,
      c.req.param('project'),
      body.project_access,
      body.available_projects,
      body.all_projects,
    )
    // Fail before sending the user to GitHub if credentials cannot be stored.
    seal({})
    await db.query('DELETE FROM github_app_setups WHERE expires<=now()')
    await db.query(
      "INSERT INTO github_app_setups(state,actor,project,service,name,scope,phase,project_access,all_projects,available_projects,opener_origin) VALUES($1,$2,$3,$4,$5,$6,'manifest',$7,$8,$9,$10)",
      [
        digest(state),
        actor.id,
        c.req.param('project'),
        body.service ?? null,
        body.name,
        body.scope,
        body.project_access,
        availability.all_projects,
        availability.available_projects,
        browserOrigin(c),
      ],
    )
  })
  return c.json({
    state,
    action: `https://github.com/${body.organization ? `organizations/${encodeURIComponent(body.organization)}/` : ''}settings/apps/new?state=${state}`,
    manifest: appManifest(body.name),
  })
})

githubAppSetup.post(`${path}/finish`, async (c) => {
  const body = setupRequest(
    z
      .object({
        service: z.string().min(1).optional(),
        state: stateSchema,
        code: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,200}$/)
          .optional(),
        installation_id: z.coerce.number().int().positive().safe().optional(),
        setup_action: z.literal('install').optional(),
      })
      .strict(),
    await c.req.json(),
  )
  const result = await permissionTransaction(
    c.get('user'),
    async (db, actor) => {
      await demandGitCreation(db, actor, c.req.param('project'), body.service)
      const setup = (
        await db.query(
          'SELECT * FROM github_app_setups WHERE state=$1 AND actor=$2 AND project=$3 AND service IS NOT DISTINCT FROM $4::text AND expires>now() FOR UPDATE',
          [
            digest(body.state),
            actor.id,
            c.req.param('project'),
            body.service ?? null,
          ],
        )
      ).rows[0]
      if (!setup)
        throw new HTTPException(403, {
          message: 'GitHub setup expired or was already used. Start again.',
        })
      demandGitSharing(actor, setup.scope, setup.project_access)
      const availability = await validateGitAvailability(
        db,
        actor,
        setup.scope,
        setup.project,
        setup.project_access,
        setup.available_projects ?? undefined,
        setup.all_projects,
      )
      const nextState = token()
      if (setup.phase === 'manifest') {
        if (!body.code || body.installation_id)
          throw new HTTPException(400, {
            message:
              'GitHub did not return an app creation code. Start GitHub setup again.',
          })
        const data = await providerRequest(
          github,
          '',
          `/app-manifests/${body.code}/conversions`,
          { method: 'POST' },
        )
        const result = z
          .object({
            id: z.number().int().positive(),
            slug: z.string().regex(/^[A-Za-z0-9_-]+$/),
            pem: z.string().min(1),
            // JWT installation authentication requires the App ID and PEM.
            // OAuth and app-level webhooks are not used by this flow; service
            // webhooks have their own independently generated signing secrets.
            client_id: z.string().nullish(),
            client_secret: z.string().nullish(),
            webhook_secret: z.string().nullish(),
          })
          .safeParse(data)
        if (!result.success)
          throw new HTTPException(502, {
            message: `GitHub returned an incomplete app configuration (${[...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ')}). Start again with a new app name.`,
          })
        const app = result.data
        const credentials = {
          app_id: String(app.id),
          private_key: app.pem,
          client_id: app.client_id,
          client_secret: app.client_secret,
          webhook_secret: app.webhook_secret,
        }
        appJwt(credentials)
        await db.query(
          "UPDATE github_app_setups SET state=$1,phase='install',slug=$2,encrypted_credentials=$3,callback_payload=NULL,expires=now()+interval '15 minutes' WHERE state=$4",
          [digest(nextState), app.slug, seal(credentials), digest(body.state)],
        )
        return {
          state: nextState,
          install_url: `https://github.com/apps/${app.slug}/installations/new?state=${nextState}`,
        }
      }
      if (!body.installation_id || body.setup_action !== 'install')
        throw new HTTPException(400, {
          message:
            'GitHub did not return a completed installation. Install the app to finish connecting it.',
        })
      const credentials: Credentials = {
        ...unseal(setup.encrypted_credentials),
        installation_id: body.installation_id,
      }
      const installation = await providerRequest(
        github,
        appJwt(credentials),
        `/app/installations/${body.installation_id}`,
      )
      if (
        String(installation.app_id) !== credentials.app_id ||
        installation.id !== body.installation_id ||
        installation.suspended_at
      )
        throw new HTTPException(403, {
          message:
            'This installation does not belong to the GitHub App, or is suspended.',
        })
      const row: GitConnection = {
        ...github,
        id: randomUUID(),
        owner: setup.scope === 'personal' ? actor.id : null,
        encrypted_credentials: seal(credentials),
      }
      await accessToken(row, credentials)
      await db.query(
        'INSERT INTO git_connections(id,project,name,provider,origin,owner,encrypted_credentials,identity,project_access) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          row.id,
          setup.project,
          setup.name,
          row.provider,
          row.origin,
          row.owner,
          row.encrypted_credentials,
          {
            installation_id: installation.id,
            account: installation.account?.login,
            account_id: installation.account?.id,
            app_id: credentials.app_id,
            slug: setup.slug,
          },
          setup.project_access,
        ],
      )
      await saveGitAvailability(db, row.id, availability)
      await db.query('DELETE FROM github_app_setups WHERE state=$1', [
        digest(body.state),
      ])
      return { id: row.id }
    },
  )
  return c.json(result)
})
