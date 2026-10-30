import { test, expect } from '@playwright/test'

test('QuickTip wraps text and SVG roots and opens on hover and keyboard focus', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/quick-tip.html')
  const triggers = [
    {
      locator: page.getByText('Plain text', { exact: true }),
      content: 'Text tooltip',
    },
    {
      locator: page.getByRole('img', { name: 'Raw SVG' }).locator('..'),
      content: 'SVG tooltip',
    },
    {
      locator: page.getByRole('img', { name: 'Lucide icon' }).locator('..'),
      content: 'Lucide tooltip',
    },
  ]
  for (const { locator, content } of triggers) {
    expect(await locator.evaluate((element) => element.tagName)).toBe('SPAN')
    await locator.hover()
    await expect(page.getByRole('tooltip')).toHaveText(content)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.mouse.move(0, 0)
    await locator.focus()
    await expect(page.getByRole('tooltip')).toHaveText(content)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  }
  const link = page.getByRole('link', { name: 'Native link' })
  await link.focus()
  await expect(page.getByRole('tooltip')).toHaveText('Link tooltip')
  await expect(link).toHaveAttribute('data-state', 'instant-open')
})

test('disabled sidebar actions use QuickTip with a focusable wrapper', async ({
  page,
}) => {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const data: Record<string, unknown> = {
      '/api/auth/me': { id: 'owner', username: 'owner', admin: true },
      '/api/projects': [],
      '/api/admin/users': [],
    }
    return route.fulfill({ json: data[path] ?? { ok: true } })
  })
  await page.goto('/admin/users')
  const action = page.getByRole('button', { name: 'Builds', exact: true })
  await expect(action).toBeDisabled()
  await action.locator('..').hover()
  await expect(page.getByRole('tooltip')).toHaveText('Coming in a later update')
  await page.keyboard.press('Escape')
  await action.locator('..').focus()
  await expect(page.getByRole('tooltip')).toHaveText('Coming in a later update')
  await expect(page.locator('[title]')).toHaveCount(0)
})
