import { z, type OpenAPIHono } from '@hono/zod-openapi'
import {
  slug,
  deploymentSchema,
  deploymentJobSchema,
} from '@dedi-dash/protocol'
import { serverCapabilities, grantSchema } from './permissions.js'
import { serviceGrantsSchema } from './service-permissions.js'
import { dnsGrantsSchema, dnsRecordSchema } from '@dedi-dash/protocol/dns'
import {
  pm2OperationSchema,
  pm2ResultSchema,
  pm2GrantsSchema,
  pm2WorkerSchema,
} from '@dedi-dash/protocol/pm2'
import { pm2AssignmentSchema } from './pm2.js'
import { dnsProviderBody, dnsProviderUpdate, dnsDelegationBody } from './dns.js'
import { serviceBody, serviceUpdateBody } from './services.js'
import {
  platformConfigSchema,
  runtimeRequestSchema,
  domainSchema,
} from '@dedi-dash/protocol/platform'
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
  const pm2Row = z.object({
    id: z.string().uuid(),
    connector_id: z.string().uuid(),
    connector_name: z.string(),
    host: z.string().nullable(),
    namespace: z.string(),
    name: z.string(),
    project_slug: z.string().nullable(),
    present: z.boolean(),
    stale: z.boolean(),
    seen: z.string().nullable(),
    workers: z.array(pm2WorkerSchema),
  })
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
                required: !input.isOptional(),
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
    '/admin/pm2',
    'Discover PM2 applications (inventory.manage)',
    z.array(pm2Row),
  )
  route(
    'put',
    '/admin/pm2/{app}',
    'Assign or unassign a PM2 application (inventory.manage)',
    ok,
    pm2AssignmentSchema,
  )
  route(
    'get',
    '/projects/{project}/pm2',
    'List assigned PM2 applications with View grants',
    z.array(pm2Row),
  )
  route(
    'get',
    '/projects/{project}/pm2/{app}/permissions',
    'Read effective PM2 permissions',
    z.object({
      available: z.boolean(),
      view: z.boolean(),
      logs: z.boolean(),
      manage: z.boolean(),
      delete: z.boolean(),
    }),
  )
  route(
    'post',
    '/projects/{project}/pm2/{app}/operation',
    'Operate all current app workers; Manage or Delete grant required',
    pm2ResultSchema,
    pm2OperationSchema,
  )
  registry.registerPath({
    method: 'get',
    path: '/projects/{project}/pm2/{app}/logs',
    summary: 'Recent PM2 output snapshots over SSE (Logs grant required)',
    tags: ['Projects'],
    security: [{ session: [] }],
    request: {
      params: z.object({ project: z.string(), app: z.string().uuid() }),
      query: z.object({
        stream: z.enum(['stdout', 'stderr']).optional(),
        worker: z.string().regex(/^\d+$/).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Bounded log snapshots; unavailable event ends access',
        content: { 'text/event-stream': { schema: z.string() } },
      },
      403: { description: 'PM2 Logs grant required' },
      409: { description: 'PM2 inventory stale or unavailable' },
    },
  })
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
          service_grants: serviceGrantsSchema,
          pm2_grants: pm2GrantsSchema,
          dns_grants: dnsGrantsSchema,
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
  const servicePath = '/projects/{project}/services'
  const serviceRow = serviceBody.extend({
    project_slug: slug,
    created: z.string(),
    can_update: z.boolean(),
    can_delete: z.boolean(),
    can_deploy: z.boolean(),
    repository: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    deployment_status: z
      .enum(['queued', 'running', 'succeeded', 'failed'])
      .nullable()
      .optional(),
    last_deployment: z.string().nullable().optional(),
  })
  route(
    'get',
    servicePath,
    'List visible services and effective permissions',
    z.object({ can_create: z.boolean(), services: z.array(serviceRow) }),
  )
  route(
    'post',
    servicePath,
    'Create a Dockerfile application or Compose service (service create)',
    ok,
    serviceBody,
    true,
    201,
  )
  route(
    'put',
    `${servicePath}/{service}`,
    'Edit service details (service update)',
    ok,
    serviceUpdateBody,
  )
  route(
    'delete',
    `${servicePath}/{service}`,
    'Remove service and deployment configuration; retain running containers (service delete)',
    ok,
  )
  route(
    'get',
    `${servicePath}/{service}/connectors`,
    'List active deployment hosts (service deploy)',
    z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  )
  const deploymentPath =
    '/projects/{project}/applications/{application}/deployment'
  route(
    'get',
    deploymentPath,
    'Read deployment and latest build history (service read or Server Administrator)',
    flexible.nullable(),
  )
  route(
    'put',
    deploymentPath,
    'Save deployment; creation returns a one-time webhook secret (service deploy or Server Administrator)',
    z.object({
      id: z.string().uuid(),
      webhook_url: z.string(),
      webhook_secret: z.string().optional(),
    }),
    deploymentSchema,
  )
  route(
    'post',
    deploymentPath,
    'Queue a commit build with JSON body; rotate webhook secret with empty body (service deploy or Server Administrator)',
    z.union([
      z.object({ webhook_secret: z.string() }),
      z.object({ queued: z.literal(true) }),
    ]),
    z
      .object({ commit: z.string().regex(/^[a-f0-9]{40}$/) })
      .strict()
      .optional(),
  )
  registry.registerComponent('securitySchemes', 'connector', {
    type: 'http',
    scheme: 'bearer',
  })
  for (const [path, summary, output, input] of [
    [
      '/connectors/deployments/claim',
      'Claim the next build for this connector',
      z.object({ job: deploymentJobSchema.nullable() }),
      z.object({}),
    ],
    [
      '/connectors/deployments/{id}/result',
      'Finalize a running build owned by this connector',
      z.object({ ok: z.boolean() }),
      z.object({
        status: z.enum(['succeeded', 'failed']),
        log: z.string().max(48000),
      }),
    ],
    [
      '/connectors/platform/claim',
      'Claim the next saved service revision',
      flexible,
      z.object({}),
    ],
    [
      '/connectors/platform/{id}/result',
      'Finalize a service deployment owned by this connector',
      flexible,
      z.object({
        status: z.enum(['succeeded', 'failed']),
        log: z.string().max(48000),
        artifacts: z.record(z.string(), z.string().max(500)).nullable(),
      }),
    ],
    [
      '/connectors/platform/proxy',
      'Report applied proxy state and obtain desired routes',
      flexible,
      z.object({
        applied: z.string().max(64).nullable(),
        error: z.string().max(500).nullable(),
      }),
    ],
  ] as const) {
    registry.registerPath({
      method: 'post',
      path,
      summary,
      tags: ['Deployments'],
      security: [{ connector: [] }],
      request: {
        ...(path.includes('{id}')
          ? { params: z.object({ id: z.string().uuid() }) }
          : {}),
        body: { content: { 'application/json': { schema: input } } },
      },
      responses: {
        200: {
          description: 'Success',
          content: { 'application/json': { schema: output } },
        },
        401: { description: 'Invalid or revoked connector credential' },
      },
    })
  }
  for (const base of [
    '/admin/dns/providers',
    '/projects/{project}/dns/providers',
  ]) {
    route(
      'get',
      base,
      'List DNS provider connections (tokens never returned)',
      z.array(flexible),
    )
    route(
      'post',
      base,
      'Connect a Cloudflare provider',
      z.object({ id: z.string().uuid() }),
      dnsProviderBody,
      true,
      201,
    )
    route(
      'put',
      `${base}/{id}`,
      'Rename, replace token, enable or disable DNS provider',
      ok,
      dnsProviderUpdate,
    )
    route(
      'delete',
      `${base}/{id}`,
      'Disconnect provider; leave live DNS unchanged',
      ok,
    )
    route('post', `${base}/{id}/test`, 'Test provider credentials', ok)
    route(
      'post',
      `${base}/{id}/discover`,
      'Discover zones without granting project access',
      z.array(flexible),
    )
    route(
      'get',
      `${base}/{id}/zones`,
      'List discovered zones and project delegations',
      z.array(flexible),
    )
    route(
      'get',
      `${base}/{id}/zones/{zone}/records`,
      'List records for delegation selection (provider owner only)',
      z.array(flexible),
    )
    route(
      'put',
      `${base}/{id}/zones/{zone}/projects/{target}`,
      'Replace project delegation; empty rules revoke access',
      ok,
      dnsDelegationBody,
    )
  }
  route(
    'get',
    '/admin/dns/projects',
    'List project choices for DNS delegation (dns.manage)',
    z.array(project),
  )
  route(
    'get',
    '/projects/{project}/dns',
    'List accessible project DNS zones',
    flexible,
  )
  route(
    'get',
    '/projects/{project}/dns/access-scopes',
    'List project DNS delegation limits (Project Administrator)',
    flexible,
  )
  const recordsPath = '/projects/{project}/dns/zones/{zone}/records'
  route(
    'get',
    recordsPath,
    'List authorized records and effective creation scopes',
    flexible,
  )
  route(
    'post',
    recordsPath,
    'Create authorized DNS record',
    flexible,
    dnsRecordSchema,
    true,
    201,
  )
  route(
    'get',
    `${recordsPath}/{record}`,
    'Read authorized DNS record',
    flexible,
  )
  route(
    'put',
    `${recordsPath}/{record}`,
    'Update DNS record after checking old and new scope',
    flexible,
    dnsRecordSchema,
  )
  route('delete', `${recordsPath}/{record}`, 'Delete authorized DNS record', ok)
  const platformPath = '/projects/{project}/services/{service}'
  route(
    'get',
    '/projects/{project}/hosts',
    'List deployment hosts and capabilities',
    z.array(flexible),
  )
  route(
    'get',
    `${platformPath}/configuration`,
    'List configuration revisions and deployment history',
    flexible,
  )
  route(
    'get',
    `${platformPath}/configuration/{revision}`,
    'Read configuration with masked secrets (deploy permission)',
    flexible,
  )
  route(
    'put',
    `${platformPath}/configuration`,
    'Save encrypted configuration draft',
    flexible,
    z.object({
      config: platformConfigSchema,
      previous: z.string().uuid().optional(),
    }),
    true,
    201,
  )
  route(
    'post',
    `${platformPath}/deploy`,
    'Deploy saved revision or roll back a successful run',
    flexible,
    z.object({
      revision: z.string().uuid(),
      request_key: z.string().uuid(),
      commit: z.string().optional(),
      rollback: z.string().uuid().optional(),
    }),
    true,
    202,
  )
  route(
    'get',
    `${platformPath}/domains`,
    'List domain routes and desired/applied proxy state',
    z.array(flexible),
  )
  route(
    'post',
    `${platformPath}/domains`,
    'Save a managed NGINX route; does not change DNS',
    flexible,
    z.object({ connector_id: z.string().uuid(), config: domainSchema }),
    true,
    201,
  )
  route(
    'delete',
    `${platformPath}/domains/{id}`,
    'Remove a managed NGINX route',
    flexible,
  )
  route(
    'get',
    '/projects/{project}/containers/{connector}/{container}/permissions',
    'Read effective runtime operation permissions',
    flexible,
  )
  route(
    'post',
    '/projects/{project}/containers/{connector}/{container}/operation',
    'Perform authorized runtime operation through connector',
    flexible,
    runtimeRequestSchema,
  )
  registry.registerPath({
    method: 'get',
    path: '/projects/{project}/containers/{connector}/{container}/logs',
    summary:
      'Stream bounded container logs; grants and session are rechecked for each event',
    tags: ['Projects'],
    security: [{ session: [] }],
    responses: {
      200: {
        description: 'Authenticated log stream',
        content: { 'text/event-stream': { schema: z.string() } },
      },
      403: { description: 'Logs grant required' },
      409: { description: 'Host unavailable' },
    },
  })
  registry.registerPath({
    method: 'post',
    path: '/hooks/github/{id}',
    summary: 'Receive a GitHub webhook signed over the raw body',
    tags: ['Deployments'],
    security: [],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: z.object({
        'x-hub-signature-256': z.string(),
        'x-github-event': z.string(),
        'x-github-delivery': z.string().optional(),
      }),
      body: { content: { 'application/json': { schema: flexible } } },
    },
    responses: {
      200: { description: 'Ignored non-push event' },
      202: { description: 'Verified push processed' },
      401: { description: 'Invalid webhook signature' },
    },
  })
}
