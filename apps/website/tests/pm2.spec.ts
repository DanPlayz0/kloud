import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
const require = createRequire(
  new URL('../../api/package.json', import.meta.url),
)
const { Pool } = require('pg'),
  WebSocket = require('ws')
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
const suffix = randomUUID().slice(0, 8),
  project = `pm2-${suffix}`,
  admin = randomUUID(),
  member = randomUUID(),
  inventoryManager = randomUUID(),
  connector = randomUUID()
const sessions = {
  admin: randomBytes(32).toString('base64url'),
  member: randomBytes(32).toString('base64url'),
  inventory: randomBytes(32).toString('base64url'),
}
const credential = randomBytes(32).toString('base64url')
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')
let socket: any,
  timer: ReturnType<typeof setInterval>,
  present = true,
  available = true,
  partial = false,
  pauseSnapshots = false,
  awaitingSnapshot = false
const workers = [0, 1].map((id) => ({
  id,
  name: 'node-api',
  namespace: 'backend',
  status: 'online',
  mode: 'cluster_mode',
  pid: 100 + id,
  uptime: Date.now(),
  restarts: 1,
  cpu: 2,
  memory: 1048576,
}))
const sendSnapshot = () => {
  if (socket?.readyState === 1 && !pauseSnapshots && !awaitingSnapshot) {
    awaitingSnapshot = true
    socket.send(
      JSON.stringify({
        type: 'pm2-snapshot',
        version: 1,
        host: 'PM2 test host',
        available,
        workers: present ? workers : [],
      }),
    )
  }
}

test.beforeAll(async () => {
  await db.query('INSERT INTO projects(slug,name) VALUES($1,$2)', [
    project,
    'PM2 test project',
  ])
  for (const [id, role] of [
    [admin, 'admin'],
    [member, 'member'],
    [inventoryManager, 'inventory'],
  ]) {
    await db.query(
      'INSERT INTO users(id,username,admin,capabilities) VALUES($1,$2,$3,$4)',
      [
        id,
        `${role}-${suffix}`,
        role === 'admin',
        role === 'inventory' ? ['inventory.manage'] : [],
      ],
    )
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
    'INSERT INTO connectors(id,name,token,discovery) VALUES($1,$2,$3,true)',
    [connector, 'PM2 test connector', digest(credential)],
  )
  socket = new WebSocket('ws://localhost:3100/connectors/ws', {
    headers: { authorization: `Bearer ${credential}` },
  })
  socket.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString())
    if (message.type === 'accepted') awaitingSnapshot = false
    if (message.type !== 'operation') return
    const op = message.operation
    if (op.action === 'delete') present = false
    socket.send(
      JSON.stringify({
        type: 'operation-result',
        id: message.id,
        result:
          op.action === 'logs'
            ? {
                output: `${op.stream ?? 'stdout'} worker ${op.worker ?? 'all'}\nlog-entry\n`,
                unavailable: false,
              }
            : {
                results: workers.map((w) => ({
                  id: w.id,
                  ok: !(partial && w.id === 1),
                })),
              },
      }),
    )
    if (op.action === 'delete') sendSnapshot()
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'capabilities', capabilities: ['pm2'] }))
  sendSnapshot()
  timer = setInterval(sendSnapshot, 3000)
})
test.afterAll(async () => {
  clearInterval(timer)
  socket?.terminate()
  await db.query('DELETE FROM connectors WHERE id=$1', [connector])
  await db.query('DELETE FROM projects WHERE slug=$1', [project])
  await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [
    [admin, member, inventoryManager],
  ])
  await db.end()
})

test('assign PM2 apps, delegate permissions, inspect workers and logs, and manage lifecycle', async ({
  page,
  context,
}, testInfo) => {
  await context.addCookies([
    {
      name: 'session',
      value: sessions.inventory,
      url: 'http://localhost:5174',
    },
  ])
  await page.goto('/admin/containers')
  const inventory = page.getByRole('region', { name: 'PM2 inventory' })
  await inventory
    .getByRole('combobox', { name: 'Project for node-api (backend)' })
    .selectOption(project)
  await inventory.getByRole('button', { name: 'Save assignment' }).click()
  await expect(inventory.getByRole('status')).toHaveText(
    'PM2 assignment saved.',
  )
  await expect(inventory.getByRole('combobox')).toHaveValue(project)
  await context.clearCookies()
  await context.addCookies([
    { name: 'session', value: sessions.admin, url: 'http://localhost:5174' },
  ])
  await page.goto(`/projects/${project}/compute/pm2`)
  await expect(
    page.getByRole('heading', { name: 'PM2', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Expand .* workers/ }),
  ).toHaveCount(0)
  await page.getByRole('cell', { name: 'PM2 test host', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('heading', { name: 'node-api', exact: true }),
  ).toBeFocused()
  await expect(
    dialog.getByLabel('node-api workers', { exact: true }),
  ).toContainText('PID 100')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.keyboard.press('Escape')
  const opener = page.getByRole('button', {
    name: 'Open node-api',
    exact: true,
  })
  await expect(opener).toBeFocused()
  await opener.press('Enter')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Log output')).toContainText(
    'combined worker all',
  )
  await dialog
    .getByRole('combobox', { name: 'Log stream' })
    .selectOption('stderr')
  await dialog.getByRole('combobox', { name: 'Log worker' }).selectOption('1')
  await expect(dialog.getByLabel('Log output')).toContainText('stderr worker 1')
  await dialog.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(
    dialog.getByRole('button', { name: 'Resume', exact: true }),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Resume', exact: true }).click()
  await dialog.getByRole('button', { name: 'stop', exact: true }).click()
  await expect(
    dialog.getByRole('button', { name: 'Confirm stop' }),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Confirm stop' }).click()
  await expect(dialog.getByRole('status')).toContainText(
    'stop completed for 2 workers',
  )
  partial = true
  await dialog.getByRole('button', { name: 'reload', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('workers 1 failed')
  partial = false
  await page.screenshot({
    path: testInfo.outputPath('pm2-operations.png'),
    fullPage: true,
  })
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()

  await page.goto(`/projects/${project}/access`)
  await page.getByRole('button', { name: `Edit member-${suffix}` }).click()
  const editor = page.getByRole('dialog'),
    pm2 = editor.getByRole('group', { name: 'PM2 permissions' })
  await pm2
    .getByRole('combobox', { name: 'PM2 grant target' })
    .selectOption({ label: 'node-api (backend · PM2 test connector)' })
  await pm2
    .getByRole('checkbox', { name: 'Read PM2 logs', exact: true })
    .check()
  await pm2
    .getByRole('checkbox', {
      name: 'Start, stop, restart and reload',
      exact: true,
    })
    .check()
  await pm2.getByRole('button', { name: 'Add PM2 grants' }).click()
  await editor.getByRole('button', { name: 'Save member access' }).click()
  await expect(editor).not.toBeVisible()
  await context.clearCookies()
  await context.addCookies([
    { name: 'session', value: sessions.member, url: 'http://localhost:5174' },
  ])
  await page.goto(`/projects/${project}/compute/pm2`)
  await page.getByRole('button', { name: 'Open node-api', exact: true }).click()
  await expect(dialog.getByLabel('Log output')).toContainText('log-entry')
  await expect(
    dialog.getByRole('button', { name: 'delete', exact: true }),
  ).toBeDisabled()
  await expect(
    dialog.getByRole('button', { name: 'restart', exact: true }),
  ).toBeEnabled()
  await db.query('DELETE FROM pm2_grants WHERE user_id=$1', [member])
  await expect(dialog.getByRole('alert')).toContainText(
    /access ended|permission|not found/i,
    { timeout: 15000 },
  )
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.reload()
  await expect(page.getByText('No PM2 applications assigned')).toBeVisible()

  await context.clearCookies()
  await context.addCookies([
    { name: 'session', value: sessions.admin, url: 'http://localhost:5174' },
  ])
  pauseSnapshots = true
  await db.query(
    "UPDATE connectors SET pm2_seen=now()-interval '21 seconds' WHERE id=$1",
    [connector],
  )
  await page.goto(`/projects/${project}/compute/pm2`)
  await expect(
    page.getByRole('cell', { name: 'Stale', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Open node-api', exact: true }).click()
  await expect(
    dialog.getByRole('button', { name: 'restart', exact: true }),
  ).toBeDisabled()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  pauseSnapshots = false
  sendSnapshot()
  await page.reload()
  await page.getByRole('button', { name: 'Open node-api', exact: true }).click()
  await expect(
    dialog.getByRole('button', { name: 'delete', exact: true }),
  ).toBeEnabled()
  await dialog.getByRole('button', { name: 'delete', exact: true }).click()
  await expect(
    dialog.getByText(/Register it again on the server/),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Confirm delete' }).click()
  await expect(dialog.getByRole('status')).toContainText('delete completed')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(
    page.getByRole('cell', { name: 'Unavailable', exact: true }),
  ).toBeVisible({ timeout: 15000 })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: testInfo.outputPath('pm2-mobile.png'),
    fullPage: true,
  })
})
