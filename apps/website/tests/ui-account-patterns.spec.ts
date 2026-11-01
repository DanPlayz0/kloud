import { test, expect, type Page } from '@playwright/test'

async function projectsFixture(page: Page) {
  let projects = [{ slug: 'demo', name: 'Demo project' }]
  let failRename = true
  let deletes = 0
  const renames: unknown[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/admin/projects/demo' && request.method() === 'PUT') {
      renames.push(request.postDataJSON())
      if (failRename)
        return route.fulfill({
          status: 503,
          json: { error: 'Rename unavailable' },
        })
      projects = [{ slug: 'demo', name: request.postDataJSON().name }]
      return route.fulfill({ json: { ok: true } })
    }
    if (path === '/api/admin/projects/demo' && request.method() === 'DELETE') {
      deletes++
      projects = []
      return route.fulfill({ json: { ok: true } })
    }
    const data =
      path === '/api/auth/me'
        ? { id: 'owner', username: 'owner', admin: true, capabilities: [] }
        : path === '/api/projects' || path === '/api/admin/projects'
          ? projects
          : path === '/api/organizations/current'
            ? { slug: 'default', name: 'Default organization' }
            : path === '/api/organizations'
              ? [{ slug: 'default', name: 'Default organization', admin: true }]
              : []
    return route.fulfill({ json: data })
  })
  return {
    renames,
    allowRename: () => {
      failRename = false
    },
    deletes: () => deletes,
  }
}

test('project rename uses a labeled dialog and preserves a failed draft', async ({
  page,
}) => {
  const fixture = await projectsFixture(page)
  await page.goto('/admin/projects')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename project' })
  const name = dialog.getByLabel('Project name')
  await expect(name).toBeFocused()
  await name.fill('Renamed project')
  await dialog.getByRole('button', { name: 'Save name' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Unable to rename')
  await expect(name).toHaveValue('Renamed project')
  fixture.allowRename()
  await dialog.getByRole('button', { name: 'Save name' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Renamed project', { exact: true })).toBeVisible()
  expect(fixture.renames).toEqual([
    { name: 'Renamed project' },
    { name: 'Renamed project' },
  ])
})

test('project deletion focuses a safe cancel action and requires explicit confirmation', async ({
  page,
}) => {
  const fixture = await projectsFixture(page)
  await page.goto('/admin/projects')
  const trigger = page.getByRole('button', { name: 'Delete', exact: true })
  await trigger.click()
  const confirmation = page.getByRole('alertdialog', { name: 'Delete project' })
  await expect(
    confirmation.getByRole('button', { name: 'Cancel' }),
  ).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirmation).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(fixture.deletes()).toBe(0)
  await trigger.click()
  await confirmation
    .getByRole('button', { name: 'Delete project', exact: true })
    .click()
  await expect(page.getByText('No projects yet', { exact: true })).toBeVisible()
  expect(fixture.deletes()).toBe(1)
})
