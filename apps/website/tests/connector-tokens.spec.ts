import { test, expect } from '@playwright/test'

test('connector overview displays the replacement token after rotation', async ({
  page,
}) => {
  const host = {
    id: 'overview-host',
    name: 'Overview host',
    discovery: true,
    revoked: false,
    stale: true,
    capabilities: [],
    seen: null,
    dns_targets: { ipv4: null, ipv6: null },
    private_addresses: [],
    public_addresses: { ipv4: null, ipv6: null },
  }
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const data: Record<string, unknown> = {
      '/api/auth/setup': { required: false },
      '/api/auth/me': { id: 'owner', username: 'owner', admin: true },
      '/api/projects': [],
      '/api/connectors': [host],
      '/api/connectors/overview-host': host,
      '/api/admin/connectors/overview-host/rotate': {
        id: host.id,
        token: 'overview-secret',
      },
    }
    return route.fulfill({ json: data[path] ?? {} })
  })
  await page.goto('/connectors/overview-host/overview')
  await page.getByRole('button', { name: 'Rotate token', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Rotate token', exact: true })
    .click()
  await expect(page.getByRole('alertdialog')).not.toBeVisible()
  await expect(page.getByLabel('Connector token', { exact: true })).toHaveValue(
    'overview-secret',
  )
  await expect(
    page.getByText('Connector token rotated', { exact: true }),
  ).toBeVisible()
})

for (const width of [390, 1600]) {
  test(`connector tokens stay with their host and require confirmation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (value: string) => {
            ;(window as any).copiedToken = value
          },
        },
      })
    })
    const hosts = Array.from({ length: 12 }, (_, i) => ({
      id: `host-${i}`,
      name: `Existing ${i}`,
      discovery: true,
      revoked: false,
      stale: true,
      capabilities: [],
      host: `docker-${i}.example.test`,
    }))
    const created = { ...hosts[0]!, id: 'new-host', name: 'Newest host' }
    let revokeRequests = 0
    let rotateRequests = 0
    let failRotation = true
    await page.route('**/api/**', async (route) => {
      const { pathname } = new URL(route.request().url())
      if (
        pathname === '/api/admin/connectors' &&
        route.request().method() === 'POST'
      ) {
        hosts.push(created)
        return route.fulfill({
          status: 201,
          json: { id: created.id, token: 'new-secret' },
        })
      }
      if (pathname.endsWith('/rotate')) {
        rotateRequests++
        return failRotation
          ? route.fulfill({ status: 503, json: { error: 'Temporary failure' } })
          : route.fulfill({ json: { id: created.id, token: 'rotated-secret' } })
      }
      if (
        pathname === '/api/admin/connectors/new-host' &&
        route.request().method() === 'PUT'
      ) {
        revokeRequests++
        hosts.pop()
        return route.fulfill({ json: { ok: true } })
      }
      const data: Record<string, unknown> = {
        '/api/auth/setup': { required: false },
        '/api/auth/me': { id: 'owner', username: 'owner', admin: true },
        '/api/projects': [],
        '/api/admin/connectors': hosts,
        '/api/connectors': [],
      }
      return route.fulfill({ json: data[pathname] ?? {} })
    })
    await page.goto('/admin/connectors')
    const search = page.getByLabel('Search connectors', { exact: true })
    await search.fill(' EXISTING 10 ')
    await expect(page.locator('.admin-row')).toHaveCount(1)
    await expect(page.locator('.admin-row')).toContainText('Existing 10')
    await search.fill('DOCKER-11.EXAMPLE')
    await expect(page.locator('.admin-row')).toHaveCount(1)
    await expect(page.locator('.admin-row')).toContainText('Existing 11')
    await search.fill('unknown host')
    await expect(
      page.getByRole('heading', { name: 'No matching connectors' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Clear search' }).click()
    await expect(page.locator('.admin-row')).toHaveCount(12)
    await search.fill('Existing 10')
    await page.getByLabel('Connector name', { exact: true }).fill(created.name)
    await page
      .getByRole('button', { name: 'Create connector token', exact: true })
      .click()
    await expect(search).toHaveValue('')
    const card = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByText(created.name, { exact: true }) })
    const token = card.getByLabel('Connector token', { exact: true })
    await expect(token).toHaveValue('new-secret')
    await expect(token).toBeInViewport()
    await token.click()
    await expect
      .poll(() => page.evaluate(() => (window as any).copiedToken))
      .toBe('new-secret')
    await expect(token).not.toBeFocused()
    const copyButton = card.getByRole('button', { name: 'Copied', exact: true })
    await copyButton.click()
    await expect(copyButton).not.toBeFocused()
    await copyButton.focus()
    await copyButton.press('Enter')
    await expect(copyButton).toBeFocused()
    await card
      .getByRole('button', { name: 'Delete connector', exact: true })
      .click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('permanently invalidates its token')
    expect(revokeRequests).toBe(0)
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    expect(revokeRequests).toBe(0)
    await card
      .getByRole('button', { name: 'Rotate token', exact: true })
      .click()
    expect(rotateRequests).toBe(0)
    await dialog
      .getByRole('button', { name: 'Rotate token', exact: true })
      .click()
    await expect(dialog).toContainText('Unable to update')
    await expect(token).toHaveValue('new-secret')
    failRotation = false
    await dialog
      .getByRole('button', { name: 'Rotate token', exact: true })
      .click()
    await expect(dialog).not.toBeVisible()
    await expect(token).toHaveValue('rotated-secret')
    await expect(token).toBeInViewport()
    await expect(card).toContainText('Update CONNECTOR_TOKEN')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )
    expect(overflow).toBe(false)
    await card
      .getByRole('button', { name: 'Delete connector', exact: true })
      .click()
    await dialog
      .getByRole('button', { name: 'Delete connector', exact: true })
      .click()
    await expect(card).toHaveCount(0)
    expect(revokeRequests).toBe(1)
  })
}
