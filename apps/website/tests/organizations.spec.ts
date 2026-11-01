import { test, expect, type Page } from '@playwright/test'

async function organizationFixtures(page: Page, admin = true) {
  const requests: {
    path: string
    organization: string | undefined
    body?: unknown
  }[] = []
  await page.route('**/api/**', async (route) => {
    let path = new URL(route.request().url()).pathname.slice(4)
    requests.push({
      path,
      organization: route.request().headers()['x-kloud-organization'],
      body:
        route.request().method() === 'POST'
          ? route.request().postDataJSON()
          : undefined,
    })
    path = path.replace(/^\/organizations\/acme(?=\/)/, '')
    const result =
      path === '/auth/me'
        ? { id: 'owner', username: 'owner', admin, capabilities: [] }
        : path === '/auth/setup'
          ? { required: false }
          : path === '/organizations/current'
            ? {
                slug: 'acme',
                name: 'Acme organization',
                api_url: 'https://kloud.example/api/organizations/acme',
              }
            : path === '/organizations/lookup/acme'
              ? { slug: 'acme', name: 'Acme organization' }
              : path === '/organizations'
                ? { slug: 'new-org', name: 'New organization' }
                : []
    return route.fulfill({ json: result })
  })
  return requests
}

test('invitation organization routes all API requests before the user signs in', async ({
  page,
}) => {
  const requests = await organizationFixtures(page)
  await page.goto('/enroll?organization=acme#invitation-token')
  await expect(
    page.getByText('Choose a password to activate your account in acme.'),
  ).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill('secure-password-123')
  await page
    .getByLabel('Confirm password', { exact: true })
    .fill('secure-password-123')
  await page.getByRole('button', { name: 'Set password', exact: true }).click()
  expect(
    requests.some(
      (request) =>
        request.path === '/organizations/acme/auth/enroll' &&
        request.organization === 'acme' &&
        (request.body as any)?.token === 'invitation-token',
    ),
  ).toBe(true)
})

test('signed-out users can select an existing organization', async ({
  page,
}) => {
  const requests = await organizationFixtures(page)
  await page.goto('/login')
  await page.getByLabel('Organization slug', { exact: true }).fill('acme')
  await page
    .getByRole('button', { name: 'Switch organization', exact: true })
    .click()
  await expect(page).toHaveURL(/login\?organization=acme/)
  await expect(
    page.getByText('Signing in to acme', { exact: true }),
  ).toBeVisible()
  expect(
    requests.some(
      (request) =>
        request.path === '/organizations/acme/auth/setup' &&
        request.organization === 'acme',
    ),
  ).toBe(true)
})

test('organization administrators can create an isolated organization from the sidebar', async ({
  page,
}) => {
  const requests = await organizationFixtures(page)
  await page.goto('/?organization=acme')
  await page
    .getByRole('button', { name: 'Organization settings', exact: true })
    .click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Connector API URL')).toHaveValue(
    'https://kloud.example/api/organizations/acme',
  )
  await dialog
    .getByRole('button', { name: 'Create organization', exact: true })
    .click()
  await dialog
    .getByLabel('Organization name', { exact: true })
    .fill('New organization')
  await dialog.getByLabel('Organization slug', { exact: true }).fill('new-org')
  await dialog
    .getByLabel('Administrator username', { exact: true })
    .fill('owner')
  await dialog
    .getByLabel('Administrator password', { exact: true })
    .fill('secure-password-123')
  await dialog
    .getByRole('button', { name: 'Create organization', exact: true })
    .click()
  await expect(page).toHaveURL(/login\?organization=new-org/)
  expect(
    requests.some(
      (request) =>
        request.path === '/organizations/acme/organizations' &&
        (request.body as any)?.slug === 'new-org',
    ),
  ).toBe(true)
})

test('ordinary members can switch organizations but cannot create one', async ({
  page,
}) => {
  await organizationFixtures(page, false)
  await page.goto('/?organization=acme')
  await page
    .getByRole('button', { name: 'Organization settings', exact: true })
    .click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('button', { name: 'Switch organization' }),
  ).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: 'Create organization' }),
  ).toHaveCount(0)
})
