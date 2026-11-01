import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import ssh2, { type ClientChannel } from 'ssh2'
import { runtimeRequestSchema } from '@kloud/protocol/platform'
import type { ConnectorConfig } from './config.js'

export async function openHostTerminal(
  config: NonNullable<ConnectorConfig['hostTerminal']>,
) {
  const privateKey = await readFile(config.privateKeyPath)
  const client = new ssh2.Client()
  let output = '',
    exited = false
  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    const timeout = setTimeout(
      () => fail(new Error('SSH shell timed out')),
      15000,
    )
    function fail(error: Error) {
      clearTimeout(timeout)
      exited = true
      client.destroy()
      reject(error)
    }
    client.on('error', fail)
    client.on('close', () => {
      exited = true
      clearTimeout(timeout)
      reject(new Error('SSH connection closed'))
    })
    client.on('ready', () => {
      client.shell(
        { term: 'xterm-256color', rows: 24, cols: 80 },
        (error, channel) => {
          if (error) return fail(error)
          clearTimeout(timeout)
          channel.setEncoding('utf8')
          channel.on('data', (chunk: string) => {
            output = (output + chunk).slice(-48000)
          })
          channel.on('error', fail)
          channel.on('close', () => {
            exited = true
            client.end()
          })
          resolve(channel)
        },
      )
    })
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey,
      hostVerifier: (key: Buffer) =>
        `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` ===
        config.fingerprint,
      readyTimeout: 10000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 2,
    })
  })
  return {
    write(input: string) {
      if (exited) throw new Error('Terminal exited')
      stream.write(input)
    },
    read() {
      const result = { output, exited }
      output = ''
      return result
    },
    resize(rows: number, cols: number) {
      if (!exited) stream.setWindow(rows, cols, 0, 0)
    },
    close() {
      exited = true
      stream.destroy()
      client.destroy()
    },
  }
}

export function hostTerminalOperations(
  config: ConnectorConfig,
  open = openHostTerminal,
) {
  const sessions = new Map<
    string,
    {
      owner: string
      touched: number
      terminal: Awaited<ReturnType<typeof openHostTerminal>>
    }
  >()
  let generation = 0,
    opening = 0
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions)
      if (Date.now() - session.touched > 30000) {
        session.terminal.close()
        sessions.delete(id)
      }
  }, 5000)
  cleanup.unref()
  return {
    close() {
      generation++
      for (const session of sessions.values()) session.terminal.close()
      sessions.clear()
    },
    async execute(raw: any) {
      if (!config.hostTerminal) throw new Error('Host terminal disabled')
      if (typeof raw.owner !== 'string' || !raw.owner)
        throw new Error('Invalid terminal owner')
      const { kind, owner, ...body } = raw
      if (kind !== 'host-terminal')
        throw new Error('Invalid terminal operation')
      const request = runtimeRequestSchema.parse(body)
      if (!request.action.startsWith('terminal-'))
        throw new Error('Invalid terminal action')
      if (request.action === 'terminal-open') {
        if (sessions.size + opening >= 20)
          throw new Error('Host terminal limit reached')
        const started = generation
        opening++
        try {
          const terminal = await open(config.hostTerminal)
          if (started !== generation) {
            terminal.close()
            throw new Error('Host disconnected')
          }
          const id = randomUUID()
          sessions.set(id, { owner, terminal, touched: Date.now() })
          return { session: id }
        } finally {
          opening--
        }
      }
      const session = sessions.get(request.session ?? '')
      if (!session || session.owner !== owner)
        throw new Error('Terminal session expired')
      session.touched = Date.now()
      switch (request.action) {
        case 'terminal-close':
          session.terminal.close()
          sessions.delete(request.session!)
          return { ok: true }
        case 'terminal-write':
          session.terminal.write(request.input ?? '')
          return { ok: true }
        case 'terminal-resize':
          session.terminal.resize(request.rows ?? 24, request.cols ?? 80)
          return { ok: true }
        default:
          return session.terminal.read()
      }
    },
  }
}
