import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const require = createRequire(
  new URL('../../api/package.json', import.meta.url),
)
const { Pool } = require('pg')
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
const suffix = randomUUID().slice(0, 8)
const project = `services-${suffix}`,
  admin = randomUUID(),
  member = randomUUID(),
  connector = randomUUID()
const sessions = {
  admin: randomBytes(32).toString('base64url'),
  member: randomBytes(32).toString('base64url'),
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
test.beforeAll(async () => {
  await db.query('INSERT INTO projects(slug,name) VALUES($1,$2)', [
    project,
    'Service test project',
  ])
  for (const [id, role] of [
    [admin, 'admin'],
    [member, 'member'],
  ]) {
    await db.query('INSERT INTO users(id,username,admin) VALUES($1,$2,$3)', [
      id,
      `${role}-${suffix}`,
      role === 'admin',
    ])
    await db.query(
      "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
      [digest(sessions[role as keyof typeof sessions]), id],
    )
  }
  await db.query(
    "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,$3,'admin'),($2,$3,'member')",
    [admin, member, project],
  )
  await db.query('INSERT INTO connectors(id,name,token) VALUES($1,$2,$3)', [
    connector,
    `Service host ${suffix}`,
    digest(randomBytes(32).toString('base64url')),
  ])
})
test.afterAll(async () => {
  await db.query('DELETE FROM projects WHERE slug=$1', [project])
  await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [
    [admin, member],
  ])
  await db.query('DELETE FROM connectors WHERE id=$1', [connector])
  await db.end()
})

test('create Dockerfile and Compose services, configure initial deployment, and grant scoped access', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'session', value: sessions.admin, url: 'http://localhost:5174' },
  ])
  await page.goto(`/projects/${project}/services`)
  for (const [name, slug, type] of [
    ['Web application', 'web', 'application'],
    ['Compose stack', 'stack', 'compose'],
  ]) {
    await page.getByRole('button', { name: 'Create service' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name', { exact: true }).fill(name!)
    await dialog.getByLabel('Slug', { exact: true }).fill(slug!)
    await dialog.getByLabel('Service type').selectOption(type!)
    await dialog.getByRole('button', { name: 'Save service' }).click()
    await expect(dialog).not.toBeVisible()
    await expect(
      page.getByRole('link', { name: name!, exact: true }),
    ).toBeVisible()
  }
  await page.screenshot({
    path: 'test-results/services-desktop.png',
    fullPage: true,
  })
  await page.getByRole('link', { name: 'Web application', exact: true }).click()
  await expect(
    page.getByLabel('Container / host'),
  ).toHaveCount(0)
  await page
    .getByLabel('Deployment host', { exact: true })
    .selectOption(connector)
  await page
    .getByLabel('GitHub repository (owner/repo)')
    .fill('owner/repository')
  await page
    .getByRole('button', { name: 'Save deployment', exact: true })
    .click()
  await expect(
    page.getByText('Deployment saved.', { exact: true }),
  ).toBeVisible()
  await page.getByLabel('Commit SHA', { exact: true }).fill('a'.repeat(40))
  await page.getByRole('button', { name: 'Deploy commit', exact: true }).click()
  await expect(page.getByText('Build queued.', { exact: true })).toBeVisible()
  await page.goto(`/projects/${project}/access`)
  await page
    .getByRole('button', { name: `Edit member-${suffix}`, exact: true })
    .click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Service target', { exact: true }).selectOption('web')
  await dialog
    .getByRole('button', { name: 'Add service permissions', exact: true })
    .click()
  await dialog
    .getByRole('button', { name: 'Save member access', exact: true })
    .click()
  await expect(dialog).not.toBeVisible()
  await context.clearCookies()
  await context.addCookies([
    { name: 'session', value: sessions.member, url: 'http://localhost:5174' },
  ])
  await page.goto(`/projects/${project}/services`)
  await expect(
    page.getByRole('link', { name: 'Web application', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Compose stack', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Create service', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('link', { name: 'Web application', exact: true }).click()
  await expect(
    page.getByText('You have view access.', { exact: false }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Save deployment', exact: true }),
  ).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${project}/services`)
  await expect(
    page.getByRole('link', { name: 'Web application', exact: true }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: 'test-results/services-mobile.png',
    fullPage: true,
  })
})
