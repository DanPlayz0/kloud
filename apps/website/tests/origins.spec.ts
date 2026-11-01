import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { randomUUID, scryptSync } from 'node:crypto'
const require = createRequire(
  new URL('../../api/package.json', import.meta.url),
)
const { Pool } = require('pg')

test('localhost, HTTPS tunnel domain and direct IP log in with separate cookies and scoped passkeys', async ({
  page,
  context,
}) => {
  const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
  const id = randomUUID(),
    username = 'origins-' + id,
    password = 'a secure multi origin test password',
    salt = 'origin-test-salt'
  await db.query(
    'INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)',
    [id, username, salt + ':' + scryptSync(password, salt, 64).toString('hex')],
  )
  const domain = 'https://kloud.example.test'
  // Browser sees HTTPS; the local upstream receives plain HTTP, just like a tunnel.
  await context.route(domain + '/**', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill({
      response: await route.fetch({
        url: 'http://localhost:5174' + url.pathname + url.search,
      }),
    })
  })
  const login = async (origin: string) => {
    await page.goto(origin + '/login?next=/account/security')
    await page.getByLabel('Username', { exact: true }).fill(username)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  }
  const recover = async (code: string) => {
    await page
      .getByRole('button', { name: 'Recovery code', exact: true })
      .click()
    await page.getByLabel('Recovery code', { exact: true }).fill(code)
    await page.getByRole('button', { name: 'Verify code', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Account security', exact: true }),
    ).toBeVisible()
  }
  try {
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
    await login('http://localhost:5174')
    await expect(
      page.getByRole('heading', { name: 'Account security', exact: true }),
    ).toBeVisible()
    expect(
      (await context.cookies()).find((c) => c.name === 'session')?.secure,
    ).toBe(false)
    await page.getByLabel('Current password').fill(password)
    await page
      .getByRole('button', { name: 'Confirm identity', exact: true })
      .click()
    await page.getByLabel('Passkey name').fill('Local device')
    await page.getByRole('button', { name: 'Add passkey', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Save your recovery codes' }),
    ).toBeVisible()
    const recovery = await page.locator('ul.font-mono li').allTextContents()
    await context.clearCookies()
    await login(domain)
    await expect(
      page.getByRole('button', { name: 'Passkey', exact: true }),
    ).toBeDisabled()
    await recover(recovery[0]!)
    expect(
      (await context.cookies()).find(
        (c) => c.name === 'session' && c.domain === 'kloud.example.test',
      )?.secure,
    ).toBe(true)
    await page.getByLabel('Current password').fill(password)
    await page
      .getByRole('button', { name: 'Confirm identity', exact: true })
      .click()
    await recover(recovery[1]!)
    await page.getByLabel('Passkey name').fill('Tunnel device')
    await page.getByRole('button', { name: 'Add passkey', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Remove Tunnel device' }),
    ).toBeVisible()
    const credentials = (
      await db.query(
        'SELECT rp_id FROM passkeys WHERE user_id=$1 ORDER BY rp_id',
        [id],
      )
    ).rows
    expect(credentials.map((r: { rp_id: string }) => r.rp_id)).toEqual([
      'kloud.example.test',
      'localhost',
    ])
    await context.clearCookies()
    await login(domain)
    await page.getByRole('button', { name: 'Passkey', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Account security', exact: true }),
    ).toBeVisible()
    await context.clearCookies()
    await login('http://127.0.0.1:5174')
    await expect(
      page.getByRole('button', { name: 'Passkey', exact: true }),
    ).toBeDisabled()
    await recover(recovery[2]!)
    await expect(
      page.getByText('Passkeys require HTTPS on a domain name or localhost.', {
        exact: false,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Add passkey', exact: true }),
    ).toBeDisabled()
    expect(
      (await context.cookies()).find(
        (c) => c.name === 'session' && c.domain === '127.0.0.1',
      )?.secure,
    ).toBe(false)
  } finally {
    await db.query('DELETE FROM users WHERE id=$1', [id])
    await db.end()
  }
})
