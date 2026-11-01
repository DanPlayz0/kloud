import { test, expect, type Page } from '@playwright/test'

const owner = {
  id: 'owner-id',
  username: 'owner',
  email: 'owner@example.com',
  admin: true,
  capabilities: [],
}
async function fixtures(
  page: Page,
  options: {
    invitedEmail?: string
    signedIn?: boolean
    existing?: boolean
  } = {},
) {
  const calls: { path: string; method: string; body?: unknown }[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    const path = url.pathname
      .slice(4)
      .replace(/^\/organizations\/default(?=\/)/, '')
    const method = request.method()
    const body = ['POST', 'PUT', 'PATCH'].includes(method)
      ? request.postDataJSON()
      : undefined
    calls.push({ path, method, body })
    if (path === '/auth/me' && options.signedIn === false)
      return route.fulfill({
        status: 401,
        json: { error: 'Authentication required' },
      })
    const data =
      path === '/auth/me'
        ? owner
        : path === '/projects'
          ? [{ slug: 'demo', name: 'Demo project', can_manage_access: true }]
          : path === '/organizations'
            ? [{ slug: 'default', name: 'Default organization', admin: true }]
            : path === '/organizations/current'
              ? { slug: 'default', name: 'Default organization' }
              : path === '/admin/users' && method === 'GET'
                ? [{ ...owner, disabled: false, enrolled: true, projects: [] }]
                : path === '/admin/users'
                  ? { enrollmentUrl: 'http://localhost:5174/enroll#new-token' }
                  : path === '/auth/invitation'
                    ? {
                        email: options.invitedEmail ?? owner.email,
                        existing_account: options.existing ?? true,
                        organization: {
                          slug: 'default',
                          name: 'Example organization',
                        },
                      }
                    : path === '/auth/security'
                      ? {
                          methods: [],
                          email: null,
                          emailAvailable: false,
                          totpAvailable: false,
                          passkeyAvailable: false,
                          passkeys: [],
                          recoveryCodesRemaining: 0,
                        }
                      : path === '/auth/profile'
                        ? { email: 'new@example.com', username: 'owner' }
                        : path === '/projects/demo/access'
                          ? { grant_mode: 'id', members: [] }
                          : path === '/projects/demo/services'
                            ? { services: [], can_create: false }
                            : path === '/projects/demo/containers'
                              ? []
                              : {}
    return route.fulfill({ json: data })
  })
  return calls
}

test('organization administrators invite an email without creating another password identity', async ({
  page,
}) => {
  const calls = await fixtures(page)
  await page.goto('/admin/users')
  await expect(page.getByText(owner.email, { exact: true })).toBeVisible()
  await expect(page.getByLabel('Reset enrollment for owner')).toHaveCount(0)
  await page.getByRole('button', { name: 'Invite user', exact: true }).click()
  await page
    .getByLabel('Email address', { exact: true })
    .fill('member@example.com')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Invite user', exact: true })
    .click()
  await expect
    .poll(
      () =>
        calls.find(
          (call) => call.path === '/admin/users' && call.method === 'POST',
        )?.body,
    )
    .toMatchObject({ email: 'member@example.com' })
  expect(
    calls.find((call) => call.path === '/admin/users' && call.method === 'POST')
      ?.body,
  ).not.toHaveProperty('password')
})

test('an existing account accepts an organization invitation without changing its password', async ({
  page,
}) => {
  const calls = await fixtures(page)
  await page.goto('/enroll#existing-token')
  await expect(
    page.getByRole('heading', { name: 'Join organization' }),
  ).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Accept invitation', exact: true })
    .click()
  await expect(
    page.getByText(
      'Your account now has access to this organization. Your password and security settings are unchanged.',
    ),
  ).toBeVisible()
  expect(
    calls.find((call) => call.path === '/auth/invitations/accept')?.body,
  ).toEqual({ token: 'existing-token' })
  expect(calls.some((call) => call.path === '/auth/enroll')).toBe(false)
})

test('an invitation for another email requires the matching account', async ({
  page,
}) => {
  await fixtures(page, { invitedEmail: 'member@example.com' })
  await page.goto('/enroll#other-account-token')
  await expect(
    page.getByRole('button', { name: 'Sign in to accept invitation' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Accept invitation', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByText(
      'You are signed in as owner@example.com. Sign in with the invited account to continue.',
    ),
  ).toBeVisible()
})

test('profile email changes require the current account password', async ({
  page,
}) => {
  const calls = await fixtures(page)
  await page.goto('/account/security')
  await page
    .getByLabel('Account email address', { exact: true })
    .fill('new@example.com')
  await page
    .getByLabel('Current password for account email', { exact: true })
    .fill('the current account password')
  await page
    .getByRole('button', { name: 'Save account email', exact: true })
    .click()
  await expect
    .poll(() => calls.find((call) => call.path === '/auth/profile')?.body)
    .toEqual({
      email: 'new@example.com',
      password: 'the current account password',
    })
  await expect(
    page.getByText(
      'Account email updated. Your organization memberships are unchanged.',
    ),
  ).toBeVisible()
})

test('project administrators invite a shared account by email with project-scoped grants', async ({
  page,
}) => {
  const calls = await fixtures(page)
  await page.goto('/projects/demo/access')
  await page
    .getByRole('button', { name: 'Invite or add member', exact: true })
    .click()
  const dialog = page.getByRole('dialog')
  await dialog
    .getByLabel('Email address', { exact: true })
    .fill('project-member@example.com')
  await dialog
    .getByRole('button', { name: 'Invite or add member', exact: true })
    .click()
  await expect
    .poll(
      () =>
        calls.find((call) => call.path === '/projects/demo/access/members')
          ?.body,
    )
    .toMatchObject({
      email: 'project-member@example.com',
      role: 'member',
      grants: [],
    })
  expect(
    calls.find((call) => call.path === '/projects/demo/access/members')?.body,
  ).not.toHaveProperty('username')
})
