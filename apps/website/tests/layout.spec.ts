import { test, expect, type Page } from '@playwright/test'

const project = { slug: 'layout-project', name: 'Project-' + 'a'.repeat(90) }
const owner = {
  id: 'layout-owner',
  username: 'owner-' + 'b'.repeat(90),
  admin: true,
}
const row = {
  connector_id: 'host',
  connector_name: 'Host-' + 'c'.repeat(90),
  host: 'docker-' + 'd'.repeat(160),
  seen: new Date().toISOString(),
  stale: false,
  container_id: 'a'.repeat(64),
  project: null,
  application: null,
  assignment: null,
  data: {
    name: 'container-' + 'e'.repeat(180),
    state: 'running',
    cpu: null,
    memory: null,
    memoryLimit: null,
  },
}

async function fixtures(page: Page) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const data: Record<string, unknown> = {
      '/api/auth/setup': { required: true },
      '/api/auth/me': owner,
      '/api/projects': [project],
      '/api/connectors': [],
      [`/api/projects/${project.slug}/databases`]: {
        resources: [],
        can_create: false,
        can_restore: false,
        can_destinations: false,
        can_manage_access: false,
      },
      [`/api/projects/${project.slug}/databases/hosts/list`]: [],
      [`/api/projects/${project.slug}/databases/destinations/list`]: [],
      '/api/admin/projects': [project],
      '/api/admin/pm2': [],
      '/api/admin/containers/projects': [project],
      '/api/admin/users': [
        { ...owner, disabled: false, enrolled: true, projects: [project.slug] },
      ],
      '/api/admin/connectors': [
        {
          id: 'host',
          name: row.connector_name,
          host: row.host,
          discovery: true,
          revoked: false,
          stale: false,
        },
      ],
      '/api/admin/containers': [
        row,
        {
          ...row,
          container_id: 'b'.repeat(64),
          project: project.slug,
          application: 'application-' + 'f'.repeat(80),
          assignment: 'label',
        },
      ],
    }
    return route.fulfill({ json: data[path] ?? { ok: true } })
  })
}

for (const width of [390, 1280]) {
  test(`databases retain project navigation under Storage at ${width}px`, async ({
    page,
  }) => {
    await fixtures(page)
    await page.setViewportSize({ width, height: 840 })
    await page.goto(`/projects/${project.slug}/compute/serverless`)
    if (width < 720)
      await page.getByRole('button', { name: 'Toggle navigation' }).click()
    const storage = page.locator('.nav-group').filter({
      has: page.getByText('STORAGE', { exact: true }),
    })
    await storage.getByRole('link', { name: 'Databases', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'PostgreSQL', exact: true }),
    ).toBeVisible()
    await expect(page.locator('.topbar')).toHaveText('StorageDatabasesKLOUD')
    if (width < 720)
      await page.getByRole('button', { name: 'Toggle navigation' }).click()
    await expect(
      page.getByRole('navigation', { name: 'Main navigation' }),
    ).toBeVisible()
    await expect(
      storage.getByRole('link', { name: 'Databases', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    const compute = page.locator('.nav-group').filter({
      has: page.getByText('COMPUTE', { exact: true }),
    })
    await expect(
      compute.getByRole('link', { name: 'Databases', exact: true }),
    ).toHaveCount(0)
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Databases', exact: true }),
    ).toHaveCount(1)
  })
}

async function expectContained(page: Page, selector: string) {
  const violations = await page.locator(selector).evaluateAll((elements) =>
    elements.flatMap((el) => {
      const box = el.getBoundingClientRect()
      return [
        ...el.querySelectorAll('input,select,button,a,strong,small'),
      ].flatMap((child) => {
        if (
          !(child instanceof HTMLElement) ||
          !child.getClientRects().length ||
          child.closest('.sr-only')
        )
          return []
        const r = child.getBoundingClientRect()
        return r.left < box.left - 1 ||
          r.right > box.right + 1 ||
          r.top < box.top - 1 ||
          r.bottom > box.bottom + 1
          ? [`${el.className}: ${child.tagName} extends beyond its container`]
          : []
      })
    }),
  )
  expect(violations).toEqual([])
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
}

for (const width of [320, 390, 768, 1280]) {
  test(`cards contain controls and long content at ${width}px`, async ({
    page,
  }, testInfo) => {
    await fixtures(page)
    await page.setViewportSize({ width, height: 840 })
    await page.goto('/login')
    await expect(
      page.getByRole('heading', {
        name: 'Create your Server Administrator account',
      }),
    ).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('setup-card.png'),
      fullPage: true,
    })
    await expectContained(page, '.auth-card')
    await page.goto('/enroll#' + 't'.repeat(43))
    await expect(
      page.getByRole('heading', { name: 'Set up your account' }),
    ).toBeVisible()
    await expectContained(page, '.auth-card')
    for (const section of ['projects', 'users', 'connectors', 'containers']) {
      await page.goto(`/admin/${section}`)
      if (section === 'users') {
        await expect(page.getByRole('table')).toBeVisible()
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width)
        continue
      }
      await expect(
        page
          .locator(section === 'containers' ? '.inventory-card' : '.admin-row')
          .first(),
      ).toBeVisible()
      await expectContained(page, '.admin-row,.inline-form,.inventory-card')
      if (section === 'containers') {
        for (const control of await page
          .locator('.inventory-card-form input,.inventory-card-form select')
          .all()) {
          expect(
            await control.evaluate((el) => el.getBoundingClientRect().width),
          ).toBeGreaterThanOrEqual(160)
        }
      }
    }
    await page.screenshot({
      path: testInfo.outputPath('inventory-cards.png'),
      fullPage: true,
    })
    if (width < 720)
      await page.getByRole('button', { name: 'Toggle navigation' }).click()
    await page.getByRole('button', { name: new RegExp(owner.username) }).click()
    await expect(
      page.getByRole('button', { name: 'Sign out', exact: true }),
    ).toBeVisible()
    await expectContained(page, '.account-menu,.account-button')
    await page.goto('/login')
    expect(
      await page
        .locator('.auth-card')
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft)),
    ).toBeGreaterThanOrEqual(16)
  })
}
