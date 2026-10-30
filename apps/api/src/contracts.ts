import { z, type OpenAPIHono } from '@hono/zod-openapi'
import { slug } from '@dedi-dash/protocol'
import { serverCapabilities, grantSchema } from './permissions.js'
import {
  memberBody,
  projectInviteBody,
  settingsBody,
} from './project-permissions.js'

export function registerContracts(registry: OpenAPIHono['openAPIRegistry']) {
  const user = z
    .object({
      id: z.string().uuid(),
      username: z.string(),
      admin: z.boolean(),
      capabilities: z.array(z.enum(serverCapabilities)),
    })
    .openapi('User')
  const project = z
    .object({
      slug,
      name: z.string(),
      grant_mode: z.enum(['id', 'name']).optional(),
      role: z.enum(['admin', 'member']).nullable().optional(),
      can_manage_access: z.boolean().optional(),
    })
    .openapi('Project')
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
    method: 'get' | 'post' | 'put' | 'delete',
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
    'get',
    '/auth/setup',
    'Check whether first-account setup is required',
    z.object({ required: z.boolean() }),
    undefined,
    false,
  )
  route(
    'post',
    '/auth/setup/options',
    'Begin first Server Administrator password and passkey setup (empty installation only)',
    flexible,
    credentials,
    false,
  )
  route(
    'post',
    '/auth/setup/verify',
    'Verify passkey and create the first Server Administrator atomically',
    ok,
    flexible,
    false,
  )
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
    'List projects (projects.manage)',
    z.array(project),
  )
  route(
    'post',
    '/admin/projects',
    'Create project (projects.create; creator receives Project Administrator access)',
    ok,
    project,
    true,
    201,
  )
  route(
    'get',
    '/admin/users',
    'List users and project memberships (users.manage)',
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
    'Invite user (users.manage; server privileges require Server Administrator)',
    enrollment,
    z.object({
      username: z.string(),
      admin: z.boolean().optional(),
      capabilities: z.array(z.enum(serverCapabilities)).optional(),
    }),
    true,
    201,
  )
  route(
    'put',
    '/admin/users/{id}',
    'Update account (users.manage; memberships require projects.manage; server privileges require Server Administrator)',
    ok,
    z.object({
      disabled: z.boolean(),
      projects: z.array(slug).optional(),
      admin: z.boolean().optional(),
      capabilities: z.array(z.enum(serverCapabilities)).optional(),
    }),
  )
  route(
    'post',
    '/admin/users/{id}/enrollment',
    'Reset ordinary account credentials (users.manage; privileged accounts require Server Administrator)',
    enrollment,
  )
  route(
    'get',
    '/admin/connectors',
    'List connector status (connectors.manage)',
    z.array(flexible),
  )
  route(
    'post',
    '/admin/connectors',
    'Create connector; token shown once (connectors.manage)',
    z.object({ id: z.string().uuid(), token: z.string() }),
    z.object({ name: z.string() }),
    true,
    201,
  )
  route(
    'put',
    '/admin/connectors/{id}',
    'Set discovery or permanently revoke credential (connectors.manage)',
    ok,
    z.object({ discovery: z.boolean(), revoked: z.boolean() }),
  )
  route(
    'get',
    '/admin/containers',
    'List assigned and discovery-enabled inventory (inventory.manage)',
    z.array(row),
  )
  route(
    'put',
    '/admin/containers/{connector}/{container}',
    'Assign/unassign discovered container (inventory.manage)',
    ok,
    z.object({ project: slug, application: slug }).nullable(),
  )
  route(
    'get',
    '/admin/containers/projects',
    'List project choices for inventory assignment (inventory.manage)',
    z.array(z.object({ slug, name: z.string() })),
  )
  route(
    'put',
    '/admin/projects/{project}',
    'Rename project (projects.manage)',
    ok,
    z.object({ name: z.string().min(1).max(100) }),
  )
  route(
    'delete',
    '/admin/projects/{project}',
    'Delete project and access grants (projects.manage)',
    ok,
  )
  route(
    'get',
    '/projects/{project}/access',
    'Read project access (Project Administrator or projects.manage)',
    z.object({
      grant_mode: z.enum(['id', 'name']),
      members: z.array(
        z.object({
          id: z.string().uuid(),
          username: z.string(),
          disabled: z.boolean(),
          role: z.enum(['admin', 'member']),
          grants: z.array(grantSchema),
        }),
      ),
    }),
  )
  route(
    'put',
    '/projects/{project}/access/settings',
    'Set default grant matching mode (Project Administrator or projects.manage)',
    ok,
    settingsBody,
  )
  route(
    'post',
    '/projects/{project}/access/members',
    'Invite or add project member; enrollment link only for new accounts',
    ok.extend({ enrollmentUrl: z.string().url().optional() }),
    projectInviteBody,
    true,
    201,
  )
  route(
    'put',
    '/projects/{project}/access/members/{id}',
    'Replace project role and grants (Project Administrator or projects.manage)',
    ok,
    memberBody,
  )
  route(
    'delete',
    '/projects/{project}/access/members/{id}',
    'Remove membership and grants (Project Administrator or projects.manage)',
    ok,
  )
}
