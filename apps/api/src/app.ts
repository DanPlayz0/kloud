import { registryConnections } from './registry-connections.js'
import { forwarding, forwardingWorker } from './forwarding.js'
import { recovery, recoveryWorker } from './recovery.js'
import { gitConnections } from './git-connections.js'
import { githubAppSetup } from './github-app-setup.js'
import { gitAdmin } from './git-admin.js'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { bodyLimit } from 'hono/body-limit'
import { auth, requireUser, type Env } from './auth.js'
import { dashboard } from './dashboard.js'
import { isAllowedOrigin } from './security.js'
import { registerContracts } from './contracts.js'
import { deploymentHooks, deployments } from './deployments.js'
import { platform, platformWorker } from './platform.js'
import { pm2 } from './pm2.js'
import { connectorWorkspace } from './connector-workspace.js'

export const app = new OpenAPIHono<Env>()
app.use('*', (c, next) =>
  bodyLimit({
    maxSize: /^\/projects\/[^/]+\/databases\/imports$/.test(c.req.path)
      ? 64 * 1024 * 1024
      : /\/(?:configuration|variables)$/.test(c.req.path)
        ? 1024 * 1024
        : c.req.path.startsWith('/hooks/github/')
          ? 2 * 1024 * 1024
          : c.req.path.startsWith('/connectors/deployments/')
            ? 350000
            : 65536,
    onError: (c) => c.json({ error: 'Request too large' }, 413),
  })(c, next),
)
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Cache-Control', 'no-store')
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    !isAllowedOrigin(c.req.header('origin')) &&
    !(
      /^\/hooks\/github\/[0-9a-f-]+$/.test(c.req.path) &&
      c.req.method === 'POST'
    ) &&
    !(
      /^\/connectors\/(?:deployments|platform|recovery|forwarding)\/(claim|proxy|sync|[0-9a-f-]+\/(?:result|rollout|reconcile|heartbeat))$/.test(
        c.req.path,
      ) && c.req.method === 'POST'
    )
  )
    return c.json({ error: 'Invalid request origin' }, 403)
  await next()
})
app.onError((error, c) => {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json(
      {
        error: 'Invalid request',
        details:
          error instanceof z.ZodError
            ? error.issues.map((i) => ({ path: i.path, message: i.message }))
            : undefined,
      },
      400,
    )
  if (error instanceof HTTPException)
    return c.json({ error: error.message }, error.status)
  const code = (error as { code?: string }).code
  if (code === '23505') return c.json({ error: 'Already exists' }, 409)
  if (code === '23503')
    return c.json({ error: 'Referenced resource does not exist' }, 400)
  console.error('API error:', error.message)
  return c.json({ error: 'Service unavailable' }, 503)
})
app.route('/auth', auth)

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  summary: 'Check API health',
  responses: {
    200: {
      description: 'The API is healthy',
      content: {
        'application/json': {
          schema: z.object({ status: z.literal('ok') }).openapi('Health'),
        },
      },
    },
  },
})

app.openapi(healthRoute, (c) => c.json({ status: 'ok' as const }, 200))
app.route('/', githubAppSetup)
app.route('/', deploymentHooks)
app.route('/', platformWorker)
app.route('/', forwardingWorker)
app.route('/', recoveryWorker)
app.route('/', deployments)
app.route('/', platform)
app.route('/', forwarding)
app.route('/', recovery)
app.route('/', gitConnections)
app.route('/', gitAdmin)
app.route('/', registryConnections)
app.route('/', pm2)
app.route('/', connectorWorkspace)
app.route('/', dashboard)

app.use('/openapi.json', requireUser)
app.openAPIRegistry.registerComponent('securitySchemes', 'session', {
  type: 'apiKey',
  in: 'cookie',
  name: 'session',
})
registerContracts(app.openAPIRegistry)
app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: { title: 'Kloud API', version: '0.1.0' },
})
