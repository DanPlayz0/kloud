import { test, expect, type Page } from '@playwright/test'
const hostId = '11111111-1111-4111-8111-111111111111'
const project = { slug: 'demo', name: 'Demo', can_manage_access: true }
async function setup(
  page: Page,
  options: {
    canCreate?: boolean
    canDeploy?: boolean
    hosts?: any[]
    failConfig?: boolean
    failDeploy?: boolean
  } = {},
) {
  const calls = {
    created: [] as any[],
    configurations: [] as any[],
    deployments: [] as any[],
  }
  let failConfig = !!options.failConfig,
    failDeploy = !!options.failDeploy
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method()
    if (path === '/api/auth/me')
      return route.fulfill({
        json: { id: 'admin', username: 'Admin', admin: true, capabilities: [] },
      })
    if (path === '/api/projects') return route.fulfill({ json: [project] })
    if (path === '/api/projects/demo/services') {
      if (method === 'POST') {
        calls.created.push(request.postDataJSON())
        return route.fulfill({ status: 201, json: { ok: true } })
      }
      return route.fulfill({
        json: {
          can_create: options.canCreate ?? true,
          can_deploy_all: options.canDeploy ?? true,
          services: [],
        },
      })
    }
    if (path === '/api/projects/demo/hosts')
      return route.fulfill({
        json: options.hosts ?? [
          {
            id: hostId,
            name: 'Production',
            seen: new Date().toISOString(),
            capabilities: ['deploy'],
          },
        ],
      })
    if (path.endsWith('/configuration')) {
      if (method === 'PUT') {
        calls.configurations.push(request.postDataJSON())
        if (failConfig) {
          failConfig = false
          return route.fulfill({
            status: 503,
            json: { error: 'Host temporarily unavailable' },
          })
        }
        return route.fulfill({
          status: 201,
          json: { id: '22222222-2222-4222-8222-222222222222' },
        })
      }
      return route.fulfill({ json: { revisions: [], runs: [] } })
    }
    if (path.endsWith('/deploy') && method === 'POST') {
      calls.deployments.push(request.postDataJSON())
      if (failDeploy) {
        failDeploy = false
        return route.fulfill({
          status: 503,
          json: { error: 'Queue temporarily unavailable' },
        })
      }
      return route.fulfill({ status: 202, json: { id: 'run' } })
    }
    if (path.includes('/applications/'))
      return route.fulfill({
        json: path.endsWith('/deployment')
          ? null
          : {
              name: calls.created.at(-1)?.name ?? 'New service',
              type: 'application',
              can_deploy: true,
            },
      })
    return route.fulfill({ json: [] })
  })
  await page.goto('/projects/demo/services/new')
  return calls
}
async function image(page: Page) {
  await page.getByRole('button', { name: 'Docker image', exact: true }).click()
  await page.getByLabel('Service name').fill('My image')
  await page.getByLabel('Image', { exact: true }).fill('nginx:alpine')
}

for (const source of ['image', 'compose'] as const) {
  test(`imports a production .env while creating a ${source} service`, async ({
    page,
  }) => {
    const calls = await setup(page)
    if (source === 'image') {
      await image(page)
      await page
        .getByRole('button', { name: 'Environment and secrets', exact: true })
        .click()
    } else {
      await page
        .getByRole('button', { name: 'Docker Compose', exact: true })
        .click()
      await page.getByLabel('Service name').fill('My stack')
      await page
        .getByLabel('Compose definition')
        .fill('services:\n  web:\n    image: nginx:alpine\n')
    }
    let dialogs = 0
    page.on('dialog', async (dialog) => {
      dialogs++
      await dialog.dismiss()
    })
    const developer = page.getByRole('radio', {
      name: 'Developer .env',
      exact: true,
    })
    await expect(developer).toBeEnabled()
    await developer.click()
    const document = page.getByLabel('Complete .env document')
    await document.fill(
      '# Production\nAPI_KEY=secret$value\nMESSAGE="hello world"\nEMPTY=\nPRIVATE_KEY="line one\\nline two"\n',
    )
    await page.getByRole('radio', { name: 'Normal', exact: true }).click()
    await expect(page.getByLabel('Variable name')).toHaveCount(4)
    await developer.click()
    await expect(document).toHaveValue(/API_KEY=.*secret\$value/)
    await document.fill('INVALID LINE')
    await page.getByRole('button', { name: 'Save draft', exact: true }).click()
    expect(calls.created).toHaveLength(0)
    await document.fill(
      'API_KEY=secret$value\nMESSAGE="hello world"\nEMPTY=\nPRIVATE_KEY="line one\\nline two"\n',
    )
    await page.getByRole('button', { name: 'Save draft', exact: true }).click()
    await expect(page).toHaveURL(
      `/projects/demo/applications/${source === 'image' ? 'my-image' : 'my-stack'}`,
    )
    expect(calls.configurations[0].config.runtime.environment).toEqual({
      API_KEY: 'secret$value',
      MESSAGE: 'hello world',
      EMPTY: '',
      PRIVATE_KEY: 'line one\nline two',
    })
    expect(dialogs).toBe(0)
  })
}

test('visual picker supports keyboard navigation and preserves source drafts and custom slugs', async ({
  page,
}) => {
  await setup(page)
  await expect(page.getByRole('textbox')).toHaveCount(0)
  for (const name of [
    'GitHub application',
    'GitHub Compose',
    'Docker image',
    'Docker Compose',
  ])
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  const github = page.getByRole('button', {
    name: 'GitHub application',
    exact: true,
  })
  await github.focus()
  await github.press('Enter')
  await expect(page.getByLabel('Service name')).toBeFocused()
  await page
    .getByRole('button', { name: 'About GitHub application', exact: true })
    .focus()
  await expect(page.getByRole('tooltip')).toContainText(
    'Build paths are relative',
  )
  await page.getByLabel('Service name').fill('My web')
  await page.getByLabel('GitHub repository (owner/repo)').fill('owner/web')
  await expect(
    page.getByRole('radio', { name: 'Deploy to Production' }),
  ).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByLabel('Branch')).toBeHidden()
  await page
    .getByRole('button', { name: 'Build settings', exact: true })
    .click()
  await page.getByLabel('Branch').fill('production')
  await page
    .getByRole('button', { name: 'Advanced settings', exact: true })
    .click()
  await page.getByLabel('Slug', { exact: true }).fill('custom-service')
  await page.getByLabel('Service name').fill('Renamed service')
  await expect(page.getByLabel('Slug', { exact: true })).toHaveValue(
    'custom-service',
  )
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await expect(github).toBeFocused()
  await page.getByRole('button', { name: 'Docker image', exact: true }).click()
  await page.getByLabel('Image', { exact: true }).fill('redis:7-alpine')
  await expect(page.getByLabel('Service name')).toHaveValue('Renamed service')
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await github.click()
  await expect(page.getByLabel('GitHub repository (owner/repo)')).toHaveValue(
    'owner/web',
  )
  await page
    .getByRole('button', { name: 'Build settings', exact: true })
    .click()
  await expect(page.getByLabel('Branch')).toHaveValue('production')
  await expect(
    page.getByRole('button', { name: 'Build settings', exact: true }),
  ).toContainText('1')
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.getByRole('button', { name: 'Docker image', exact: true }).click()
  await expect(page.getByLabel('Image', { exact: true })).toHaveValue(
    'redis:7-alpine',
  )
})

test('unavailable hosts are explained and multiple eligible hosts require an explicit selection', async ({
  page,
}) => {
  const online = { seen: new Date().toISOString(), capabilities: ['deploy'] }
  const calls = await setup(page, {
    hosts: [
      { id: hostId, name: 'Production', ...online },
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Staging',
        ...online,
      },
      {
        id: 'offline',
        name: 'Offline host',
        seen: null,
        capabilities: ['deploy'],
      },
      {
        id: 'readonly',
        name: 'Read-only host',
        seen: new Date().toISOString(),
        capabilities: [],
      },
    ],
  })
  await image(page)
  await expect(
    page.getByRole('radio', { name: 'Deploy to Offline host' }),
  ).toBeDisabled()
  await expect(
    page.getByRole('radio', { name: 'Deploy to Read-only host' }),
  ).toContainText('Deployments disabled')
  await page.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(page.locator('[data-slot="alert"]')).toContainText(
    'Deployment host',
  )
  expect(calls.created).toHaveLength(0)
  await page.getByRole('radio', { name: 'Deploy to Staging' }).click()
  await page.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(page).toHaveURL('/projects/demo/applications/my-image')
  expect(calls.configurations[0].config.connector_id).toBe(
    '33333333-3333-4333-8333-333333333333',
  )
  expect(calls.deployments).toHaveLength(0)
})

test('collapsed validation errors reveal the affected settings without losing configured values', async ({
  page,
}) => {
  const calls = await setup(page)
  await image(page)
  await page
    .getByRole('button', { name: 'Registry credentials', exact: true })
    .click()
  await page.getByLabel('Registry server (optional)').fill('ghcr.io')
  await page
    .getByRole('button', { name: 'Registry credentials', exact: true })
    .click()
  await page.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Registry credentials', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByLabel('Registry username')).toBeFocused()
  await expect(page.getByLabel('Registry username')).toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await page.getByLabel('Registry username').fill('owner')
  await expect(page.getByLabel('Registry username')).not.toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await page.getByLabel('Registry password').fill('secret')
  await page
    .getByRole('button', { name: 'Registry credentials', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Published ports', exact: true })
    .click()
  await page.getByRole('button', { name: 'Add port', exact: true }).click()
  await page.getByLabel('Host port', { exact: true }).fill('19090')
  await page
    .getByRole('button', { name: 'Published ports', exact: true })
    .click()
  await page.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(page).toHaveURL('/projects/demo/applications/my-image')
  expect(calls.configurations[0].config.runtime.ports[0].host).toBe(19090)
  expect(calls.configurations[0].config.source.registry.password).toBe('secret')
})

test('schema errors open build settings and focus the invalid field', async ({
  page,
}) => {
  const calls = await setup(page)
  await page
    .getByRole('button', { name: 'GitHub application', exact: true })
    .click()
  await page.getByLabel('Service name').fill('Build test')
  await page
    .getByLabel('GitHub repository (owner/repo)')
    .fill('invalid-repository')
  await page.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(page.locator('[data-slot="alert"]')).toContainText('Repository')
  await expect(page.getByLabel('GitHub repository (owner/repo)')).toBeFocused()
  await expect(
    page.getByRole('button', { name: 'Build settings', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false')
  await page.getByLabel('GitHub repository (owner/repo)').fill('owner/repo')
  await page
    .getByRole('button', { name: 'Build settings', exact: true })
    .click()
  await page.getByLabel('Build file', { exact: true }).fill('../Dockerfile')
  await page
    .getByRole('button', { name: 'Build settings', exact: true })
    .click()
  await page.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(page.getByLabel('Build file', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Build file', { exact: true })).toBeFocused()
  await expect(page.locator('[data-slot="alert"]')).toContainText(
    'Build settings',
  )
  expect(calls.created).toHaveLength(0)
})

test('Compose creation ignores inactive runtime overrides while source changes preserve them', async ({
  page,
}) => {
  const calls = await setup(page)
  await image(page)
  await page
    .getByRole('button', { name: 'Resources and restart', exact: true })
    .click()
  await page.getByLabel('Memory limit (MiB)').fill('2')
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page
    .getByRole('button', { name: 'Docker Compose', exact: true })
    .click()
  await page
    .getByLabel('Compose definition')
    .fill('services:\n  web:\n    image: nginx:alpine\n')
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.getByRole('button', { name: 'Docker image', exact: true }).click()
  await page
    .getByRole('button', { name: 'Resources and restart', exact: true })
    .click()
  await expect(page.getByLabel('Memory limit (MiB)')).toHaveValue('2')
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page
    .getByRole('button', { name: 'Docker Compose', exact: true })
    .click()
  await page.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(page).toHaveURL('/projects/demo/applications/my-image')
  expect(calls.configurations[0].config.runtime.memoryMb).toBeUndefined()
  expect(calls.created[0].type).toBe('compose')
})

test('explicit Git deployment reveals a commit field and duplicate submits do not recreate services', async ({
  page,
}) => {
  const calls = await setup(page, { failDeploy: true })
  await page
    .getByRole('button', { name: 'GitHub application', exact: true })
    .click()
  await page.getByLabel('Service name').fill('Git deploy')
  await page.getByLabel('GitHub repository (owner/repo)').fill('owner/repo')
  await expect(page.getByLabel('Commit SHA', { exact: true })).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Create and deploy', exact: true })
    .click()
  await expect(page.getByLabel('Commit SHA', { exact: true })).toBeFocused()
  expect(calls.created).toHaveLength(0)
  await page.getByLabel('Commit SHA', { exact: true }).fill('a'.repeat(40))
  await page.getByRole('button', { name: 'Deploy now', exact: true }).click()
  await expect(page.locator('[data-slot="alert"]')).toHaveText(
    'Queue temporarily unavailable',
  )
  await page.getByRole('button', { name: 'Deploy now', exact: true }).click()
  await expect(page).toHaveURL('/projects/demo/applications/git-deploy')
  expect(calls.created).toHaveLength(1)
  expect(calls.configurations).toHaveLength(1)
  expect(calls.deployments).toHaveLength(2)
  expect(calls.deployments[0].request_key).toBe(
    calls.deployments[1].request_key,
  )
  expect(calls.deployments[1].commit).toBe('a'.repeat(40))
})

test('saving after Git deployment is chosen does not require a commit or enqueue a build', async ({
  page,
}) => {
  const calls = await setup(page)
  await page
    .getByRole('button', { name: 'GitHub Compose', exact: true })
    .click()
  await page.getByLabel('Service name').fill('Git stack')
  await page.getByLabel('GitHub repository (owner/repo)').fill('owner/stack')
  await expect(
    page.getByRole('button', { name: 'Environment and secrets', exact: true }),
  ).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Create and deploy', exact: true })
    .click()
  await page.getByLabel('Commit SHA', { exact: true }).fill('not-a-commit')
  await page.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(page).toHaveURL('/projects/demo/applications/git-stack')
  expect(calls.deployments).toHaveLength(0)
})

test('failed configuration saves preserve values and retry metadata only once', async ({
  page,
}) => {
  const calls = await setup(page, { failConfig: true })
  await image(page)
  await page
    .getByRole('button', { name: 'Create and deploy', exact: true })
    .click()
  await expect(page.locator('[data-slot="alert"]')).toHaveText(
    'Host temporarily unavailable',
  )
  await expect(page.getByLabel('Image', { exact: true })).toHaveValue(
    'nginx:alpine',
  )
  await expect(
    page.getByRole('button', { name: 'Change', exact: true }),
  ).toBeDisabled()
  await page
    .getByRole('button', { name: 'Create and deploy', exact: true })
    .click()
  await expect(page).toHaveURL('/projects/demo/applications/my-image')
  expect(calls.created).toHaveLength(1)
  expect(calls.deployments).toHaveLength(1)
})

test('create-only users get naming without host or deployment configuration; denied users cannot start', async ({
  page,
}) => {
  const calls = await setup(page, { canDeploy: false })
  await page
    .getByRole('button', { name: 'Docker Compose', exact: true })
    .click()
  await page.getByLabel('Service name').fill('Requested stack')
  await expect(page.getByLabel('Compose definition')).toHaveCount(0)
  await expect(
    page.getByRole('region', { name: 'Deployment host' }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Create and deploy', exact: true }),
  ).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Create service', exact: true })
    .click()
  await expect(page).toHaveURL('/projects/demo/applications/requested-stack')
  expect(calls.created[0].type).toBe('compose')
  expect(calls.configurations).toHaveLength(0)
  await page.unrouteAll({ behavior: 'wait' })
  await setup(page, { canCreate: false })
  await expect(
    page.getByText('You need permission to create services in this project.'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Docker image', exact: true }),
  ).toHaveCount(0)
})

for (const width of [320, 390, 1440])
  test(`picker and setup fit at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await setup(page)
    await expect(
      page.getByRole('heading', { name: 'What would you like to deploy?' }),
    ).toBeVisible()
    await page.screenshot({
      path: info.outputPath('source-picker.png'),
      fullPage: true,
    })
    await expect(
      page.getByRole('button', { name: 'Docker Compose', exact: true }),
    ).toBeVisible()
    await page
      .getByRole('button', { name: 'Docker Compose', exact: true })
      .click()
    await page
      .getByLabel('Service name')
      .fill(
        'A very long service name that should fit comfortably on small screens',
      )
    await page
      .getByLabel('Compose definition')
      .fill(
        'services:\n  web:\n    image: ghcr.io/example/very-long-image-name:latest\n',
      )
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    await page.screenshot({
      path: info.outputPath('compose-setup.png'),
      fullPage: true,
    })
  })
