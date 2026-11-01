import { test, expect } from '@playwright/test'

test('failed GitHub conversion displays its specific error and renews generated names while preserving custom names', async ({
  page,
  context,
}) => {
  const error =
    'GitHub returned an incomplete app configuration (pem). Start again with a new app name.'
  await context.route('https://github.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<script>location.replace("http://localhost:5175/github-error-fixture")</script>',
    }),
  )
  await context.route('**/github-error-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<script>window.opener.postMessage({type:"kloud-github-app",state:"manifest-state",code:"manifest-code"},"http://localhost:5175")</script>',
    }),
  )
  await context.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    let json: any = []
    if (path === '/api/auth/me')
      json = { id: 'owner', username: 'Owner', admin: true }
    else if (path === '/api/projects') json = [{ slug: 'demo', name: 'Demo' }]
    else if (path === '/api/projects/demo/applications/web')
      json = { name: 'Web', type: 'application', can_deploy: true }
    else if (path.endsWith('/deployment')) json = null
    else if (path.endsWith('/configuration')) json = { revisions: [], runs: [] }
    else if (path.endsWith('/github-app/start'))
      json = {
        state: 'manifest-state',
        action: 'https://github.com/settings/apps/new?state=manifest-state',
        manifest: {
          redirect_url: 'http://localhost:5175/api/git/github/callback',
        },
      }
    else if (path.endsWith('/github-app/finish'))
      return route.fulfill({ status: 502, json: { error } })
    return route.fulfill({ json })
  })
  await page.goto('/projects/demo/applications/web?setup=repository')
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click()
  const name = page.getByLabel('GitHub App name', { exact: true })
  const initial = await name.inputValue()
  await page
    .getByRole('button', { name: 'Create GitHub App', exact: true })
    .click()
  await expect(page.getByText(error, { exact: true })).toBeVisible()
  await expect(name).not.toHaveValue(initial)
  await expect(name).toHaveValue(/^Kloud-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/)
  await name.fill('My custom app')
  await page
    .getByRole('button', { name: 'Create GitHub App', exact: true })
    .click()
  await expect(page.getByText(error, { exact: true })).toBeVisible()
  await expect(name).toHaveValue('My custom app')
})
