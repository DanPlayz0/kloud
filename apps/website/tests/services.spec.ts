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
  await db.query(
    "INSERT INTO connectors(id,name,token,seen,capabilities) VALUES($1,$2,$3,now(),ARRAY['deploy'])",
    [
      connector,
      `Service host ${suffix}`,
      digest(randomBytes(32).toString('base64url')),
    ],
  )
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
    await db.query('UPDATE connectors SET seen=now() WHERE id=$1', [connector])
    await page.getByRole('link', { name: 'Create service' }).click()
    await expect(page).toHaveURL(`/projects/${project}/services/new`)
    await page
      .getByRole('button', {
        name: type === 'application' ? 'GitHub application' : 'GitHub Compose',
        exact: true,
      })
      .click()
    await page.getByLabel('Service name', { exact: true }).fill(name!)
    await page
      .getByRole('button', { name: 'Advanced settings', exact: true })
      .click()
    await page.getByLabel('Slug', { exact: true }).fill(slug!)
    await page
      .getByLabel('GitHub repository (owner/repo)')
      .fill('owner/repository')
    await expect(
      page.getByRole('button', {
        name: `Deploy to Service host ${suffix}`,
        exact: true,
      }),
    ).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Save draft', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: name!, exact: true }),
    ).toBeVisible()
    await page.goto(`/projects/${project}/services`)
    await expect(
      page.getByRole('link', { name: name!, exact: true }),
    ).toBeVisible()
  }
  await page.screenshot({
    path: 'test-results/services-desktop.png',
    fullPage: true,
  })
  await page.getByRole('link', { name: 'Web application', exact: true }).click()
  await page.getByRole('tab', { name: 'Deployments', exact: true }).click()
  await page.getByLabel('Commit SHA', { exact: true }).fill('a'.repeat(40))
  await page.getByRole('button', { name: 'Deploy draft', exact: true }).click()
  await expect(
    page.getByText('Deployment queued.', { exact: true }),
  ).toBeVisible()
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
    page.getByRole('link', { name: 'Create service', exact: true }),
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

test('image and pasted Compose drafts preserve secrets and expose structured runtime settings', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'session', value: sessions.admin, url: 'http://localhost:5174' },
  ])
  for (const source of ['image', 'compose']) {
    await db.query('UPDATE connectors SET seen=now() WHERE id=$1', [connector])
    await page.goto(`/projects/${project}/services`)
    await page
      .getByRole('link', { name: 'Create service', exact: true })
      .click()
    await page
      .getByRole('button', {
        name: source === 'image' ? 'Docker image' : 'Docker Compose',
        exact: true,
      })
      .click()
    const dialog = page
    await dialog
      .getByLabel('Service name', { exact: true })
      .fill(source === 'image' ? 'Registry app' : 'Pasted stack')
    if (source === 'image') {
      await dialog.getByLabel('Image', { exact: true }).fill('nginx:alpine')
      await page
        .getByRole('button', { name: 'Registry credentials', exact: true })
        .click()
      await dialog.getByLabel('Registry server (optional)').fill('ghcr.io')
      await dialog.getByLabel('Registry username').fill('owner')
      await dialog.getByLabel('Registry password').fill('registry-password')
    } else
      await dialog
        .getByLabel('Compose definition')
        .fill(
          'services:\n  web:\n    image: nginx:alpine\n    environment:\n      TOKEN: compose-secret\n',
        )
    if (source === 'image') {
      await page
        .getByRole('button', { name: 'Environment and secrets', exact: true })
        .click()
      await dialog.getByRole('button', { name: 'Add variable' }).click()
      await dialog.getByLabel('Variable name').fill('TOKEN')
      await dialog.getByLabel('Value', { exact: true }).fill('runtime-secret')
      await page
        .getByRole('button', { name: 'Published ports', exact: true })
        .click()
      await dialog.getByRole('button', { name: 'Add port' }).click()
      await dialog.getByLabel('Host port').fill('18080')
      await page
        .getByRole('button', { name: 'Persistent volumes', exact: true })
        .click()
      await dialog.getByRole('button', { name: 'Add volume' }).click()
      await dialog.getByLabel('Volume name').fill('app-data')
      await page
        .getByRole('button', { name: 'Resources and restart', exact: true })
        .click()
      await dialog.getByLabel('Memory limit (MiB)').fill('128')
    }
    await dialog
      .getByRole('button', { name: 'Save draft', exact: true })
      .click()
    await expect(
      page.getByRole('heading', {
        name: source === 'image' ? 'Registry app' : 'Pasted stack',
        exact: true,
      }),
    ).toBeVisible()
    await page.getByRole('tab', { name: 'Source', exact: true }).click()
    if (source === 'image') {
      await expect(page.getByLabel('Registry password')).toHaveValue('********')
      await page
        .getByRole('tab', { name: 'Configuration', exact: true })
        .click()
      await expect(page.getByLabel('Value', { exact: true })).toHaveValue(
        '********',
      )
      await expect(page.getByLabel('Host port')).toHaveValue('18080')
    } else
      await expect(page.getByLabel('Compose definition')).toHaveValue(
        '********',
      )
    await page.getByRole('button', { name: 'Save draft', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Draft saved')
    const slug = source === 'image' ? 'registry-app' : 'pasted-stack'
    const revisions = await db.query(
      'SELECT encrypted_config FROM service_revisions WHERE project=$1 AND service=$2',
      [project, slug],
    )
    expect(revisions.rowCount).toBe(2)
    for (const revision of revisions.rows)
      expect(revision.encrypted_config).not.toMatch(
        /runtime-secret|compose-secret|registry-password/,
      )
  }
})
