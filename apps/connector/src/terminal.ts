import { request } from 'node:http'
import type { Duplex } from 'node:stream'
import { engine } from './deployment-process.js'

export async function openTerminal(socketPath: string, container: string) {
  const exec = await engine(
    socketPath,
    'POST',
    `/containers/${container}/exec`,
    {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: ['/bin/sh'],
      Env: ['TERM=xterm-256color'],
    },
  )
  const socket = await new Promise<Duplex>((resolve, reject) => {
    const body = JSON.stringify({ Detach: false, Tty: true })
    const req = request({
      socketPath,
      method: 'POST',
      path: `/exec/${exec.Id}/start`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'tcp',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    })
    req.once('upgrade', (_response, stream, head) => {
      if (head.length) stream.unshift(head)
      resolve(stream)
    })
    req.once('response', (response) => {
      response.resume()
      reject(new Error(`Terminal attach returned ${response.statusCode}`))
    })
    req.once('error', reject)
    req.setTimeout(10000, () =>
      req.destroy(new Error('Terminal attach timed out')),
    )
    req.end(body)
  })
  socket.setEncoding('utf8')
  ;(socket as import('node:net').Socket).setTimeout(0)
  let output = '',
    exited = false
  socket.on('data', (chunk) => {
    output = (output + chunk).slice(-48000)
  })
  socket.on('error', () => {
    exited = true
  })
  socket.on('close', () => {
    exited = true
  })
  return {
    write(input: string) {
      if (exited) throw new Error('Terminal exited')
      socket.write(input)
    },
    read() {
      const result = { output, exited }
      output = ''
      return result
    },
    resize(rows: number, cols: number) {
      return engine(
        socketPath,
        'POST',
        `/exec/${exec.Id}/resize?h=${rows}&w=${cols}`,
      )
    },
    close() {
      socket.write('\x03\x04')
      socket.end()
      socket.destroy()
    },
  }
}
