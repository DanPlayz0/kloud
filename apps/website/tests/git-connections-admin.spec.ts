import { test, expect } from '@playwright/test'

test('administration prepares a connection without a service, edits availability and revokes it', async ({
  page,
}) => {
  const connections: any[] = []
  let created: any
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    let json: any = []
    if (path === '/api/auth/me')
      json = { id: 'admin', username: 'Admin', admin: true }
    else if (
      path === '/api/projects' ||
      path === '/api/admin/git-connections/projects'
    )
      json = [{ slug: 'demo', name: 'Demo' }]
    else if (path === '/api/admin/git-connections') json = connections
    else if (
      path === '/api/projects/demo/git-connections' &&
      request.method() === 'POST'
    ) {
      created = request.postDataJSON()
      connections.push({
        id: 'connection',
        project: 'demo',
        project_name: 'Demo',
        name: created.name,
        provider: 'github',
        origin: 'https://github.com',
        owner: null,
        identity: {},
        project_access: created.project_access,
        revoked: false,
        bindings: 0,
      })
      json = { id: 'connection' }
    } else if (path === '/api/admin/git-connections/connection') {
      Object.assign(connections[0], request.postDataJSON())
      json = { saved: true }
    }
    return route.fulfill({ json })
  })
  await page.goto('/admin/git-connections')
  await expect(
    page.getByRole('heading', { name: 'Git connections', exact: true }),
  ).toBeVisible()
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Git connections', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('No Git connections', { exact: true }),
  ).toBeVisible()
  await page.getByLabel('Connection type').selectOption('github')
  await page
    .getByLabel('Connection name', { exact: true })
    .fill('Prepared GitHub')
  await page.getByLabel('Personal access token').fill('private-token')
  await page
    .getByRole('button', { name: 'Save connection', exact: true })
    .click()
  await expect(page.getByText('Prepared GitHub', { exact: true })).toBeVisible()
  expect(created).toEqual({
    name: 'Prepared GitHub',
    provider: 'github',
    token: 'private-token',
    scope: 'shared',
    project_access: true,
  })
  expect(created.service).toBeUndefined()
  await expect(page.getByLabel('Personal access token')).toHaveValue('')
  await page.screenshot({
    path: '.cache/git-connections-admin.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: '.cache/git-connections-admin-mobile.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: 'Manage Prepared GitHub' }).click()
  const dialog = page.getByRole('dialog')
  await dialog
    .getByLabel('Connection name', { exact: true })
    .fill('Production GitHub')
  await dialog.getByLabel('Available to project deployers').uncheck()
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('cell', { name: 'Delegated services only' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Manage Production GitHub' }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page
    .getByRole('button', { name: 'Revoke connection', exact: true })
    .click()
  await expect(
    page.getByRole('cell', { name: 'Revoked', exact: true }),
  ).toBeVisible()
})

test('user administration grants and removes creation permission independently from management', async ({
  page,
}) => {
  const member = {
    id: 'member',
    username: 'member',
    admin: false,
    capabilities: [] as string[],
    disabled: false,
    enrolled: true,
    projects: [],
  }
  const updates: any[] = []
  await page.route('**/api/**', (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    let json: any = []
    if (path === '/api/auth/me')
      json = { id: 'admin', username: 'Admin', admin: true }
    else if (path === '/api/admin/users') json = [member]
    else if (path === '/api/admin/users/member' && request.method() === 'PUT') {
      const body = request.postDataJSON()
      updates.push(body)
      Object.assign(member, body)
      json = { ok: true }
    }
    return route.fulfill({ json })
  })
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit member', exact: true })
  const create = dialog.getByRole('checkbox', {
    name: 'Create Git connections',
    exact: true,
  })
  const manage = dialog.getByRole('checkbox', {
    name: 'Manage all Git connections',
    exact: true,
  })
  await expect(create).not.toBeChecked()
  await expect(manage).not.toBeChecked()
  await create.check()
  await expect(manage).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Save access' }).click()
  await expect(dialog).toBeHidden()
  expect(updates[0].capabilities).toEqual(['git.create'])
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  await expect(create).toBeChecked()
  await create.uncheck()
  await dialog.getByRole('button', { name: 'Save access' }).click()
  await expect(dialog).toBeHidden()
  expect(updates[1].capabilities).toEqual([])
})

test('a user denied connection creation can select a prepared connection during service setup', async ({
  page,
}) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let json: any = []
    if (path === '/api/auth/me')
      json = {
        id: 'member',
        username: 'Member',
        admin: false,
        capabilities: [],
      }
    else if (path === '/api/projects') json = [{ slug: 'demo', name: 'Demo' }]
    else if (path === '/api/projects/demo/applications/web')
      json = { name: 'Web', type: 'application', can_deploy: true }
    else if (path.endsWith('/deployment')) json = null
    else if (path.endsWith('/configuration')) json = { revisions: [], runs: [] }
    else if (path.endsWith('/git-connections'))
      json = [
        {
          id: 'connection',
          name: 'Prepared GitHub',
          provider: 'github_app',
          origin: 'https://github.com',
          owner: null,
          identity: { account: 'org', installation_id: 1 },
        },
      ]
    else if (path.endsWith('/repositories'))
      json = {
        repositories: [
          {
            id: 'repo',
            name: 'org/web',
            url: 'https://github.com/org/web',
            default_branch: 'main',
            private: true,
          },
        ],
        next_page: null,
      }
    else if (path.endsWith('/branches'))
      json = {
        branches: [{ name: 'main', commit: 'a'.repeat(40) }],
        next_page: null,
      }
    return route.fulfill({ json })
  })
  await page.goto('/projects/demo/applications/web?setup=repository')
  await expect(
    page.getByText('Select a prepared connection.', { exact: false }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Add connection', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Git connections', exact: true }),
  ).toHaveCount(0)
  await page.getByLabel('Installation / account').selectOption('connection')
  await page
    .getByRole('button', { name: 'Load repositories', exact: true })
    .click()
  await page.getByLabel('Repository', { exact: true }).selectOption('repo')
  await expect(
    page.getByText('Selected: org/web · main', { exact: true }),
  ).toBeVisible()
})
