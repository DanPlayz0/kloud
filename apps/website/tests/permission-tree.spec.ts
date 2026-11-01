import { test, expect, type Page } from '@playwright/test'

const capabilities = [
  'dns.manage',
  'users.manage',
  'projects.create',
  'projects.manage',
  'connectors.manage',
  'inventory.manage',
]
const owner = { id: 'owner', username: 'owner', admin: true, capabilities: [] }
const project = { slug: 'demo', name: 'Demo', can_manage_access: true }

async function fixtures(page: Page) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const data: Record<string, unknown> = {
      '/api/auth/me': owner,
      '/api/projects': [project],
      '/api/admin/users': [
        { ...owner, disabled: false, enrolled: true, projects: [] },
        {
          id: 'member',
          username: 'member',
          admin: false,
          capabilities,
          disabled: false,
          enrolled: true,
          projects: [],
        },
      ],
      '/api/projects/demo/access': { grant_mode: 'id', members: [] },
      '/api/projects/demo/dns/access-scopes': { zones: [] },
      '/api/projects/demo/containers': [],
      '/api/projects/demo/pm2': [],
    }
    return route.fulfill({ json: data[path] ?? { ok: true } })
  })
}

test('users table searches, dialogs reset drafts, and failed saves preserve project access', async ({
  page,
}, testInfo) => {
  await fixtures(page)
  let fail = true
  await page.route('**/api/admin/users/member', (route) =>
    route.fulfill({
      status: fail ? 500 : 200,
      json: fail ? { error: 'Save failed' } : { ok: true },
    }),
  )
  await page.goto('/admin/users')
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(
    page.getByRole('row').filter({ hasText: 'member' }),
  ).toContainText(`${capabilities.length} permissions`)
  await page.screenshot({
    path: testInfo.outputPath('users-desktop.png'),
    fullPage: true,
  })
  await page.getByRole('textbox', { name: 'Search users' }).fill('missing')
  await expect(page.getByText('No users match your search.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Search users' }).fill('member')
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit member', exact: true })
  await expect(
    dialog.getByRole('button', { name: 'Save access' }),
  ).toBeDisabled()
  await dialog
    .getByRole('checkbox', {
      name: 'Manage all projects and project access',
      exact: true,
    })
    .uncheck()
  await dialog.getByRole('checkbox', { name: 'Demo', exact: true }).check()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  await dialog
    .getByRole('checkbox', {
      name: 'Manage all projects and project access',
      exact: true,
    })
    .uncheck()
  await expect(
    dialog.getByRole('checkbox', { name: 'Demo', exact: true }),
  ).not.toBeChecked()
  await dialog.getByRole('checkbox', { name: 'Demo', exact: true }).check()
  await dialog.getByRole('button', { name: 'Save access' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(
    dialog.getByRole('checkbox', { name: 'Demo', exact: true }),
  ).toBeChecked()
  fail = false
  const request = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().endsWith('/admin/users/member'),
  )
  await dialog.getByRole('button', { name: 'Save access' }).click()
  expect((await request).postDataJSON()).toMatchObject({
    projects: ['demo'],
    disabled: false,
    admin: false,
    capabilities: capabilities.filter(
      (capability) => capability !== 'projects.manage',
    ),
  })
  await expect(dialog).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Edit member', exact: true }),
  ).toBeFocused()
  await page.getByRole('textbox', { name: 'Search users' }).fill('')
  await page.getByRole('button', { name: 'Edit owner', exact: true }).click()
  await expect(
    page
      .getByRole('dialog')
      .getByRole('checkbox', { name: 'Disabled', exact: true }),
  ).toBeDisabled()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Invite user', exact: true }).click()
  const invite = page.getByRole('dialog', { name: 'Invite user', exact: true })
  await invite.getByLabel('Email address').fill('new-user@example.com')
  await page.screenshot({
    path: testInfo.outputPath('users-invite-mobile.png'),
    fullPage: true,
  })
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)
  const invitation = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/admin/users'),
  )
  await invite.getByRole('button', { name: 'Invite user', exact: true }).click()
  expect((await invitation).postDataJSON()).toEqual({
    email: 'new-user@example.com',
    admin: false,
    capabilities: [],
  })
  await expect(invite).toHaveCount(0)
})

test('all-project access locks project selections and preserves saved memberships', async ({
  page,
}) => {
  await fixtures(page)
  await page.goto('/admin/users')
  await expect(
    page.getByRole('row').filter({ hasText: 'member' }),
  ).toContainText('All projects')
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const project = dialog.getByRole('checkbox', { name: 'Demo', exact: true })
  const manage = dialog.getByRole('checkbox', {
    name: 'Manage all projects and project access',
    exact: true,
  })
  await expect(project).toBeChecked()
  await expect(project).toBeDisabled()
  await manage.uncheck()
  await expect(project).toBeEnabled()
  await expect(project).not.toBeChecked()
  await project.check()
  await manage.check()
  await expect(project).toBeDisabled()
  await manage.uncheck()
  await expect(project).toBeChecked()
  await project.uncheck()
  await manage.check()
  await dialog.getByRole('checkbox', { name: 'Disabled', exact: true }).check()
  const request = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().endsWith('/admin/users/member'),
  )
  await dialog.getByRole('button', { name: 'Save access' }).click()
  expect((await request).postDataJSON()).toMatchObject({
    projects: [],
    capabilities,
  })
  await page.getByRole('button', { name: 'Edit owner', exact: true }).click()
  await expect(
    page
      .getByRole('dialog')
      .getByRole('checkbox', { name: 'Demo', exact: true }),
  ).toBeDisabled()
})

test('delegated user management protects privileged users and omits administrator fields', async ({
  page,
}) => {
  await fixtures(page)
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        id: 'delegate',
        username: 'delegate',
        admin: false,
        capabilities: ['users.manage'],
      },
    }),
  )
  await page.route('**/api/admin/users', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: [
            { ...owner, disabled: false, enrolled: true, projects: [] },
            {
              id: 'basic',
              username: 'basic',
              admin: false,
              disabled: false,
              enrolled: false,
              projects: [],
            },
          ],
        })
      : route.fulfill({ json: { ok: true } }),
  )
  await page.goto('/admin/users')
  await expect(
    page.getByRole('button', { name: 'Edit owner', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByText('Organization Administrator required', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Edit basic', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('checkbox', {
      name: 'Organization Administrator',
      exact: true,
    }),
  ).toHaveCount(0)
  await expect(
    dialog.getByRole('checkbox', { name: 'Demo', exact: true }),
  ).toHaveCount(0)
  await dialog.getByRole('checkbox', { name: 'Disabled', exact: true }).check()
  const request = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().endsWith('/admin/users/basic'),
  )
  await dialog.getByRole('button', { name: 'Save access' }).click()
  expect((await request).postDataJSON()).toEqual({ disabled: true })
  await expect(dialog).toHaveCount(0)
})

test('server permission tree inherits, locks, saves, and keeps delegated capabilities separate from administrator', async ({
  page,
}) => {
  await fixtures(page)
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Edit owner', exact: true }).click()
  const ownerRow = page.getByRole('dialog', { name: 'Edit owner', exact: true })
  await expect(
    ownerRow.getByRole('checkbox', {
      name: 'Organization Administrator',
      exact: true,
    }),
  ).toBeChecked()
  await expect(
    ownerRow.getByRole('checkbox', { name: 'Manage users', exact: true }),
  ).toBeChecked()
  await expect(
    ownerRow.getByRole('checkbox', { name: 'Manage users', exact: true }),
  ).toBeDisabled()
  const lock = ownerRow.getByRole('img', { name: /^Manage users:/ })
  await lock.hover()
  await expect(page.getByRole('tooltip')).toContainText(
    'inherited from an administrator role',
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.mouse.move(0, 0)
  await lock.focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)

  await ownerRow.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  const member = page.getByRole('dialog', { name: 'Edit member', exact: true })
  const admin = member.getByRole('checkbox', {
    name: 'Organization Administrator',
    exact: true,
  })
  await expect(admin).toHaveAttribute('aria-checked', 'mixed')
  await expect(
    member.getByRole('checkbox', { name: 'Manage users', exact: true }),
  ).toBeEnabled()
  await admin.click()
  await expect(admin).toBeChecked()
  await expect(
    member.getByRole('checkbox', { name: 'Manage connectors', exact: true }),
  ).toBeDisabled()
  const request = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/admin/users/member') &&
      request.method() === 'PUT',
  )
  await member.getByRole('button', { name: 'Save access' }).click()
  expect((await request).postDataJSON()).toMatchObject({
    admin: true,
    capabilities,
  })
  await expect(page.getByRole('status')).toContainText('Changes saved')
  await expect(member).toHaveCount(0)

  await page.getByRole('button', { name: 'Invite user', exact: true }).click()
  const invite = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Invite user', exact: true }),
  })
  await invite
    .getByRole('checkbox', { name: 'Organization Administrator', exact: true })
    .click()
  await expect(
    invite.getByRole('checkbox', { name: 'Manage users', exact: true }),
  ).toBeDisabled()
  await invite
    .getByRole('checkbox', { name: 'Organization Administrator', exact: true })
    .click()
  await expect(
    invite.getByRole('checkbox', { name: 'Manage users', exact: true }),
  ).not.toBeChecked()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)
})

test('container tree enforces View and displays all inherited project administrator capabilities', async ({
  page,
}) => {
  await fixtures(page)
  await page.goto('/projects/demo/access')
  await page
    .getByRole('button', { name: 'Invite or add member', exact: true })
    .click()
  const form = page.locator('form').filter({
    has: page.getByRole('button', {
      name: 'Invite or add member',
      exact: true,
    }),
  })
  const view = form.getByRole('checkbox', { name: 'View', exact: true })
  await form
    .getByRole('checkbox', { name: 'logs (planned)', exact: true })
    .click()
  await expect(view).toBeChecked()
  await expect(view).toBeDisabled()
  await expect(
    form.getByRole('checkbox', {
      name: 'All container capabilities',
      exact: true,
    }),
  ).toHaveAttribute('aria-checked', 'mixed')
  await form.getByLabel('Project role').selectOption('admin')
  for (const checkbox of await form.getByRole('checkbox').all()) {
    await expect(checkbox).toBeChecked()
    await expect(checkbox).toBeDisabled()
  }
  await form.getByLabel('Project role').selectOption('member')
  await expect(
    form.getByRole('checkbox', { name: 'terminal (planned)', exact: true }),
  ).not.toBeChecked()
  await expect(view).toBeDisabled()
})

test('member dialog discards drafts, preserves failed saves, and closes after success', async ({
  page,
}) => {
  await fixtures(page)
  const member = {
    id: 'member',
    username: 'member',
    role: 'member',
    disabled: false,
    grants: [],
  }
  await page.route('**/api/projects/demo/access', (route) =>
    route.fulfill({ json: { grant_mode: 'id', members: [member] } }),
  )
  let fail = true
  await page.route('**/api/projects/demo/access/members/member', (route) =>
    route.fulfill({
      status: fail ? 500 : 200,
      json: fail ? { error: 'Save failed' } : { ok: true },
    }),
  )
  await page.goto('/projects/demo/access')
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Search members' }).fill('missing')
  await expect(page.getByText('No members match your search.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Search members' }).fill('member')
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit member', exact: true })
  await expect(
    dialog.getByRole('button', { name: 'Save member access' }),
  ).toBeDisabled()
  await dialog.getByLabel('Project role').selectOption('admin')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  await expect(dialog.getByLabel('Project role')).toHaveValue('member')
  await dialog.getByLabel('Project role').selectOption('admin')
  await dialog.getByRole('button', { name: 'Save member access' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(dialog.getByLabel('Project role')).toHaveValue('admin')
  fail = false
  const request = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().endsWith('/access/members/member'),
  )
  await dialog.getByRole('button', { name: 'Save member access' }).click()
  expect((await request).postDataJSON()).toEqual({
    role: 'admin',
    grants: [],
    service_grants: [],
    pm2_grants: [],
  })
  await expect(dialog).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Edit member', exact: true }),
  ).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: 'Invite or add member', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)
})
