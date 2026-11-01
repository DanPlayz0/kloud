import { test, expect, type Page } from '@playwright/test'

const hostId = '11111111-1111-4111-8111-111111111111'
const appId = '22222222-2222-4222-8222-222222222222'
const containerId = 'a'.repeat(64)
const base = '/connectors/' + hostId
const project = {
  slug: 'alpha',
  name: 'Alpha project',
  role: 'admin',
  can_manage_access: true,
}
async function fixtures(
  page: Page,
  capabilities = ['connectors.operate'],
  admin = false,
) {
  const operations: { path: string; action: string }[] = []
  const assignments: { path: string; value: unknown }[] = []
  const connector = {
    id: hostId,
    name: 'Production host',
    host: 'docker.example',
    seen: new Date().toISOString(),
    stale: false,
    discovery: true,
    revoked: false,
    capabilities: ['runtime', 'pm2', 'host-terminal'],
  }
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4)
    const body =
      route.request().method() === 'POST'
        ? route.request().postDataJSON()
        : undefined
    if (
      route.request().method() === 'PUT' &&
      path.startsWith('/admin/containers/')
    ) {
      assignments.push({ path, value: route.request().postDataJSON() })
      return route.fulfill({ json: { ok: true } })
    }
    const allowed = admin || capabilities.includes('connectors.operate')
    if (path.endsWith('/logs'))
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          'data: ' +
          JSON.stringify({ output: 'hello from host', unavailable: false }) +
          '\n\n',
      })
    if (path.endsWith('/operation') || path.endsWith('/terminal')) {
      operations.push({ path, action: body.action })
      return route.fulfill({
        json:
          body.action === 'terminal-open'
            ? { session: appId }
            : body.action === 'inspect'
              ? { image: 'nginx:latest' }
              : path.includes('/pm2/')
                ? { results: [{ id: 0, ok: true }] }
                : { output: '', ok: true },
      })
    }
    const containers = [
      {
        connector_id: hostId,
        connector_name: connector.name,
        host: connector.host,
        seen: new Date().toISOString(),
        stale: connector.stale,
        container_id: containerId,
        project: 'alpha',
        application: 'web',
        assignment: 'manual',
        data: {
          name: 'web',
          state: 'running',
          cpu: 2,
          memory: 1048576,
          memoryLimit: 104857600,
        },
      },
      {
        connector_id: hostId,
        connector_name: connector.name,
        host: connector.host,
        seen: new Date().toISOString(),
        stale: connector.stale,
        container_id: 'b'.repeat(64),
        project: null,
        application: null,
        assignment: null,
        data: {
          name: 'unassigned-worker',
          state: 'running',
          cpu: null,
          memory: null,
          memoryLimit: null,
        },
      },
    ]
    const data =
      path === '/auth/me'
        ? { id: 'owner', username: 'operator', admin, capabilities }
        : path === '/projects' || path === '/admin/containers/projects'
          ? [project]
          : path === '/connectors' || path === '/admin/connectors'
            ? [connector]
            : path === base
              ? connector
              : path.endsWith('/permissions')
                ? {
                    available: allowed && !connector.stale,
                    view: true,
                    logs: allowed,
                    lifecycle: allowed,
                    terminal: allowed,
                    configuration: allowed,
                    manage: allowed,
                    delete: allowed,
                  }
                : path.endsWith('/containers')
                  ? containers
                  : path === base + '/pm2'
                    ? [
                        {
                          id: appId,
                          connector_id: hostId,
                          connector_name: connector.name,
                          host: connector.host,
                          seen: new Date().toISOString(),
                          stale: connector.stale,
                          present: true,
                          project_slug: null,
                          name: 'worker',
                          namespace: 'default',
                          workers: [
                            {
                              id: 0,
                              pid: 123,
                              status: 'online',
                              mode: 'fork',
                              uptime: Date.now() - 60000,
                              cpu: 1,
                              memory: 1048576,
                              restarts: 0,
                            },
                          ],
                        },
                      ]
                    : path.endsWith('/services')
                      ? { services: [], can_create: false }
                      : { ok: true }
    return route.fulfill({ json: data })
  })
  return { operations, connector, assignments }
}

test('shared picker searches hosts and switches between project and connector workspaces with keyboard', async ({
  page,
}) => {
  await fixtures(page)
  await page.goto('/projects/alpha/compute/containers')
  const picker = page.getByRole('button', {
    name: 'Project or connector',
    exact: true,
  })
  await picker.click()
  const search = page.getByRole('combobox', {
    name: 'Search projects and connectors',
  })
  await expect(search).toBeFocused()
  await expect(page.getByRole('option')).toHaveCount(2)
  await search.fill('DOCKER.EXAMPLE')
  await expect(page.getByRole('option')).toHaveCount(1)
  await search.press('ArrowDown')
  await search.press('Enter')
  await expect(page).toHaveURL(base + '/compute/containers')
  await expect(picker).toContainText('Production host')
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Containers', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
  await expect(
    page.getByRole('columnheader', { name: 'Project', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Unassigned', { exact: true })).toBeVisible()
  await picker.click()
  await search.fill('alpha')
  await search.press('ArrowDown')
  await search.press('Enter')
  await expect(page).toHaveURL('/projects/alpha/services')
})

test('direct URLs reuse container and PM2 operation dialogs with connector APIs', async ({
  page,
}) => {
  const { operations } = await fixtures(page)
  await page.goto(base + '/compute/containers')
  await page.getByRole('button', { name: 'Manage web', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('hello from host')
  await dialog.getByRole('button', { name: 'restart', exact: true }).click()
  await expect
    .poll(() =>
      operations.some(
        (o) =>
          o.path === base + '/containers/' + containerId + '/operation' &&
          o.action === 'restart',
      ),
    )
    .toBe(true)
  await dialog.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(dialog).toContainText('nginx:latest')
  await dialog.getByRole('button', { name: 'Shell', exact: true }).click()
  await expect
    .poll(() => operations.some((o) => o.action === 'terminal-open'))
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect
    .poll(() => operations.some((o) => o.action === 'terminal-close'))
    .toBe(true)
  await page.goto(base + '/compute/pm2')
  await page.getByRole('button', { name: 'Open worker', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'restart', exact: true })
    .click()
  await expect
    .poll(() =>
      operations.some(
        (o) =>
          o.path === base + '/pm2/' + appId + '/operation' &&
          o.action === 'restart',
      ),
    )
    .toBe(true)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'delete', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Confirm delete' }),
  ).toBeVisible()
  expect(operations.some((o) => o.action === 'delete')).toBe(false)
})

test('container rows open shared dialogs with keyboard focus restored on close', async ({
  page,
}) => {
  await fixtures(page)
  await page.goto(base + '/compute/containers')
  const trigger = page.getByRole('button', { name: 'Manage web', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'web', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close container details' }).click()
  await expect(trigger).toBeFocused()
  await page
    .getByRole('row')
    .filter({ has: trigger })
    .getByText('2.0%', { exact: true })
    .click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.getByRole('link', { name: 'Alpha project', exact: true }).click()
  await expect(page).toHaveURL('/projects/alpha/compute/containers')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('inventory browsing does not grant actions or host controls', async ({
  page,
}) => {
  await fixtures(page, ['inventory.manage'])
  await page.goto(base + '/compute/containers')
  await page.getByRole('button', { name: 'Manage web', exact: true }).click()
  await expect(
    page
      .getByRole('dialog')
      .getByRole('button', { name: 'restart', exact: true }),
  ).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.goto(base + '/overview')
  await expect(
    page.getByRole('heading', { name: 'Production host' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Host terminal', exact: true }),
  ).toHaveCount(0)
})

test('connector managers land on overview and retain host administration controls', async ({
  page,
}) => {
  const { operations } = await fixtures(page, ['connectors.manage'])
  await page.goto(base + '/compute/containers')
  await expect(page).toHaveURL(base + '/overview')
  await expect(
    page.getByRole('checkbox', { name: 'Discover unassigned containers' }),
  ).toBeChecked()
  await page.getByRole('button', { name: 'Host terminal', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'Host terminal — Production host' }),
  ).toBeVisible()
  await expect
    .poll(() =>
      operations.some(
        (o) => o.path === '/admin/connectors/' + hostId + '/terminal',
      ),
    )
    .toBe(true)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.goto('/admin/connectors')
  await page.getByRole('link', { name: 'Open connector', exact: true }).click()
  await expect(page).toHaveURL(base + '/overview')
})

for (const width of [390, 1280]) {
  test(
    'connector navigation and tables fit at ' + width + 'px',
    async ({ page }, testInfo) => {
      await fixtures(page)
      await page.setViewportSize({ width, height: 900 })
      await page.goto(base + '/compute/containers')
      await expect(
        page.getByRole('heading', { name: 'Containers', exact: true }),
      ).toBeVisible()
      expect(
        await page
          .getByRole('table')
          .evaluate((table) => table.getBoundingClientRect().width),
      ).toBeGreaterThanOrEqual(640)
      expect(
        await page
          .getByRole('columnheader', { name: 'Container', exact: true })
          .evaluate((cell) => cell.getBoundingClientRect().width),
      ).toBeGreaterThanOrEqual(160)
      if (width < 720)
        await page.getByRole('button', { name: 'Toggle navigation' }).click()
      await page
        .getByRole('button', { name: 'Project or connector', exact: true })
        .click()
      await expect(
        page.getByRole('dialog', { name: 'Select project or connector' }),
      ).toHaveAttribute('data-side', width < 720 ? 'bottom' : 'right')
      await page.keyboard.press('Escape')
      if (width < 720) {
        await page.getByRole('button', { name: 'Toggle navigation' }).click()
        await expect(page.locator('aside.sidebar')).not.toBeInViewport()
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width)
      await page.screenshot({
        path: testInfo.outputPath('connector-' + width + '.png'),
        fullPage: true,
        animations: 'disabled',
      })
    },
  )
}

test('inventory managers assign discovered containers from the connector view', async ({
  page,
}) => {
  const { assignments } = await fixtures(page, ['inventory.manage'])
  await page.goto(base + '/compute/containers')
  await page
    .getByRole('button', { name: 'Assign to project for unassigned-worker' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Assign unassigned-worker' })
  await dialog.getByLabel('Project', { exact: true }).selectOption('alpha')
  await dialog.getByLabel('Application slug', { exact: true }).fill('worker')
  await dialog.getByRole('button', { name: 'Assign', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(assignments).toEqual([
    {
      path: '/admin/containers/' + hostId + '/' + 'b'.repeat(64),
      value: { project: 'alpha', application: 'worker' },
    },
  ])
  await page.getByRole('button', { name: 'Change assignment for web' }).click()
  await page
    .getByRole('dialog', { name: 'Assign web' })
    .getByRole('button', { name: 'Unassign', exact: true })
    .click()
  expect(assignments.at(-1)?.value).toBeNull()
})

test('runtime operators cannot assign containers', async ({ page }) => {
  await fixtures(page, ['connectors.operate'])
  await page.goto(base + '/compute/containers')
  await expect(
    page.getByRole('button', { name: /Assign to project|Change assignment/ }),
  ).toHaveCount(0)
})
