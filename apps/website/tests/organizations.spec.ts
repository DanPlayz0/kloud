import { test, expect, type Page } from '@playwright/test'

async function organizationFixtures(page: Page, admin = true) {
  const requests: { path: string; method: string; body?: any }[] = []
  const metadata: Record<
    string,
    { slug: string; name: string; description: string; website: string }
  > = {
    default: {
      slug: 'default',
      name: 'Default organization',
      description: '',
      website: '',
    },
    acme: {
      slug: 'acme',
      name: 'Acme organization',
      description: 'Our team',
      website: '',
    },
    beta: {
      slug: 'beta',
      name: 'Beta organization',
      description: '',
      website: '',
    },
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    let path = new URL(request.url()).pathname.slice(4)
    const prefix = path.match(/^\/organizations\/([^/]+)(\/.*)$/)
    const slug = prefix && prefix[1] !== 'lookup' ? prefix[1]! : 'default'
    if (prefix && prefix[1] !== 'lookup') path = prefix[2]!
    const method = request.method()
    const body = ['POST', 'PATCH'].includes(method)
      ? request.postDataJSON()
      : undefined
    requests.push({ path, method, body })
    if (path === '/organizations/current' && method === 'PATCH')
      Object.assign(metadata[slug]!, body)
    const result =
      path === '/auth/me'
        ? {
            id: 'shared-owner',
            username: 'owner',
            email: 'owner@example.com',
            admin,
            capabilities: [],
          }
        : path === '/auth/setup'
          ? { required: false }
          : path === '/organizations/current'
            ? {
                ...metadata[slug],
                api_url: `https://kloud.example/api${slug === 'default' ? '' : `/organizations/${slug}`}/`,
              }
            : path === '/organizations/invitations'
              ? {
                  email: body.email,
                  sent: false,
                  invitationUrl:
                    'https://kloud.example/enroll#invitation-token',
                }
              : path === '/organizations' && method === 'POST'
                ? { slug: body.slug ?? 'new-organization', name: body.name }
                : path === '/organizations'
                  ? Object.values(metadata).map((organization) => ({
                      ...organization,
                      admin,
                    }))
                  : []
    return route.fulfill({ json: result })
  })
  return requests
}

async function openSettings(page: Page, organization = 'acme') {
  await page.goto('/?organization=' + organization)
  await page
    .getByRole('button', { name: 'Organization settings', exact: true })
    .click()
  return page.getByRole('dialog')
}

test('one account switches between its organizations without another sign-in', async ({
  page,
}) => {
  const requests = await organizationFixtures(page)
  const dialog = await openSettings(page)
  await expect(
    dialog.getByRole('button', { name: 'Acme organization', exact: true }),
  ).toBeDisabled()
  await dialog
    .getByRole('button', { name: 'Beta organization', exact: true })
    .click()
  await expect(page).toHaveURL(/\/\?organization=beta/)
  expect(
    requests.filter((request) => request.path === '/auth/password'),
  ).toHaveLength(0)
})

test('creating an organization suggests a slug and reuses the current account', async ({
  page,
}) => {
  const requests = await organizationFixtures(page)
  const dialog = await openSettings(page)
  await dialog
    .getByRole('button', { name: 'Create organization', exact: true })
    .click()
  await dialog
    .getByLabel('Organization name', { exact: true })
    .fill('New Organization')
  await expect(
    dialog.getByLabel('Organization slug', { exact: true }),
  ).toHaveValue('new-organization')
  await expect(dialog.getByLabel('Administrator username')).toHaveCount(0)
  await expect(dialog.getByLabel('Administrator password')).toHaveCount(0)
  await dialog
    .getByRole('button', { name: 'Create organization', exact: true })
    .click()
  await expect(page).toHaveURL(/\/\?organization=new-organization/)
  const created = requests.find(
    (request) => request.path === '/organizations' && request.method === 'POST',
  )
  expect(created?.body).toEqual({
    name: 'New Organization',
    description: '',
    website: '',
  })
})

test('manually edited organization slugs survive subsequent name changes', async ({
  page,
}) => {
  const requests = await organizationFixtures(page)
  const dialog = await openSettings(page)
  await dialog
    .getByRole('button', { name: 'Create organization', exact: true })
    .click()
  await dialog
    .getByLabel('Organization name', { exact: true })
    .fill('First name')
  await dialog.getByLabel('Organization slug', { exact: true }).fill('my-team')
  await dialog
    .getByLabel('Organization name', { exact: true })
    .fill('Another name')
  await expect(
    dialog.getByLabel('Organization slug', { exact: true }),
  ).toHaveValue('my-team')
  await dialog
    .getByRole('button', { name: 'Create organization', exact: true })
    .click()
  expect(
    requests.find(
      (request) =>
        request.method === 'POST' && request.path === '/organizations',
    )?.body.slug,
  ).toBe('my-team')
})

test('default organization metadata can be edited without changing its slug', async ({
  page,
}) => {
  const requests = await organizationFixtures(page)
  const dialog = await openSettings(page, 'default')
  await dialog
    .getByRole('button', { name: 'Edit organization', exact: true })
    .click()
  await expect(
    dialog.getByLabel('Organization slug', { exact: true }),
  ).toHaveAttribute('readonly', '')
  await dialog
    .getByLabel('Organization name', { exact: true })
    .fill('Home organization')
  await dialog
    .getByLabel('Description', { exact: true })
    .fill('Our infrastructure')
  await dialog
    .getByLabel('Website', { exact: true })
    .fill('https://example.com')
  await dialog
    .getByRole('button', { name: 'Save organization', exact: true })
    .click()
  await expect(dialog.getByRole('status')).toHaveText(
    'Organization details saved.',
  )
  expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({
    name: 'Home organization',
    description: 'Our infrastructure',
    website: 'https://example.com',
  })
})

test('organization admins can invite by email and share a link when delivery is unavailable', async ({
  page,
}) => {
  const requests = await organizationFixtures(page)
  const dialog = await openSettings(page)
  await dialog
    .getByRole('button', { name: 'Invite by email', exact: true })
    .click()
  await dialog
    .getByLabel('Email address', { exact: true })
    .fill('friend@example.com')
  await dialog
    .getByRole('button', { name: 'Create invitation', exact: true })
    .click()
  await expect(dialog.getByLabel('Invitation link')).toHaveValue(
    'https://kloud.example/enroll#invitation-token',
  )
  expect(
    requests.find((request) => request.path === '/organizations/invitations')
      ?.body,
  ).toEqual({ email: 'friend@example.com', admin: false })
})

test('ordinary members can switch but cannot edit, invite, or create organizations', async ({
  page,
}) => {
  await organizationFixtures(page, false)
  const dialog = await openSettings(page)
  await expect(
    dialog.getByRole('button', { name: 'Beta organization', exact: true }),
  ).toBeVisible()
  for (const name of [
    'Create organization',
    'Edit organization',
    'Invite by email',
  ])
    await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(
      0,
    )
})
