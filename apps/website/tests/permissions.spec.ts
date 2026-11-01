import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const require = createRequire(
  new URL('../../api/package.json', import.meta.url),
)
const { Pool } = require('pg')
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
const suffix = randomUUID().slice(0, 8),
  project = `permissions-${suffix}`
const ids = {
  server: randomUUID(),
  owner: randomUUID(),
  member: randomUUID(),
  delegate: randomUUID(),
}
const connector = randomUUID()
const sessions = Object.fromEntries(
  Object.keys(ids).map((key) => [key, randomBytes(32).toString('base64url')]),
)
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')
test.beforeAll(async () => {
  await db.query('INSERT INTO projects(slug,name) VALUES($1,$2)', [
    project,
    'Permissions project',
  ])
  for (const [key, id] of Object.entries(ids)) {
    await db.query(
      'INSERT INTO users(id,username,admin,capabilities) VALUES($1,$2,$3,$4)',
      [
        id,
        `${key}-${suffix}`,
        key === 'server',
        key === 'delegate' ? ['users.manage'] : [],
      ],
    )
    await db.query(
      `INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')`,
      [digest(sessions[key]!), id],
    )
  }
  await db.query(
    "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,$3,'admin'),($2,$3,'member')",
    [ids.owner, ids.member, project],
  )
  await db.query(
    'INSERT INTO connectors(id,name,token,seen,docker_seen) VALUES($1,$2,$3,now(),now())',
    [
      connector,
      'Permission host',
      digest(randomBytes(32).toString('base64url')),
    ],
  )
  for (const [name, id] of [
    ['allowed-web', 'a'],
    ['hidden-db', 'b'],
  ])
    await db.query(
      'INSERT INTO inventory(connector_id,container_id,data) VALUES($1,$2,$3)',
      [
        connector,
        id!.repeat(64),
        JSON.stringify({
          id: id!.repeat(64),
          name,
          project,
          application: name,
          state: 'running',
          cpu: 1,
          memory: 10,
          memoryLimit: 20,
        }),
      ],
    )
})
test.afterAll(async () => {
  await db.query('DELETE FROM projects WHERE slug=$1', [project])
  await db.query('DELETE FROM connectors WHERE id=$1', [connector])
  await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [
    Object.values(ids),
  ])
  await db.end()
})

test('project administrator configures matching, mixed grants, invitations and member visibility', async ({
  page,
  context,
}, testInfo) => {
  await context.addCookies([
    { name: 'session', value: sessions.owner!, url: 'http://localhost:5174' },
  ])
  await page.goto(`/projects/${project}/compute/containers`)
  await page.getByRole('link', { name: 'Access', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Project access', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Users', exact: true }),
  ).toHaveCount(0)
  await page.getByLabel('Default matching mode').selectOption('name')
  await page.getByRole('button', { name: 'Save default' }).click()
  await expect(page.getByRole('status')).toContainText('Changes saved')
  await page
    .getByRole('button', { name: `Edit member-${suffix}`, exact: true })
    .click()
  const member = page.getByRole('dialog', {
    name: `Edit member-${suffix}`,
    exact: true,
  })
  await expect(member.getByLabel('Grant target', { exact: true })).toHaveValue('name')
  await member
    .getByLabel('Container', { exact: true })
    .selectOption(`${connector}:${'a'.repeat(64)}`)
  await member.getByText('logs (planned)', { exact: true }).click()
  await member.getByRole('button', { name: 'Add grant' }).click()
  await member.getByRole('button', { name: 'Save member access' }).click()
  await expect(member).not.toBeVisible()
  await page
    .getByRole('button', { name: `Edit member-${suffix}`, exact: true })
    .click()
  await expect(member.getByText(/name: allowed-web/).first()).toBeVisible()
  await member.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByLabel('Default matching mode').selectOption('id')
  await page.getByRole('button', { name: 'Save default' }).click()
  await page
    .getByRole('button', { name: `Edit member-${suffix}`, exact: true })
    .click()
  await expect(member.getByLabel('Grant target', { exact: true })).toHaveValue('id')
  await expect(member.getByText(/name: allowed-web/).first()).toBeVisible()
  await member.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page
    .getByRole('button', { name: 'Invite or add member', exact: true })
    .click()
  const invite = page.getByRole('dialog')
  await invite.getByLabel('Username').fill(`delegate-${suffix}`)
  await invite.getByRole('button', { name: 'Invite or add member' }).click()
  await expect(page.getByRole('status')).toHaveText('Changes saved.')
  await expect(
    page.getByText(`delegate-${suffix}`, { exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('project-access-desktop.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)
  await page.screenshot({
    path: testInfo.outputPath('project-access-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1793, height: 1376 })
  await context.clearCookies()
  await context.addCookies([
    { name: 'session', value: sessions.member!, url: 'http://localhost:5174' },
  ])
  await page.goto(`/projects/${project}/compute/containers`)
  await expect(
    page.getByRole('link', { name: 'allowed-web', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'hidden-db', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Access', exact: true }),
  ).toHaveCount(0)
  expect(
    (
      await page.request.get(`/api/projects/${project}/applications/hidden-db`)
    ).status(),
  ).toBe(404)
})

test('organization administrator delegates capability and delegated navigation stays scoped', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'session', value: sessions.server!, url: 'http://localhost:5174' },
  ])
  await page.goto('/admin/users')
  await page
    .getByRole('button', { name: `Edit delegate-${suffix}`, exact: true })
    .click()
  const delegate = page.getByRole('dialog')
  await delegate.getByText('Manage connectors', { exact: true }).click()
  await delegate.getByRole('button', { name: 'Save access' }).click()
  await expect(page.getByRole('status')).toContainText('Changes saved')
  await context.clearCookies()
  await context.addCookies([
    {
      name: 'session',
      value: sessions.delegate!,
      url: 'http://localhost:5174',
    },
  ])
  await page.goto('/admin/connectors')
  await expect(
    page.getByRole('heading', { name: 'Connectors', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Users', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Projects', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Inventory', exact: true }),
  ).toHaveCount(0)
  expect((await page.request.get('/api/admin/projects')).status()).toBe(403)
  await page.getByRole('link', { name: 'Users', exact: true }).click()
  await expect(
    page.getByLabel('Organization Administrator', { exact: true }),
  ).toHaveCount(0)
  const server = page
    .locator('.user-row')
    .filter({ has: page.getByText(`server-${suffix}`, { exact: true }) })
  await expect(server.getByText('Organization Administrator required')).toBeVisible()
})
