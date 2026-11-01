import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { readConfig } from './config.js'
import { hostTerminalOperations, openHostTerminal } from './host-terminal.js'

test('host SSH is opt-in and requires complete trusted configuration', () => {
  assert.equal(readConfig({}).hostTerminal, undefined)
  assert.throws(() => readConfig({ HOST_TERMINAL_ENABLED: 'true' }))
  assert.throws(() =>
    readConfig({
      HOST_TERMINAL_ENABLED: 'true',
      HOST_SSH_HOST: 'localhost',
      HOST_SSH_USER: 'app',
      HOST_SSH_PRIVATE_KEY_PATH: '/key',
      HOST_SSH_FINGERPRINT: 'untrusted',
    }),
  )
})

test('SSH shell verifies host key and supports input, output, resize and disconnect', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' })
    .toString()
  const parsed = ssh2.utils.parseKey(key)
  if (parsed instanceof Error) throw parsed
  const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
  const dir = await mkdtemp(join(tmpdir(), 'kloud-ssh-test-'))
  const privateKeyPath = join(dir, 'key')
  await writeFile(privateKeyPath, key)
  let dimensions: unknown
  const connections = new Set<import('ssh2').Connection>()
  const server = new ssh2.Server({ hostKeys: [key] }, (client) => {
    connections.add(client)
    client.on('error', () => {})
    client.on('close', () => connections.delete(client))
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (accept) => accept?.())
        session.on('window-change', (accept, _reject, info) => {
          dimensions = [info.rows, info.cols]
          accept?.()
        })
        session.on('shell', (accept) => {
          const channel = accept()
          channel.write('ready\r\n')
          channel.on('data', (data: Buffer) => channel.write(data))
        })
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || !address)
    throw new Error('No SSH listener')
  const config = {
    host: '127.0.0.1',
    port: address.port,
    username: 'app',
    privateKeyPath,
    fingerprint,
  }
  try {
    await assert.rejects(
      openHostTerminal({ ...config, fingerprint: `SHA256:${'A'.repeat(43)}` }),
    )
    const terminal = await openHostTerminal(config)
    try {
      terminal.write('hello\r')
      terminal.resize(40, 120)
      let output = ''
      for (let i = 0; i < 100; i++) {
        output += terminal.read().output
        if (output.includes('hello') && dimensions) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.match(output, /ready/)
      assert.match(output, /hello/)
      assert.deepEqual(dimensions, [40, 120])
    } finally {
      terminal.close()
    }
    assert.equal(terminal.read().exited, true)
  } finally {
    for (const connection of connections) connection.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('host sessions enforce owner, action, limit and disconnect cleanup', async () => {
  let closed = 0
  const config = readConfig({})
  config.hostTerminal = {
    host: 'localhost',
    port: 22,
    username: 'app',
    privateKeyPath: '/key',
    fingerprint: '',
  }
  const worker = hostTerminalOperations(config, async () => ({
    write() {},
    read: () => ({ output: 'shell', exited: false }),
    resize() {},
    close() {
      closed++
    },
  }))
  const execute = (action: string, session?: string, owner = 'alice') =>
    worker.execute({ kind: 'host-terminal', action, session, owner })
  const opened = await execute('terminal-open')
  assert.ok('session' in opened)
  const session = (opened as { session: string }).session
  await assert.rejects(execute('terminal-read', session, 'bob'), /expired/)
  await assert.rejects(execute('restart'), /Invalid terminal action/)
  assert.deepEqual(await execute('terminal-read', session), {
    output: 'shell',
    exited: false,
  })
  for (let i = 1; i < 20; i++) await execute('terminal-open')
  await assert.rejects(execute('terminal-open'), /limit/)
  worker.close()
  assert.equal(closed, 20)
  await assert.rejects(execute('terminal-read', session), /expired/)
  const disabled = hostTerminalOperations(readConfig({}))
  await assert.rejects(disabled.execute({}), /disabled/)
  disabled.close()
})
