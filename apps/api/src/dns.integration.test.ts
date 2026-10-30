import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { dnsTypes, type DnsRule } from '@dedi-dash/protocol/dns'

test(
  'DNS delegation, private ownership, revocation, concurrency and Discord sharing',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const schema = `dns_${randomUUID().replaceAll('-', '')}`
    await database.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = url.href
    process.env.DNS_ENCRYPTION_KEY = '12'.repeat(32)
    const { pool } = await import('./db.js'),
      { migrate } = await import('./migrate.js'),
      { app } = await import('./app.js')
    const { digest, token, publicOrigin } = await import('./security.js')
    const originalFetch = globalThis.fetch
    let changes = 0,
      hold: (() => Promise<void>) | undefined
    const live = new Map<string, any[]>(
      ['discord.com', 'discord.gg', 'discord.new', 'discord.media'].map(
        (name, i) => [
          String(i + 1).padStart(32, '0'),
          [
            {
              id: 'a'.repeat(32),
              type: 'A',
              name: `voice.${name}`,
              ttl: 1,
              content: '192.0.2.1',
            },
            {
              id: 'b'.repeat(32),
              type: 'TXT',
              name: `mail.${name}`,
              ttl: 1,
              content: 'private-mail',
            },
          ],
        ],
      ),
    )
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'https://api.cloudflare.com')
      if (url.pathname === '/client/v4/zones')
        return Response.json({
          success: true,
          result: [...live.keys()].map((id, i) => ({
            id,
            name: ['discord.com', 'discord.gg', 'discord.new', 'discord.media'][
              i
            ],
          })),
          result_info: { total_pages: 1 },
        })
      const [, zone, id] =
        url.pathname.match(/zones\/([^/]+)\/dns_records(?:\/([^/]+))?/) ?? []
      assert.ok(zone)
      const records = live.get(zone)!
      if (!init?.method || init.method === 'GET')
        return Response.json({
          success: true,
          result: id ? records.find((r) => r.id === id) : records,
          result_info: { total_pages: 1 },
        })
      if (hold) await hold()
      changes++
      if (init.method === 'DELETE') {
        const index = records.findIndex((r) => r.id === id)
        if (index >= 0) records.splice(index, 1)
        return Response.json({ success: true, result: { id } })
      }
      const body = JSON.parse(String(init.body)),
        next = {
          ...(id ? records.find((r) => r.id === id) : {}),
          ...body,
          id: id ?? 'c'.repeat(32),
        }
      if (id) records[records.findIndex((r) => r.id === id)] = next
      else records.push(next)
      return Response.json({ success: true, result: next })
    }
    const admin = randomUUID(),
      pa = randomUUID(),
      friend = randomUUID(),
      outsider = randomUUID(),
      cookies = new Map<string, string>()
    const request = (
      actor: string,
      path: string,
      method = 'GET',
      body?: unknown,
    ) =>
      app.request(path, {
        method,
        headers: {
          origin: publicOrigin,
          cookie: cookies.get(actor) ?? '',
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const full: DnsRule = {
      kind: 'zone',
      target: null,
      types: dnsTypes,
      actions: ['read', 'create', 'update', 'delete'],
    }
    try {
      await migrate()
      await migrate()
      await pool.query(
        "INSERT INTO projects(slug,name) VALUES('discord','Discord'),('voice','Voice')",
      )
      for (const [id, name, isAdmin] of [
        [admin, 'admin', true],
        [pa, 'project-admin', false],
        [friend, 'friend', false],
        [outsider, 'outsider', false],
      ] as const) {
        await pool.query(
          'INSERT INTO users(id,username,admin) VALUES($1,$2,$3)',
          [id, name, isAdmin],
        )
        const secret = token()
        cookies.set(id, `session=${secret}`)
        await pool.query(
          "INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
          [digest(secret), id],
        )
      }
      await pool.query(
        "INSERT INTO memberships(user_id,project_slug,role) VALUES($1,'discord','admin'),($2,'discord','member'),($2,'voice','member')",
        [pa, friend],
      )
      const base = '/admin/dns/providers'
      assert.equal((await request(pa, base)).status, 403)
      const connected = await request(admin, base, 'POST', {
        name: 'Shared Cloudflare',
        token: 'secret-cloudflare-token',
      })
      assert.equal(connected.status, 201)
      const { id } = (await connected.json()) as any,
        providerBase = `${base}/${id}`
      assert.ok(
        !(await (await request(admin, base)).text()).includes(
          'secret-cloudflare-token',
        ),
      )
      assert.notEqual(
        (
          await pool.query(
            'SELECT encrypted_token FROM dns_providers WHERE id=$1',
            [id],
          )
        ).rows[0].encrypted_token,
        'secret-cloudflare-token',
      )
      await t.test(
        'discovery grants nothing; projects explicitly associate multiple zones',
        async () => {
          assert.equal(
            (await request(admin, `${providerBase}/discover`, 'POST')).status,
            200,
          )
          assert.equal(
            ((await (await request(pa, '/projects/discord/dns')).json()) as any)
              .zones.length,
            0,
          )
        },
      )
      const zones = (await (
          await request(admin, `${providerBase}/zones`)
        ).json()) as any[],
        media = zones.find((z) => z.name === 'discord.media')!
      for (const zone of zones)
        assert.equal(
          (
            await request(
              admin,
              `${providerBase}/zones/${zone.id}/projects/discord`,
              'PUT',
              { rules: [full] },
            )
          ).status,
          200,
        )
      assert.equal(
        (
          await request(
            admin,
            `${providerBase}/zones/${media.id}/projects/voice`,
            'PUT',
            {
              rules: [
                {
                  ...full,
                  kind: 'subtree',
                  target: 'voice.discord.media',
                  types: ['A'],
                },
              ],
            },
          )
        ).status,
        200,
      )
      const path = `/projects/discord/dns/zones/${media.id}/records`,
        memberPath = `/projects/discord/access/members/${friend}`
      await t.test(
        'project admins see four domains, members and outsiders start without access',
        async () => {
          assert.equal(
            ((await (await request(pa, '/projects/discord/dns')).json()) as any)
              .zones.length,
            4,
          )
          assert.equal(
            (
              (await (
                await request(friend, '/projects/discord/dns')
              ).json()) as any
            ).zones.length,
            0,
          )
          assert.equal((await request(friend, path)).status, 404)
          assert.equal((await request(outsider, path)).status, 404)
        },
      )
      const memberGrant = {
        ...full,
        kind: 'name',
        target: 'voice.discord.media',
        types: ['A'],
        zone_id: media.id,
      }
      await t.test(
        'friend sees and changes only granted record, cannot rename or change type to escape',
        async () => {
          assert.equal(
            (
              await request(pa, memberPath, 'PUT', {
                role: 'member',
                grants: [],
                dns_grants: [memberGrant],
              })
            ).status,
            200,
          )
          const visible = (await (await request(friend, path)).json()) as any
          assert.equal(visible.records.length, 1)
          assert.equal(visible.creation_scopes[0].target, 'voice.discord.media')
          assert.equal(
            (await request(friend, `${path}/${'b'.repeat(32)}`)).status,
            404,
          )
          const body = {
            type: 'A',
            name: 'voice.discord.media',
            ttl: 60,
            content: '192.0.2.2',
          }
          assert.equal(
            (await request(friend, `${path}/${'a'.repeat(32)}`, 'PUT', body))
              .status,
            200,
          )
          assert.equal(
            (
              await request(friend, `${path}/${'a'.repeat(32)}`, 'PUT', {
                ...body,
                name: 'mail.discord.media',
              })
            ).status,
            403,
          )
          assert.equal(
            (
              await request(friend, `${path}/${'a'.repeat(32)}`, 'PUT', {
                ...body,
                type: 'TXT',
              })
            ).status,
            403,
          )
          assert.equal(
            (
              await request(friend, path, 'POST', {
                ...body,
                name: 'outside.discord.media',
              })
            ).status,
            403,
          )
          // Omitting dns_grants preserves them.
          assert.equal(
            (
              await request(pa, memberPath, 'PUT', {
                role: 'member',
                grants: [],
              })
            ).status,
            200,
          )
          assert.equal((await request(friend, path)).status, 200)
        },
      )
      await t.test(
        'project grants cap broad stored member rules and shared projects see the same live record',
        async () => {
          assert.equal(
            (
              await request(
                admin,
                '/projects/voice/access/members/' + friend,
                'PUT',
                {
                  role: 'member',
                  grants: [],
                  dns_grants: [{ ...memberGrant, kind: 'zone', target: null }],
                },
              )
            ).status,
            400,
          )
          assert.equal(
            (
              await request(
                admin,
                '/projects/voice/access/members/' + friend,
                'PUT',
                { role: 'member', grants: [], dns_grants: [memberGrant] },
              )
            ).status,
            200,
          )
          const other = (await (
            await request(
              friend,
              `/projects/voice/dns/zones/${media.id}/records`,
            )
          ).json()) as any
          assert.equal(other.records[0].content, '192.0.2.2')
          assert.equal(
            (
              await request(
                admin,
                `${providerBase}/zones/${media.id}/projects/discord`,
                'PUT',
                { rules: [{ ...full, actions: ['read'] }] },
              )
            ).status,
            200,
          )
          assert.equal(
            (
              await request(friend, `${path}/${'a'.repeat(32)}`, 'PUT', {
                type: 'A',
                name: 'voice.discord.media',
                ttl: 1,
                content: '192.0.2.3',
              })
            ).status,
            403,
          )
          await request(
            admin,
            `${providerBase}/zones/${media.id}/projects/discord`,
            'PUT',
            { rules: [full] },
          )
        },
      )
      await t.test(
        'private connections cannot be shared and disconnection never deletes live DNS',
        async () => {
          const privateBase = '/projects/discord/dns/providers',
            created = await request(pa, privateBase, 'POST', {
              name: 'Private',
              token: 'private-token',
            })
          assert.equal(created.status, 201)
          const privateId = ((await created.json()) as any).id
          assert.equal((await request(friend, privateBase)).status, 403)
          assert.equal(
            (await request(admin, `${base}/${privateId}/test`, 'POST')).status,
            404,
          )
          await request(pa, `${privateBase}/${privateId}/discover`, 'POST')
          const privateZones = (await (
            await request(pa, `${privateBase}/${privateId}/zones`)
          ).json()) as any[]
          assert.equal(
            (
              await request(
                pa,
                `${privateBase}/${privateId}/zones/${privateZones[0].id}/projects/voice`,
                'PUT',
                { rules: [full] },
              )
            ).status,
            403,
          )
          assert.equal(
            (
              await request(
                pa,
                `${privateBase}/${privateId}/zones/${privateZones[0].id}/projects/discord`,
                'PUT',
                { rules: [full] },
              )
            ).status,
            200,
          )
          const before = changes
          assert.equal(
            (await request(pa, `${privateBase}/${privateId}`, 'DELETE')).status,
            200,
          )
          assert.equal(changes, before)
        },
      )
      await t.test(
        'member revocation waits for dispatched write, then prevents subsequent writes',
        async () => {
          let enter!: () => void, release!: () => void
          const entered = new Promise<void>((resolve) => (enter = resolve)),
            blocked = new Promise<void>((resolve) => (release = resolve))
          hold = async () => {
            enter()
            await blocked
          }
          const write = request(friend, `${path}/${'a'.repeat(32)}`, 'PUT', {
            type: 'A',
            name: 'voice.discord.media',
            ttl: 1,
            content: '192.0.2.4',
          })
          await entered
          const revoke = request(pa, memberPath, 'PUT', {
            role: 'member',
            grants: [],
            dns_grants: [],
          })
          release()
          assert.equal((await write).status, 200)
          assert.equal((await revoke).status, 200)
          hold = undefined
          const before = changes
          assert.equal((await request(friend, path)).status, 404)
          assert.equal(
            (
              await request(friend, path, 'POST', {
                type: 'A',
                name: 'voice.discord.media',
                ttl: 1,
                content: '192.0.2.5',
              })
            ).status,
            404,
          )
          assert.equal(changes, before)
        },
      )
      await t.test(
        'record-ID grants stop following deleted records; disablement and project deletion remove access',
        async () => {
          const recordGrant = {
            ...memberGrant,
            kind: 'record',
            target: 'a'.repeat(32),
            actions: ['read', 'update'],
          }
          assert.equal(
            (
              await request(pa, memberPath, 'PUT', {
                role: 'member',
                grants: [],
                dns_grants: [recordGrant],
              })
            ).status,
            200,
          )
          const records = live.get('4'.padStart(32, '0'))!
          records[0] = { ...records[0], id: 'd'.repeat(32) }
          assert.equal(
            (
              (await (
                await request(friend, '/projects/discord/dns')
              ).json()) as any
            ).zones.length,
            0,
          )
          assert.equal((await request(friend, path)).status, 404)
          await request(admin, providerBase, 'PUT', { enabled: false })
          assert.equal((await request(pa, path)).status, 404)
          await request(admin, providerBase, 'PUT', { enabled: true })
          const before = changes
          await request(admin, '/admin/projects/voice', 'DELETE')
          assert.equal(changes, before)
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM dns_delegations WHERE project_slug='voice'",
              )
            ).rowCount,
            0,
          )
        },
      )
      await t.test('OpenAPI includes DNS interfaces', async () => {
        const res = await request(admin, '/openapi.json')
        assert.equal(res.status, 200)
        const doc = (await res.json()) as any
        assert.ok(doc.paths['/admin/dns/providers'])
        assert.ok(doc.paths['/projects/{project}/dns/zones/{zone}/records'])
      })
    } finally {
      globalThis.fetch = originalFetch
      await pool.end()
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      await database.end()
    }
  },
)
