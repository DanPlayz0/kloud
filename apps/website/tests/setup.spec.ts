import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

test('first Organization Administrator can set a password and sign in', async ({
  page,
}) => {
  const require = createRequire(
    new URL('../../api/package.json', import.meta.url),
  )
  const { Pool } = require('pg')
  const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
  const username = `setup-${randomUUID()}`
  try {
    const status = await page.request.get('/api/auth/setup')
    test.skip(
      !(await status.json()).required,
      'Requires an empty isolated test database',
    )
    await page.goto('/login')
    await page.getByLabel('Username', { exact: true }).fill(username)
    await page
      .getByLabel('Email address', { exact: true })
      .fill(`${username}@example.com`)
    await page
      .getByLabel('Password', { exact: true })
      .fill('a strong first admin password')
    await page
      .getByLabel('Confirm password')
      .fill('a strong first admin password')
    await page
      .getByRole('button', {
        name: 'Create Organization Administrator',
      })
      .click()
    await expect(
      page.getByText('Your Organization Administrator account is ready.', {
        exact: false,
      }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(
      page.getByRole('heading', { name: 'No projects yet' }),
    ).toBeVisible()
    const user = await db.query('SELECT admin FROM users WHERE username=$1', [
      username,
    ])
    expect(user.rows[0].admin).toBe(true)
  } finally {
    await db.query('DELETE FROM users WHERE username=$1', [username])
    await db.end()
  }
})

test('empty installations prompt for Organization Administrator setup and validate password confirmation', async ({
  page,
}) => {
  await page.route('**/api/auth/setup', (route) =>
    route.fulfill({ json: { required: true } }),
  )
  await page.goto('/login')
  await expect(
    page.getByRole('heading', {
      name: 'Create your Organization Administrator account',
    }),
  ).toBeVisible()
  await page.getByLabel('Username', { exact: true }).fill('owner')
  await page
    .getByLabel('Email address', { exact: true })
    .fill('owner@example.com')
  await page
    .getByLabel('Password', { exact: true })
    .fill('a strong first admin password')
  await page.getByLabel('Confirm password').fill('a different strong password')
  await page
    .getByRole('button', {
      name: 'Create Organization Administrator',
    })
    .click()
  await expect(page.getByRole('alert')).toHaveText('Passwords must match')
})

test('populated installations show normal sign-in', async ({ page }) => {
  await page.route('**/api/auth/setup', (route) =>
    route.fulfill({ json: { required: false } }),
  )
  await page.goto('/login')
  await expect(
    page.getByRole('heading', { name: 'Welcome back' }),
  ).toBeVisible()
  await expect(page.getByLabel('Confirm password')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})
