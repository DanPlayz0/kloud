import { z, type OpenAPIHono } from '@hono/zod-openapi'
import { slug } from '@dedi-dash/protocol'

export function registerContracts(registry: OpenAPIHono['openAPIRegistry']) {
  const user = z
    .object({ id: z.string().uuid(), username: z.string(), admin: z.boolean() })
    .openapi('User')
  const project = z.object({ slug, name: z.string() }).openapi('Project')
  const ok = z.object({ ok: z.literal(true) })
  const flexible = z.record(z.string(), z.unknown())
  const credentials = z.object({ username: z.string(), password: z.string() })
  const enrollment = z.object({ enrollmentUrl: z.string().url() })
  const row = z
    .object({
      connector_id: z.string().uuid(),
      connector_name: z.string(),
      host: z.string().nullable(),
      seen: z.string().nullable(),
      stale: z.boolean(),
      container_id: z.string(),
      project: z.string().nullable(),
      application: z.string().nullable(),
      assignment: z.enum(['label', 'manual']).nullable(),
      data: z.object({
        id: z.string(),
        name: z.string(),
        state: z.string(),
        project: z.string().nullable(),
        application: z.string().nullable(),
        cpu: z.number().nullable(),
        memory: z.number().nullable(),
        memoryLimit: z.number().nullable(),
      }),
    })
    .openapi('ContainerRow')
  function route(
    method: 'get' | 'post' | 'put',
    path: string,
    summary: string,
    output: z.ZodType,
    input?: z.ZodType,
    authenticated = true,
    status = 200,
  ) {
    registry.registerPath({
      method,
      path,
      summary,
      tags: [
        path.includes('/admin/')
          ? 'Administration'
          : path.includes('/auth/')
            ? 'Authentication'
            : 'Projects',
      ],
      security: authenticated ? [{ session: [] }] : [],
      request: {
        params: z.object(
          Object.fromEntries(
            [...path.matchAll(/\{([^}]+)\}/g)].map((match) => [
              match[1]!,
              z.string(),
            ]),
          ),
        ),
        ...(input
          ? {
              body: {
                required: true,
                content: { 'application/json': { schema: input } },
              },
            }
          : {}),
      },
      responses: {
        [status]: {
          description: 'Success',
          content: { 'application/json': { schema: output } },
        },
        400: { description: 'Invalid input' },
        401: { description: 'Authentication required or verification failed' },
        403: { description: 'Forbidden' },
        404: { description: 'Resource not found' },
        409: { description: 'Conflict' },
        429: { description: 'Rate limited' },
        503: { description: 'Dependency unavailable' },
      },
    })
  }
  route(
    'post',
    '/auth/password',
    'Verify password and start a five-minute passkey challenge',
    flexible,
    credentials,
    false,
  )
  route(
    'post',
    '/auth/verify',
    'Verify passkey and issue eight-hour session',
    ok,
    flexible,
    false,
  )
  route(
    'post',
    '/auth/enroll/options',
    'Begin invitation-based password and passkey enrollment',
    flexible,
    z.object({ token: z.string(), password: z.string().min(12).max(256) }),
    false,
  )
  route(
    'post',
    '/auth/enroll/verify',
    'Consume invitation and register passkey',
    ok,
    flexible,
    false,
  )
  route(
    'post',
    '/auth/logout',
    'Invalidate current session',
    ok,
    undefined,
    false,
  )
  route('get', '/auth/me', 'Read authenticated user', user)
  route('get', '/projects', 'List accessible projects', z.array(project))
  route(
    'get',
    '/projects/{project}/containers',
    'List latest container inventory and staleness',
    z.array(row),
  )
  route(
    'get',
    '/projects/{project}/applications/{application}',
    'Verify application exists in accessible project',
    z.object({ slug: z.string() }),
  )
  route(
    'get',
    '/admin/projects',
    'List projects (super-admin)',
    z.array(project),
  )
  route(
    'post',
    '/admin/projects',
    'Create project (super-admin)',
    ok,
    project,
    true,
    201,
  )
  route(
    'get',
    '/admin/users',
    'List users and project memberships (super-admin)',
    z.array(
      user.extend({
        disabled: z.boolean(),
        enrolled: z.boolean(),
        projects: z.array(z.string()),
      }),
    ),
  )
  route(
    'post',
    '/admin/users',
    'Invite user (super-admin)',
    enrollment,
    z.object({ username: z.string(), admin: z.boolean().optional() }),
    true,
    201,
  )
  route(
    'put',
    '/admin/users/{id}',
    'Replace memberships and set disabled status (super-admin)',
    ok,
    z.object({ disabled: z.boolean(), projects: z.array(slug) }),
  )
  route(
    'post',
    '/admin/users/{id}/enrollment',
    'Reset credentials and issue invitation (super-admin)',
    enrollment,
  )
  route(
    'get',
    '/admin/connectors',
    'List connector status (super-admin)',
    z.array(flexible),
  )
  route(
    'post',
    '/admin/connectors',
    'Create connector; token shown once (super-admin)',
    z.object({ id: z.string().uuid(), token: z.string() }),
    z.object({ name: z.string() }),
    true,
    201,
  )
  route(
    'put',
    '/admin/connectors/{id}',
    'Set discovery or permanently revoke credential (super-admin)',
    ok,
    z.object({ discovery: z.boolean(), revoked: z.boolean() }),
  )
  route(
    'get',
    '/admin/containers',
    'List assigned and discovery-enabled inventory (super-admin)',
    z.array(row),
  )
  route(
    'put',
    '/admin/containers/{connector}/{container}',
    'Assign/unassign discovered container (super-admin)',
    ok,
    z.object({ project: slug, application: slug }).nullable(),
  )
}
