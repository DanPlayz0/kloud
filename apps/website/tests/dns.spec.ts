import { test, expect, type Page } from '@playwright/test'

const zone = '11111111-1111-4111-8111-111111111111'
const rule = {
  kind: 'name',
  target: 'voice.discord.media',
  types: ['A'],
  actions: ['read', 'create', 'update', 'delete'],
}
const project = { slug: 'discord', name: 'Discord', can_manage_access: true }
const record = {
  id: 'a'.repeat(32),
  name: 'voice.discord.media',
  type: 'A',
  ttl: 1,
  content: '192.0.2.1',
  actions: ['read', 'update', 'delete'],
}
async function mockDns(page: Page, member = false) {
  let providers: any[] = [],
    zones: any[] = [],
    delegations: any[] = [],
    records: any[] = [record]
  const writes: any[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace('/api', ''),
      method = request.method(),
      body = request.postDataJSON()
    let data: any = { ok: true }
    if (path === '/auth/me')
      data = {
        id: 'user',
        username: member ? 'friend' : 'admin',
        admin: !member,
        capabilities: [],
      }
    else if (path === '/projects')
      data = [{ ...project, can_manage_access: !member }]
    else if (path === '/admin/dns/projects') data = [project]
    else if (
      path.endsWith('/dns/providers') ||
      path === '/admin/dns/providers'
    ) {
      if (method === 'POST') {
        providers = [{ id: 'provider', name: body.name, enabled: true }]
        data = { id: 'provider' }
      } else data = providers
    } else if (path.endsWith('/discover')) {
      zones = [{ id: zone, name: 'discord.media', delegations: [] }]
      data = zones
    } else if (
      path.includes('/providers/provider/zones/') &&
      /\/zones\/[^/]+\/projects\//.test(path)
    ) {
      delegations = [{ project: 'discord', rules: body.rules }]
      writes.push({ path, body })
    } else if (path.endsWith('/providers/provider/zones'))
      data = zones.map((z) => ({ ...z, delegations }))
    else if (
      path.includes('/providers/provider/zones/') &&
      path.endsWith('/records')
    )
      data = records
    else if (path === '/projects/discord/dns')
      data = {
        can_manage_providers: !member,
        zones: [
          {
            id: zone,
            name: 'discord.media',
            provider_name: 'Shared Cloudflare',
            origin: 'server',
          },
        ],
      }
    else if (path === '/projects/discord/dns/access-scopes')
      data = { zones: [{ id: zone, name: 'discord.media', rules: [rule] }] }
    else if (path.startsWith(`/projects/discord/dns/zones/${zone}/records`)) {
      if (method === 'GET')
        data = {
          records: records.map((r) => ({
            ...r,
            actions: member ? ['read'] : r.actions,
          })),
          creation_scopes: member ? [] : [rule],
        }
      else {
        writes.push({ path, body })
        records = [{ id: record.id, actions: record.actions, ...body }]
        data = records[0]
      }
    } else if (path === '/projects/discord/access')
      data = {
        grant_mode: 'id',
        members: [
          {
            id: 'friend',
            username: 'friend',
            role: 'member',
            disabled: false,
            grants: [],
            service_grants: [],
            dns_grants: [],
          },
        ],
      }
    else if (path.startsWith('/projects/discord/access/members')) {
      writes.push({ path, body })
    } else if (path.endsWith('/containers') || path.endsWith('/pm2')) data = []
    else if (path.endsWith('/services'))
      data = { services: [], can_create: false }
    else if (path.endsWith('/auth/setup')) data = { required: false }
    await route.fulfill({ json: data })
  })
  return writes
}

test('connect provider, discover zone, and delegate selected names and types', async ({
  page,
}) => {
  const writes = await mockDns(page)
  await page.goto('/admin/dns')
  await page.getByLabel('Connection name').fill('Shared Cloudflare')
  await page.getByLabel('API token', { exact: true }).fill('fake-test-token')
  await page
    .getByRole('button', { name: 'Connect provider', exact: true })
    .click()
  await expect(
    page.getByText('Shared Cloudflare', { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Discover zones', exact: true })
    .click()
  await page.getByRole('button', { name: 'Manage zones', exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Discovered zone', exact: true })
    .selectOption(zone)
  await page
    .getByRole('combobox', { name: 'Project', exact: true })
    .selectOption('discord')
  await page.getByRole('button', { name: 'Configure access' }).click()
  await page
    .getByRole('combobox', { name: 'Scope', exact: true })
    .selectOption('name')
  await page.getByLabel('Fully qualified DNS name').fill('voice.discord.media')
  await page.getByLabel('A', { exact: true }).check()
  await page.getByLabel('update', { exact: true }).check()
  await page.getByRole('button', { name: 'Add DNS rule' }).click()
  await page.getByRole('button', { name: 'Save project DNS access' }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0].body.rules[0]).toEqual({
    kind: 'name',
    target: 'voice.discord.media',
    types: ['A'],
    actions: ['read', 'update'],
  })
  await page.screenshot({
    path: 'test-results/dns-provider-desktop.png',
    fullPage: true,
  })
})

test('typed record editors cover every type and save a structured SRV record', async ({
  page,
}) => {
  const writes = await mockDns(page)
  await page.goto('/projects/discord/dns')
  await page.getByRole('button', { name: 'Edit A voice.discord.media' }).click()
  const dialog = page.getByRole('dialog'),
    type = dialog.getByRole('combobox', { name: 'Record type', exact: true })
  for (const value of [
    'A',
    'AAAA',
    'CNAME',
    'TXT',
    'NS',
    'PTR',
    'MX',
    'CAA',
    'CERT',
    'DNSKEY',
    'DS',
    'HTTPS',
    'LOC',
    'NAPTR',
    'OPENPGPKEY',
    'SMIMEA',
    'SRV',
    'SSHFP',
    'SVCB',
    'TLSA',
    'URI',
  ]) {
    await type.selectOption(value)
    await expect(
      dialog.getByRole('button', { name: 'Save DNS record' }),
    ).toBeVisible()
  }
  await type.selectOption('SRV')
  await dialog
    .getByLabel('DNS name', { exact: true })
    .fill('_voice._tcp.discord.media')
  await dialog.getByLabel('priority', { exact: true }).fill('10')
  await dialog.getByLabel('weight', { exact: true }).fill('5')
  await dialog.getByLabel('port', { exact: true }).fill('443')
  await dialog.getByLabel('target', { exact: true }).fill('voice.discord.media')
  await dialog.getByRole('button', { name: 'Save DNS record' }).click()
  await expect(dialog).not.toBeVisible()
  expect(writes[0].body.data).toEqual({
    priority: 10,
    weight: 5,
    port: 443,
    target: 'voice.discord.media',
  })
  await page.screenshot({
    path: 'test-results/dns-project-desktop.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: 'test-results/dns-project-mobile.png',
    fullPage: true,
    animations: 'disabled',
  })
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)
})

test('restricted member sees records with no editing or provider controls', async ({
  page,
}) => {
  await mockDns(page, true)
  await page.goto('/projects/discord/dns')
  await expect(
    page.getByRole('cell', { name: 'voice.discord.media', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Add record', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Edit A voice.discord.media' }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Private providers' }),
  ).toHaveCount(0)
})

test('project administrators connect a private provider and associate its zone only with their project', async ({
  page,
}) => {
  const writes = await mockDns(page)
  await page.goto('/projects/discord/dns')
  await page.getByRole('button', { name: 'Private providers' }).click()
  await page.getByLabel('Connection name').fill('Private Cloudflare')
  await page.getByLabel('API token', { exact: true }).fill('private-fake-token')
  await page
    .getByRole('button', { name: 'Connect provider', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Discover zones', exact: true })
    .click()
  await page.getByRole('button', { name: 'Manage zones', exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Discovered zone', exact: true })
    .selectOption(zone)
  const choice = page.getByRole('combobox', { name: 'Project', exact: true })
  await expect(choice.locator('option')).toHaveCount(2)
  await choice.selectOption('discord')
  await page.getByRole('button', { name: 'Configure access' }).click()
  await page.getByLabel('A', { exact: true }).check()
  await page.getByRole('button', { name: 'Add DNS rule' }).click()
  await page.getByRole('button', { name: 'Save project DNS access' }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0].path).toBe(
    `/projects/discord/dns/providers/provider/zones/${zone}/projects/discord`,
  )
})

test('project access adds a DNS member grant within the project delegation', async ({
  page,
}) => {
  const writes = await mockDns(page)
  await page.goto('/projects/discord/access')
  await page.getByRole('button', { name: 'Edit friend', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog
    .getByRole('combobox', { name: 'Domain', exact: true })
    .selectOption(zone)
  await dialog
    .getByRole('combobox', { name: 'Scope', exact: true })
    .selectOption('name')
  await dialog
    .getByLabel('Fully qualified DNS name')
    .fill('voice.discord.media')
  await dialog.getByLabel('A', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Add DNS rule' }).click()
  await dialog.getByRole('button', { name: 'Save member access' }).click()
  await expect(dialog).not.toBeVisible()
  expect(writes[0].body.dns_grants[0]).toEqual({
    zone_id: zone,
    kind: 'name',
    target: 'voice.discord.media',
    types: ['A'],
    actions: ['read'],
  })
})
