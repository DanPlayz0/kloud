import { test, expect } from '@playwright/test'

test('deployment setup preserves the one-time secret through refresh, shows history, and rotates secrets', async ({
  page,
}, testInfo) => {
  const path = '/api/projects/demo/applications/web/deployment'
  let deployment: any = null
  let fail = false
  const container = {
    connector_id: '00000000-0000-4000-8000-000000000001',
    connector_name: 'Production',
    container_id: 'a'.repeat(64),
    application: 'web',
    project: 'demo',
    data: { name: 'web' },
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url()).pathname
    if (url === path) {
      if (request.method() === 'PUT') {
        if (fail)
          return route.fulfill({
            status: 409,
            json: {
              error:
                'Wait for the running deployment before changing configuration',
            },
          })
        deployment = {
          id: 'deployment',
          config: request.postDataJSON(),
          webhook_url: 'https://dashboard.example/api/hooks/github/deployment',
          builds: [],
        }
        return route.fulfill({
          json: { ...deployment, webhook_secret: 'one-time-secret' },
        })
      }
      if (request.method() === 'POST')
        return route.fulfill({ json: { webhook_secret: 'rotated-secret' } })
      return route.fulfill({ json: deployment })
    }
    const fixtures: Record<string, unknown> = {
      '/api/auth/me': {
        id: 'admin',
        username: 'admin',
        admin: true,
        capabilities: [],
      },
      '/api/projects': [{ slug: 'demo', name: 'Demo' }],
      '/api/projects/demo/containers': [container],
      '/api/projects/demo/applications/web': { slug: 'web' },
    }
    return route.fulfill({ json: fixtures[url] ?? { ok: true } })
  })
  await page.goto('/projects/demo/applications/web')
  await expect(
    page.getByRole('heading', { name: 'web deployments' }),
  ).toBeVisible()
  await page.getByLabel('GitHub repository (owner/repo)').fill('owner/repo')
  await page
    .getByRole('button', { name: 'Save deployment', exact: true })
    .click()
  await expect(
    page.getByLabel('Secret — copy now; it is only shown once'),
  ).toHaveValue('one-time-secret')
  await expect(page.getByLabel('Payload URL')).toHaveValue(
    'https://dashboard.example/api/hooks/github/deployment',
  )
  deployment.builds = [
    {
      id: 'build',
      commit: 'a'.repeat(40),
      status: 'succeeded',
      created: '2026-10-30T12:00:00Z',
      log: 'Build completed successfully',
    },
  ]
  await expect(page.getByText('succeeded', { exact: false })).toBeVisible({
    timeout: 10000,
  })
  await expect(
    page.getByLabel('Secret — copy now; it is only shown once'),
  ).toHaveValue('one-time-secret')
  await page.getByText('succeeded', { exact: false }).click()
  await expect(page.getByText('Build completed successfully')).toBeVisible()
  await page
    .getByRole('button', { name: 'Generate new webhook secret' })
    .click()
  await expect(
    page.getByLabel('Secret — copy now; it is only shown once'),
  ).toHaveValue('rotated-secret')
  await page.getByLabel('Build type').selectOption('compose')
  await expect(page.getByLabel('Build file (repository-relative)')).toHaveValue(
    'compose.yaml',
  )
  await expect(
    page.getByLabel('Compose service', { exact: true }),
  ).toBeVisible()
  fail = true
  await page
    .getByRole('button', { name: 'Save deployment', exact: true })
    .click()
  await expect(
    page.getByText(
      'Wait for the running deployment before changing configuration',
    ),
  ).toBeVisible()
  await expect(page.getByLabel('GitHub repository (owner/repo)')).toHaveValue(
    'owner/repo',
  )
  await page.screenshot({
    path: testInfo.outputPath('deployments-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.getByRole('button', { name: 'Save deployment', exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('deployments-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  })
})
