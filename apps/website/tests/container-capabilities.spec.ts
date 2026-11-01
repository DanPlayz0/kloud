import { test, expect, type Page } from '@playwright/test'
const connector = '11111111-1111-4111-8111-111111111111',
  container = 'a'.repeat(64)
async function fixtures(page: Page, configuration = true) {
  const requests: unknown[] = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4)
    if (path.endsWith('/logs'))
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"output":"container log"}\n\n',
      })
    if (path.endsWith('/operation')) {
      const body = route.request().postDataJSON()
      requests.push(body)
      return route.fulfill({
        json:
          body.action === 'inspect'
            ? {
                settings: {
                  cpus: 1,
                  memory_mib: 128,
                  restart_policy: 'no',
                  retry_count: 0,
                },
              }
            : { ok: true },
      })
    }
    return route.fulfill({
      json:
        path === '/auth/me'
          ? { id: 'member', username: 'member', admin: false, capabilities: [] }
          : path === '/projects'
            ? [{ slug: 'alpha', name: 'Alpha', role: 'member' }]
            : path.endsWith('/containers')
              ? [
                  {
                    connector_id: connector,
                    connector_name: 'Host',
                    container_id: container,
                    project: 'alpha',
                    application: 'web',
                    assignment: 'manual',
                    stale: false,
                    data: {
                      name: 'web',
                      state: 'running',
                      cpu: 0,
                      memory: 0,
                      memoryLimit: 0,
                    },
                  },
                ]
              : path.endsWith('/permissions')
                ? {
                    available: true,
                    logs: true,
                    lifecycle: false,
                    terminal: false,
                    configuration,
                  }
                : path.endsWith('/services')
                  ? { services: [], can_create: false }
                  : [],
    })
  })
  return requests
}
test('configuration grants expose bounded live settings while lifecycle and shell remain unavailable', async ({
  page,
}) => {
  const requests = await fixtures(page)
  await page.goto('/projects/alpha/compute/containers')
  await page
    .getByRole('row')
    .filter({ has: page.getByText('web', { exact: true }) })
    .click()
  await expect(
    page.getByRole('button', { name: 'Shell', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'restart', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Configuration', exact: true }).click()
  await page.getByLabel('CPU limit', { exact: true }).fill('1.5')
  await page.getByLabel('Memory limit (MiB)', { exact: true }).fill('256')
  await page
    .getByLabel('Restart policy', { exact: true })
    .selectOption('on-failure')
  await page.getByLabel('Maximum retries', { exact: true }).fill('3')
  await page.getByRole('button', { name: 'Save container settings' }).click()
  await expect(page.getByRole('status')).toContainText(
    'Container settings saved.',
  )
  expect(requests).toContainEqual({
    action: 'update',
    settings: {
      cpus: 1.5,
      memory_mib: 256,
      restart_policy: 'on-failure',
      retry_count: 3,
    },
  })
})
test('configuration controls stay disabled without the precise capability', async ({
  page,
}) => {
  await fixtures(page, false)
  await page.goto('/projects/alpha/compute/containers')
  await page
    .getByRole('row')
    .filter({ has: page.getByText('web', { exact: true }) })
    .click()
  await expect(
    page.getByRole('button', { name: 'Configuration', exact: true }),
  ).toBeDisabled()
})
