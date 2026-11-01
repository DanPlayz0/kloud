import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { randomUUID, scryptSync } from 'node:crypto'

const require = createRequire(
  new URL('../../api/package.json', import.meta.url),
)
const { Pool } = require('pg')
const { TOTP, Secret } = require('otpauth')

test('canceling a passkey leaves other second-factor methods available', async ({
  page,
}) => {
  let verifications = 0
  await page.addInitScript(() => {
    Object.defineProperty(navigator.credentials, 'get', {
      value: async () => {
        throw new DOMException('Canceled', 'NotAllowedError')
      },
    })
  })
  await page.route('**/api/auth/setup', (route) =>
    route.fulfill({ json: { required: false } }),
  )
  await page.route('**/api/auth/password', (route) =>
    route.fulfill({
      json: {
        status: 'second_factor_required',
        methods: ['passkey', 'totp'],
        emailAvailable: false,
        totpAvailable: true,
      },
    }),
  )
  await page.route('**/api/auth/factor/challenge', (route) =>
    route.fulfill({
      json: {
        options: {
          challenge: 'a'.repeat(43),
          rpId: 'localhost',
          userVerification: 'required',
          allowCredentials: [],
        },
      },
    }),
  )
  await page.route('**/api/auth/verify', (route) => {
    verifications++
    return route.fulfill({
      status: 401,
      json: { error: 'Unexpected assertion' },
    })
  })
  await page.goto('/login')
  await page.getByLabel('Username', { exact: true }).fill('cancel-test')
  await page.getByLabel('Password', { exact: true }).fill('some password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('radio', { name: 'Passkey', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(
    page.getByRole('radio', { name: 'Recovery code', exact: true }),
  ).toBeEnabled()
  await page
    .getByRole('radio', { name: 'Authenticator app', exact: true })
    .click()
  await expect(page.getByLabel('Authenticator app code')).toBeVisible()
  expect(verifications).toBe(0)
})

test('account security enables TOTP, recovery and passkeys while Email is unavailable', async ({
  page,
  context,
}) => {
  const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
  const id = randomUUID(),
    username = 'security-' + id,
    password = 'a secure browser test password',
    salt = 'test-security-salt'
  await db.query(
    'INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)',
    [id, username, salt + ':' + scryptSync(password, salt, 64).toString('hex')],
  )
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
    await page.goto('/login?next=/account/security')
    await page.getByLabel('Username', { exact: true }).fill(username)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Account security', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Enable Email', exact: true }),
    ).toBeDisabled()
    await expect(
      page.getByRole('button', { name: 'Add passkey', exact: true }),
    ).toBeDisabled()
    await page.getByLabel('Current password').fill(password)
    await page
      .getByRole('button', { name: 'Confirm identity', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Enable authenticator app', exact: true })
      .click()
    await expect(
      page.getByRole('img', {
        name: 'Scan this QR code with your authenticator app',
      }),
    ).toBeVisible()
    const secret = await page.locator('code').innerText()
    await page
      .getByLabel('Verification code', { exact: true })
      .fill(new TOTP({ secret: Secret.fromBase32(secret) }).generate())
    await page
      .getByRole('button', { name: 'Verify and enable', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: 'Save your recovery codes' }),
    ).toBeVisible()
    const recovery = await page.locator('ul.font-mono li').allTextContents()
    expect(recovery).toHaveLength(10)
    await page.getByRole('button', { name: 'I have saved these codes' }).click()
    await page.getByLabel('Current password').fill(password)
    await page
      .getByRole('button', { name: 'Confirm identity', exact: true })
      .click()
    await page
      .getByRole('radio', { name: 'Recovery code', exact: true })
      .click()
    await page.getByLabel('Recovery code', { exact: true }).fill(recovery[0]!)
    await page.getByRole('button', { name: 'Verify code', exact: true }).click()
    await page.getByLabel('Passkey name').fill('Browser passkey')
    await page.getByRole('button', { name: 'Add passkey', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Remove Browser passkey' }),
    ).toBeVisible()
    await context.clearCookies()
    await page.goto('/login?next=/account/security')
    await page.getByLabel('Username', { exact: true }).fill(username)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(
      page.getByRole('radio', { name: 'Authenticator app', exact: true }),
    ).toBeVisible()
    await page.getByRole('radio', { name: 'Passkey', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Account security', exact: true }),
    ).toBeVisible()
  } finally {
    await db.query('DELETE FROM users WHERE id=$1', [id])
    await db.end()
  }
})

test('invitation activation needs only a password', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
  const { createHash, randomBytes } = await import('node:crypto')
  const id = randomUUID(),
    invitation = randomBytes(32).toString('base64url')
  await db.query('INSERT INTO users(id,username) VALUES($1,$2)', [
    id,
    'invited-' + id,
  ])
  await db.query(
    "INSERT INTO invitations(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
    [createHash('sha256').update(invitation).digest('hex'), id],
  )
  try {
    await page.goto('/enroll#' + invitation)
    await page
      .getByLabel('Password', { exact: true })
      .fill('a secure invited user password')
    await page
      .getByLabel('Confirm password', { exact: true })
      .fill('a secure invited user password')
    await page
      .getByRole('button', { name: 'Set password', exact: true })
      .click()
    await expect(
      page.getByText('Your password is registered.', { exact: false }),
    ).toBeVisible()
    expect(
      (await db.query('SELECT 1 FROM passkeys WHERE user_id=$1', [id]))
        .rowCount,
    ).toBe(0)
  } finally {
    await db.query('DELETE FROM users WHERE id=$1', [id])
    await db.end()
  }
})
