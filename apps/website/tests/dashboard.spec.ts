import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
const require = createRequire(
  new URL('../../api/package.json', import.meta.url),
)
const { Pool } = require('pg')
const WebSocket = require('ws')
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
const id = randomUUID(),
  username = `browser-${id.slice(0, 8)}`,
  invitation = randomBytes(32).toString('base64url')
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')
const project = `your-project-slug-${id.slice(0, 8)}`
let connectorID: string | undefined
test.beforeAll(async () => {
  await db.query('INSERT INTO users(id,username,admin) VALUES($1,$2,true)', [
    id,
    username,
  ])
  await db.query(
    `INSERT INTO invitations(token,user_id,expires) VALUES($1,$2,now()+interval '24 hours')`,
    [digest(invitation), id],
  )
})
test.afterAll(async () => {
  if (connectorID)
    await db.query('DELETE FROM connectors WHERE id=$1', [connectorID])
  await db.query('DELETE FROM projects WHERE slug=$1', [project])
  await db.query('DELETE FROM users WHERE id=$1 OR username=$2', [
    id,
    `member-${id.slice(0, 8)}`,
  ])
  await db.end()
})
for (const creatorOnly of [false, true]) {
  test(`sidebar creates a project as ${creatorOnly ? 'a project creator' : 'a server administrator'} and opens its Services page`, async ({
    page,
    context,
  }) => {
    const session = randomBytes(32).toString('base64url')
    const creatorID = creatorOnly ? randomUUID() : id
    const slug = `picker-${creatorID.slice(0, 8)}`
    if (creatorOnly)
      await db.query(
        "INSERT INTO users(id,username,capabilities) VALUES($1,$2,ARRAY['projects.create'])",
        [creatorID, `creator-${creatorID.slice(0, 8)}`],
      )
    await db.query(
      "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
      [digest(session), creatorID],
    )
    await context.addCookies([
      { name: 'session', value: session, url: 'http://localhost:5174' },
    ])
    try {
      await page.goto(creatorOnly ? '/' : '/admin/projects')
      if (creatorOnly)
        await expect(
          page.getByRole('link', { name: 'Projects', exact: true }),
        ).toHaveCount(0)
      await page
        .getByRole('button', { name: /^Project(?: or connector)?$/ })
        .click()
      await page
        .getByRole('button', { name: 'Create project', exact: true })
        .last()
        .click()
      const dialog = page.getByRole('dialog', { name: 'Create project' })
      await dialog.getByLabel('Project name').fill('Picker project')
      await dialog.getByLabel('Project slug').fill(slug)
      await dialog
        .getByRole('button', { name: 'Create project', exact: true })
        .click()
      await expect(page).toHaveURL(`/projects/${slug}/services`)
      await expect(
        page.getByRole('button', { name: /^Project(?: or connector)?$/ }),
      ).toContainText('Picker project')
      await expect(
        page.getByRole('heading', { name: 'Services', exact: true }),
      ).toBeVisible()
      if (creatorOnly)
        await expect(
          page.getByRole('link', { name: 'Access', exact: true }),
        ).toBeVisible()
    } finally {
      await db.query('DELETE FROM projects WHERE slug=$1', [slug])
      await db.query('DELETE FROM sessions WHERE token=$1', [digest(session)])
      if (creatorOnly)
        await db.query('DELETE FROM users WHERE id=$1', [creatorID])
    }
  })
}

test('enrollment, two-factor login, administration, live inventory and responsive navigation', async ({
  page,
  context,
}, testInfo) => {
  const browserErrors: string[] = []
  page.on('pageerror', (error) => browserErrors.push(error.message))
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await page.goto(`/projects/${project}/compute/containers`)
  await expect(page).toHaveURL(/\/login/)
  await page.goto(`/enroll#${invitation}`)
  await page
    .getByLabel('Password', { exact: true })
    .fill('a very strong browser test password')
  await page
    .getByLabel('Confirm password')
    .fill('a very strong browser test password')
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(
    page.getByRole('heading', { name: 'You’re ready' }),
  ).toBeVisible()
  await page.getByRole('link', { name: /Continue to sign in/ }).click()
  await page.getByLabel('Username', { exact: true }).fill(username)
  await page
    .getByLabel('Password', { exact: true })
    .fill('a very strong browser test password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'No projects yet' }),
  ).toBeVisible()
  await page.goto('/account/security')
  await page
    .getByLabel('Current password')
    .fill('a very strong browser test password')
  await page
    .getByRole('button', { name: 'Confirm identity', exact: true })
    .click()
  await page.getByLabel('Passkey name').fill('Dashboard test device')
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Save your recovery codes' }),
  ).toBeVisible()
  await context.clearCookies()
  await page.goto('/login')
  await page.getByLabel('Username', { exact: true }).fill(username)
  await page
    .getByLabel('Password', { exact: true })
    .fill('a very strong browser test password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Passkey', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'No projects yet' }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Create your first project' }).click()
  await page.getByLabel('Project name').fill('Your project name')
  await page.getByLabel('Project slug').fill(project)
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('status')).toContainText('Changes saved')
  await page
    .getByRole('button', { name: /^Project(?: or connector)?$/ })
    .click()
  await expect(
    page
      .getByRole('listbox', { name: /^Projects(?: and connectors)?$/ })
      .getByRole('option', { name: /Your project name/ }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('link', { name: 'Connectors', exact: true }).click()
  await page.getByLabel('Connector name').fill('Browser Docker host')
  await page.getByRole('button', { name: 'Create connector token' }).click()
  const secret = (await page.getByRole('status').innerText()).match(
    /[A-Za-z0-9_-]{43}/,
  )![0]
  connectorID = (
    await db.query('SELECT id FROM connectors WHERE token=$1', [digest(secret)])
  ).rows[0].id
  await page.getByLabel('Discover unassigned containers').check()
  await expect(page.getByRole('status')).toContainText('Changes saved')
  const snapshot = {
    version: 1,
    type: 'snapshot',
    host: 'production-01',
    containers: [
      {
        id: 'a'.repeat(64),
        name: 'imgen',
        state: 'running',
        project,
        application: 'imgen',
        cpu: 12.5,
        memory: 67108864,
        memoryLimit: 268435456,
      },
      {
        id: 'b'.repeat(64),
        name: 'worker',
        state: 'exited',
        project: null,
        application: null,
        cpu: null,
        memory: null,
        memoryLimit: null,
      },
    ],
  }
  const ws = new WebSocket('ws://localhost:3100/connectors/ws', {
    headers: { authorization: `Bearer ${secret}` },
  })
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify(snapshot)))
    ws.on('message', () => resolve())
    ws.on('error', reject)
  })
  let interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(snapshot))
  }, 5000)
  try {
    await page.getByRole('link', { name: 'Inventory', exact: true }).click()
    await page.getByLabel('Project for worker').selectOption(project)
    await page.getByLabel('Application slug for worker').fill('worker')
    await page.getByRole('button', { name: 'Assign', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Changes saved')
    await page
      .getByRole('button', { name: /^Project(?: or connector)?$/ })
      .click()
    await page
      .getByRole('listbox', { name: /^Projects(?: and connectors)?$/ })
      .getByRole('option', { name: /Your project name/ })
      .click()
    await page.getByRole('link', { name: 'Containers', exact: true }).click()
    await expect(page.getByRole('link', { name: /imgen/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /worker/ })).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('containers-desktop.png'),
      fullPage: true,
    })
    clearInterval(interval)
    await db.query(
      `UPDATE connectors SET seen=now()-interval '21 seconds',docker_seen=now()-interval '21 seconds' WHERE id=$1`,
      [connectorID],
    )
    await page.reload()
    await expect(page.locator('.status.stale')).toHaveCount(2)
    await expect(page.getByText('12.5%', { exact: true })).toHaveCount(0)
    ws.send(JSON.stringify(snapshot))
    interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(snapshot))
    }, 5000)
    await expect(page.locator('.status.running')).toHaveCount(1, {
      timeout: 10000,
    })
    await page.route('**/api/projects/*/containers', (route) => route.abort())
    await expect(
      page.getByText('Connection interrupted', { exact: true }),
    ).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('alert')).toBeVisible()
    await page.unroute('**/api/projects/*/containers')
    await expect(
      page.getByText('Updates every 5s', { exact: true }),
    ).toBeVisible({ timeout: 10000 })
    await page.getByRole('link', { name: /imgen/ }).click()
    await expect(page).toHaveURL(
      new RegExp(`/projects/${project}/applications/imgen$`),
    )
    await expect(page.getByRole('heading', { name: 'imgen' })).toBeVisible()
    await page.getByRole('link', { name: /Serverless/ }).click()
    await expect(
      page.getByRole('heading', { name: 'Serverless is coming later' }),
    ).toBeVisible()
    await page.getByRole('link', { name: 'View containers' }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(
      page.getByRole('button', { name: 'Toggle navigation' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Toggle navigation' }).click()
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Containers', exact: true }),
    ).toBeVisible()
    const backdrop = page.getByRole('button', {
      name: 'Close navigation',
      exact: true,
    })
    const backdropBounds = await backdrop.boundingBox()
    await backdrop.click({
      position: {
        x: backdropBounds!.width - 12,
        y: backdropBounds!.height / 2,
      },
    })
    await page.screenshot({
      path: testInfo.outputPath('containers-mobile.png'),
      fullPage: true,
    })
    await page.setViewportSize({ width: 1793, height: 1376 })
    await page.getByRole('link', { name: 'Users', exact: true }).click()
    await page.getByRole('button', { name: 'Invite user', exact: true }).click()
    await page
      .getByLabel('Username', { exact: true })
      .fill(`member-${id.slice(0, 8)}`)
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Invite user' })
      .click()
    await expect(page.getByRole('status')).toContainText('/enroll#')
    await page
      .getByRole('button', {
        name: `Edit member-${id.slice(0, 8)}`,
        exact: true,
      })
      .click()
    const member = page.getByRole('dialog')
    await member.getByLabel('Your project name', { exact: true }).check()
    await member.getByRole('button', { name: 'Save access' }).click()
    await expect(page.getByRole('status')).toContainText('Changes saved')
    await page.locator('.account-button').click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page).toHaveURL(/\/login/)
    expect(browserErrors).toEqual([])
  } finally {
    clearInterval(interval)
    ws.close()
  }
})

test('container polling times out hung responses and recovers', async ({
  page,
}) => {
  let blocked = true,
    requested = false
  await page.clock.install()
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: { id: 'review-user', username: 'review', admin: false },
    }),
  )
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: [{ slug: 'review', name: 'Review' }] }),
  )
  await page.route('**/api/projects/review/containers', (route) => {
    requested = true
    if (!blocked) return route.fulfill({ json: [] })
    // Leave the response pending so the production request timeout must fire.
  })
  await page.goto('/projects/review/compute/containers')
  await expect(
    page.getByRole('heading', { name: 'Containers', exact: true }),
  ).toBeVisible()
  await expect.poll(() => requested).toBe(true)
  await page.clock.runFor(11000)
  await expect(page.getByRole('alert')).toBeVisible()
  blocked = false
  await page.clock.runFor(5000)
  await expect(
    page.getByRole('heading', { name: 'No containers assigned' }),
  ).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(
    await page
      .locator('.app-shell')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe('rgb(11, 11, 11)')
})
