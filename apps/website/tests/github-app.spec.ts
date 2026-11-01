import { test, expect } from '@playwright/test'

test('GitHub App creation returns to service setup for repository and branch selection', async ({
  page,
  context,
}) => {
  let connected = false
  const finishes: any[] = []
  let manifest: any
  await context.route('https://github.com/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/settings/apps/new')) {
      manifest = JSON.parse(
        new URLSearchParams(route.request().postData()!).get('manifest')!,
      )
    }
    const phase = url.pathname.includes('/installations/')
      ? 'install'
      : 'manifest'
    await route.fulfill({
      contentType: 'text/html',
      body: `<script>location.replace(${JSON.stringify(`http://localhost:5175/github-fixture?phase=${phase}&state=${url.searchParams.get('state')}`)})</script>`,
    })
  })
  await context.route('**/github-fixture?**', (route) => {
    const url = new URL(route.request().url())
    const data = {
      type: 'kloud-github-app',
      state: url.searchParams.get('state'),
      ...(url.searchParams.get('phase') === 'manifest'
        ? { code: 'manifest-code' }
        : { installation_id: '456', setup_action: 'install' }),
    }
    return route.fulfill({
      contentType: 'text/html',
      body: `<script>window.opener.postMessage(${JSON.stringify(data)},'http://localhost:5175')</script>`,
    })
  })
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname
    let json: any = []
    if (path === '/api/auth/me')
      json = { id: 'owner', username: 'Owner', admin: true }
    else if (path === '/api/projects') json = [{ slug: 'demo', name: 'Demo' }]
    else if (path === '/api/projects/demo/applications/web')
      json = { slug: 'web', name: 'Web', type: 'application', can_deploy: true }
    else if (path.endsWith('/deployment')) json = null
    else if (path.endsWith('/configuration')) json = { revisions: [], runs: [] }
    else if (path.endsWith('/github-app/start')) {
      expect(req.postDataJSON()).toMatchObject({
        service: 'web',
        name: 'My Kloud',
        organization: 'my-org',
      })
      json = {
        state: 'manifest-state',
        action:
          'https://github.com/organizations/my-org/settings/apps/new?state=manifest-state',
        manifest: {
          name: 'My Kloud',
          redirect_url: 'http://localhost:5175/api/git/github/callback',
        },
      }
    } else if (path.endsWith('/github-app/finish')) {
      const body = req.postDataJSON()
      finishes.push(body)
      if (body.code)
        json = {
          state: 'install-state',
          install_url:
            'https://github.com/apps/my-kloud/installations/new?state=install-state',
        }
      else {
        connected = true
        json = { id: 'connection' }
      }
    } else if (path.endsWith('/git-connections'))
      json = connected
        ? [
            {
              id: 'connection',
              name: 'My Kloud',
              provider: 'github_app',
              origin: 'https://github.com',
              owner: 'owner',
              identity: { account: 'my-org', installation_id: 456 },
            },
          ]
        : []
    else if (path.endsWith('/repositories'))
      json = {
        repositories: [
          {
            id: 'repo',
            name: 'my-org/web',
            url: 'https://github.com/my-org/web',
            default_branch: 'main',
            private: true,
          },
        ],
        next_page: null,
      }
    else if (path.endsWith('/branches'))
      json = {
        branches: [
          { name: 'main', commit: 'a'.repeat(40) },
          { name: 'production', commit: 'b'.repeat(40) },
        ],
        next_page: null,
      }
    return route.fulfill({ json })
  })
  await page.goto('/projects/demo/applications/web?setup=repository')
  await expect(page.getByLabel('Setup method')).toHaveValue('app')
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click()
  await expect(page.getByLabel('GitHub App ID', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('App private key (PEM)')).toHaveCount(0)
  await expect(page.getByLabel('GitHub App name', { exact: true })).toHaveValue(
    /^Kloud-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/,
  )
  await page.getByLabel('GitHub App name', { exact: true }).fill('My Kloud')
  await page.getByLabel('GitHub organization (optional)').fill('my-org')
  await page
    .getByRole('button', { name: 'Create GitHub App', exact: true })
    .click()
  await expect(page.getByLabel('Installation / account')).toHaveValue(
    'connection',
  )
  expect(manifest.name).toBe('My Kloud')
  expect(finishes).toEqual([
    { service: 'web', state: 'manifest-state', code: 'manifest-code' },
    {
      service: 'web',
      state: 'install-state',
      installation_id: 456,
      setup_action: 'install',
    },
  ])
  await page
    .getByRole('button', { name: 'Load repositories', exact: true })
    .click()
  await page.getByLabel('Repository', { exact: true }).selectOption('repo')
  await expect(
    page.getByText('Selected: my-org/web · main', { exact: true }),
  ).toBeVisible()
  await page
    .getByLabel('Branch', { exact: true })
    .first()
    .selectOption('production')
  await expect(
    page.getByText('Selected: my-org/web · production', { exact: true }),
  ).toBeVisible()
})
