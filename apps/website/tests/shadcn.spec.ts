import { test, expect } from '@playwright/test'

test('invalid form controls expose field errors and clear them after editing', async ({
  page,
}) => {
  await page.route('**/api/auth/setup', (route) =>
    route.fulfill({ json: { required: true } }),
  )
  await page.goto('/login')
  const username = page.getByLabel('Username', { exact: true })
  await page
    .getByRole('button', { name: 'Create Organization Administrator' })
    .click()
  await expect(username).toHaveAttribute('aria-invalid', 'true')
  const errorId = await username.getAttribute('aria-describedby')
  expect(errorId).toBeTruthy()
  await expect(page.locator(`[id="${errorId}"]`)).toHaveAttribute(
    'role',
    'alert',
  )
  await expect(username.locator('..')).toHaveAttribute('data-invalid', 'true')
  await username.fill('administrator')
  await expect(username).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator(`[id="${errorId}"]`)).toHaveCount(0)
})

test('account menu supports keyboard dismissal and returns focus to its trigger', async ({
  page,
}) => {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({
      json:
        path === '/api/auth/me'
          ? { id: 'owner', username: 'Owner', admin: true }
          : [],
    })
  })
  await page.goto('/admin/projects')
  const trigger = page.getByRole('button', {
    name: 'Owner Organization Administrator',
  })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('menuitem', { name: 'Account security' }),
  ).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('service tabs connect triggers and panels and support keyboard navigation', async ({
  page,
}) => {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const data: Record<string, unknown> = {
      '/api/auth/me': { id: 'owner', username: 'Owner', admin: true },
      '/api/projects': [{ slug: 'demo', name: 'Demo' }],
      '/api/projects/demo/applications/web': {
        name: 'Web',
        type: 'application',
      },
      '/api/projects/demo/services/web/configuration': {
        revisions: [],
        runs: [],
        can_reveal: false,
      },
      '/api/projects/demo/applications/web/deployment': null,
    }
    return route.fulfill({ json: path in data ? data[path] : [] })
  })
  await page.goto('/projects/demo/applications/web')
  const overview = page.getByRole('tab', { name: 'Overview', exact: true })
  await expect(page.getByRole('tabpanel', { name: 'Overview' })).toBeVisible()
  const panelId = await overview.getAttribute('aria-controls')
  await expect(page.locator(`[id="${panelId}"]`)).toHaveAttribute(
    'aria-labelledby',
    (await overview.getAttribute('id')) as string,
  )
  await overview.focus()
  await page.keyboard.press('ArrowRight')
  await expect(
    page.getByRole('tab', { name: 'Source', exact: true }),
  ).toBeFocused()
  await expect(
    page.getByRole('tabpanel', { name: 'Source', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('tabpanel', { name: 'Overview' })).toHaveCount(0)
})

test('verification methods expose a single selection and retain the selected code field', async ({
  page,
}) => {
  await page.route('**/api/auth/setup', (route) =>
    route.fulfill({ json: { required: false } }),
  )
  await page.route('**/api/auth/password', (route) =>
    route.fulfill({
      json: {
        status: 'second_factor_required',
        methods: ['totp'],
        totpAvailable: true,
        emailAvailable: false,
      },
    }),
  )
  await page.goto('/login')
  await page.getByLabel('Username', { exact: true }).fill('member')
  await page.getByLabel('Password', { exact: true }).fill('some password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const methods = page.getByRole('radiogroup', { name: 'Verification method' })
  await methods.getByRole('radio', { name: 'Authenticator app' }).click()
  await expect(page.getByLabel('Authenticator app code')).toBeVisible()
  await methods.getByRole('radio', { name: 'Recovery code' }).click()
  await expect(
    methods.getByRole('radio', { name: 'Recovery code' }),
  ).toBeChecked()
  await expect(
    methods.getByRole('radio', { name: 'Authenticator app' }),
  ).not.toBeChecked()
  await expect(page.getByLabel('Recovery code', { exact: true })).toBeVisible()
})
