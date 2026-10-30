import { test, expect, type Page } from '@playwright/test'

const projects = [
  {
    slug: 'alpha',
    name: 'Alpha project',
    role: 'admin',
    can_manage_access: true,
  },
  { slug: 'production-services', name: 'Backend' },
]

async function fixtures(
  page: Page,
  admin = true,
  capabilities: string[] = [],
  list = projects,
) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const data =
      path === '/api/auth/me'
        ? { id: 'picker-user', username: 'picker', admin, capabilities }
        : path === '/api/projects' || path === '/api/admin/projects'
          ? list
          : path.endsWith('/containers')
            ? []
            : { ok: true }
    return route.fulfill({ json: data })
  })
  await page.goto(list.length ? '/projects/alpha/compute/containers' : '/')
}

test('searches names and slugs, preserves order, navigates with keyboard and restores focus', async ({
  page,
}, testInfo) => {
  await fixtures(page)
  const picker = page.getByRole('button', { name: 'Project', exact: true })
  await expect(picker).toContainText('Alpha project')
  await picker.click()
  const search = page.getByRole('combobox', { name: 'Search projects' })
  await expect(search).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('project-picker.png') })
  await expect(page.getByRole('option')).toHaveText([
    'Alpha projectalpha',
    'Backendproduction-services',
  ])
  await search.fill('ALPHA')
  await expect(page.getByRole('option')).toHaveCount(1)
  await search.fill('no-match')
  await expect(page.getByText('No projects found')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Create project', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toBeFocused()
  await picker.click()
  await expect(search).toHaveValue('')
  await search.fill('PRODUCTION')
  await search.press('ArrowDown')
  await search.press('Enter')
  await expect(page).toHaveURL(
    /\/projects\/production-services\/compute\/containers$/,
  )
  await expect(picker).toContainText('Backend')
})

for (const [label, admin, capabilities, visible] of [
  ['server administrator', true, [], true],
  ['project creator', false, ['projects.create'], true],
  ['project manager', false, ['projects.manage'], false],
  ['project administrator', false, [], false],
  ['unrelated delegate', false, ['users.manage'], false],
] as const) {
  test(`creation permission: ${label}`, async ({ page }) => {
    await fixtures(page, admin, [...capabilities])
    await page.getByRole('button', { name: 'Project', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Create project', exact: true }),
    ).toHaveCount(visible ? 1 : 0)
  })
}

test('long project lists scroll and keep the creation action visible', async ({
  page,
}) => {
  await fixtures(
    page,
    true,
    [],
    [
      projects[0]!,
      ...Array.from({ length: 80 }, (_, i) => ({
        slug: `project-${i}`,
        name: `Project ${i}`,
      })),
    ],
  )
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  const list = page.getByRole('listbox', { name: 'Projects' })
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  )
  await page.getByRole('combobox', { name: 'Search projects' }).press('End')
  await expect(list.getByRole('option').last()).toBeInViewport()
  await expect(
    page.getByRole('button', { name: 'Create project', exact: true }),
  ).toBeInViewport()
})

test('global project management does not display the administration creation form', async ({
  page,
}) => {
  await fixtures(page, false, ['projects.manage'])
  await page.goto('/admin/projects')
  await expect(
    page.getByRole('heading', { name: 'Projects', exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel('Project name')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Rename', exact: true }),
  ).toHaveCount(2)
})

test('member cannot create projects', async ({ page }) => {
  await fixtures(
    page,
    false,
    [],
    [{ ...projects[0]!, role: 'member', can_manage_access: false }],
  )
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Create project', exact: true }),
  ).toHaveCount(0)
})

test('dialog validates, preserves failures, blocks duplicate submission and opens the created project', async ({
  page,
}) => {
  await fixtures(page)
  let calls = 0
  let finish: (() => void) | undefined
  await page.route('**/api/admin/projects', async (route) => {
    calls++
    expect(route.request().postDataJSON()).toEqual({
      name: 'New project',
      slug: 'new-project',
    })
    if (calls === 1)
      return route.fulfill({
        status: 409,
        json: { error: 'Project already exists' },
      })
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    await route.fulfill({ status: 201, json: { ok: true } })
  })
  const picker = page.getByRole('button', { name: 'Project', exact: true })
  await picker.click()
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Create project' })
  await expect(dialog.getByLabel('Project name')).toBeFocused()
  const submit = dialog.getByRole('button', {
    name: 'Create project',
    exact: true,
  })
  await submit.click()
  expect(calls).toBe(0)
  await dialog.getByLabel('Project name').fill('New project')
  await dialog.getByLabel('Project slug').fill('Bad Slug')
  await submit.click()
  expect(calls).toBe(0)
  await dialog.getByLabel('Project slug').fill('new-project')
  await submit.click()
  await expect(dialog.getByRole('alert')).toHaveText('Project already exists')
  await expect(dialog.getByLabel('Project slug')).toHaveValue('new-project')
  await submit.click()
  await expect(dialog.getByRole('button', { name: 'Creating…' })).toBeDisabled()
  await dialog.locator('form').dispatchEvent('submit')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  expect(calls).toBe(2)
  finish!()
  await expect(page).toHaveURL(/\/projects\/new-project\/compute\/containers$/)
})

test('empty picker and mobile dialog reset on cancellation', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixtures(page, true, [], [])
  await page.getByRole('button', { name: 'Toggle navigation' }).click()
  const picker = page.getByRole('button', { name: 'Project', exact: true })
  await expect(picker).toHaveText('Select project')
  await picker.click()
  await expect(page.getByText('No projects found')).toBeVisible()
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click()
  const dialog = page.getByRole('dialog')
  await page.screenshot({
    path: testInfo.outputPath('create-project-mobile.png'),
  })
  const bounds = await dialog.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await dialog.getByLabel('Project name').fill('Discard me')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(picker).toBeFocused()
  await picker.click()
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click()
  await expect(dialog.getByLabel('Project name')).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(picker).toBeFocused()
})
