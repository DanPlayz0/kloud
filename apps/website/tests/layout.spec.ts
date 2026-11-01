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
      [`/api/projects/${project.slug}/services`]: {
        services: [],
        can_create: true,
      },
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

for (const width of [390, 1600]) {
  test(`connector forms and actions preserve their responsive row layout at ${width}px`, async ({
    page,
  }, testInfo) => {
    await fixtures(page)
    await page.route(/\/api\/admin\/connectors(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: [
          {
            id: 'host',
            name: 'Production',
            host: 'docker.example.test',
            discovery: true,
            revoked: false,
            stale: false,
            capabilities: ['host-terminal'],
          },
        ],
      }),
    )
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/admin/connectors')
    const input = page.getByLabel('Connector name', { exact: true })
    const create = page.getByRole('button', {
      name: 'Create connector token',
      exact: true,
    })
    const open = page.getByRole('link', { name: 'Open connector', exact: true })
    const terminal = page.getByRole('button', {
      name: 'Host terminal',
      exact: true,
    })
    await expect(terminal).toBeEnabled()
    await expectContained(page, '.inline-form,.admin-row')
    const inputBox = (await input.boundingBox())!
    const createBox = (await create.boundingBox())!
    if (width > 720) {
      expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(createBox.x)
      expect(
        Math.abs(inputBox.y + inputBox.height - createBox.y - createBox.height),
      ).toBeLessThan(2)
      const openBox = (await open.boundingBox())!
      const terminalBox = (await terminal.boundingBox())!
      expect(Math.abs(openBox.y - terminalBox.y)).toBeLessThan(2)
      expect(openBox.x + openBox.width).toBeLessThanOrEqual(terminalBox.x)
    } else {
      expect(createBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height)
    }
    await page.screenshot({
      path: testInfo.outputPath('connectors.png'),
      fullPage: true,
    })
  })
}

test('navigation keeps the document, sidebar and header mounted across pages and history', async ({
  page,
}) => {
  await fixtures(page)
  let documents = 0
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documents++
  })
  await page.goto(`/projects/${project.slug}/compute/serverless`)
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.evaluate(() => {
    document.documentElement.dataset.navigationTest = 'original'
    document
      .querySelector('.sidebar')!
      .setAttribute('data-navigation-test', 'original')
    document
      .querySelector('.topbar')!
      .setAttribute('data-navigation-test', 'original')
  })
  const expectPersistentShell = async () => {
    await expect(page.locator('html')).toHaveAttribute(
      'data-navigation-test',
      'original',
    )
    await expect(page.locator('.sidebar')).toHaveAttribute(
      'data-navigation-test',
      'original',
    )
    await expect(page.locator('.topbar')).toHaveAttribute(
      'data-navigation-test',
      'original',
    )
    expect(documents).toBe(1)
  }
  let release!: () => void
  let started!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const requested = new Promise<void>((resolve) => {
    started = resolve
  })
  await page.route('**/api/auth/me', async (route) => {
    started()
    await pending
    await route.fulfill({ json: owner })
  })
  const navigation = page
    .getByRole('link', { name: 'Databases', exact: true })
    .click()
  await requested
  try {
    // The existing layout survives while the next page's loader is waiting.
    await expectPersistentShell()
  } finally {
    release()
  }
  await navigation
  await expect(
    page.getByRole('heading', { name: 'PostgreSQL', exact: true }),
  ).toBeVisible()
  await expectPersistentShell()
  await page.getByRole('link', { name: 'Projects', exact: true }).click()
  await expect(page).toHaveURL('/admin/projects')
  await expect(page.locator('.topbar')).toContainText('AdministrationProjects')
  await expectPersistentShell()
  await page.goBack()
  await expect(
    page.getByRole('heading', { name: 'PostgreSQL', exact: true }),
  ).toBeVisible()
  await expectPersistentShell()
  await page.goForward()
  await expect(page).toHaveURL('/admin/projects')
  await expectPersistentShell()
  await page
    .getByRole('button', { name: 'Project or connector', exact: true })
    .click()
  await page.getByRole('option', { name: new RegExp(project.name) }).click()
  await expect(page).toHaveURL(`/projects/${project.slug}/services`)
  await expect(page.locator('.topbar')).toContainText('ProjectServices')
  await expectPersistentShell()
})

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
        name: 'Create your Organization Administrator account',
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
      page.getByRole('menuitem', { name: 'Sign out', exact: true }),
    ).toBeVisible()
    await expectContained(
      page,
      '[data-slot="dropdown-menu-content"],.account-button',
    )
    await page.goto('/login')
    expect(
      await page
        .locator('.auth-card')
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft)),
    ).toBeGreaterThanOrEqual(16)
  })
}

test('mobile navigation traps keyboard focus and restores its trigger after dismissal', async ({
  page,
}) => {
  await fixtures(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${project.slug}/compute/serverless`)
  const trigger = page.getByRole('button', { name: 'Toggle navigation' })
  const navigation = page.getByRole('dialog', {
    name: 'Navigation',
    exact: true,
  })
  await expect(navigation).toHaveCount(0)
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toHaveCount(0)
  await trigger.click()
  await expect(navigation).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  for (let step = 0; step < 12; step++) {
    await page.keyboard.press('Tab')
    await expect
      .poll(() =>
        navigation.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      )
      .toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(navigation).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole('button', { name: 'Close navigation' }).click()
  await expect(navigation).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
