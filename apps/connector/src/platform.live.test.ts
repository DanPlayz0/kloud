import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { request as httpRequest } from 'node:http'
import { executeServiceRun } from './platform.js'
import { readConfig } from './config.js'
import { renderNginx } from './proxy.js'
import { domainSchema } from '@dedi-dash/protocol/platform'
import { runtimeOperations } from './runtime.js'
const docker = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  }).trim()
const http = (url: string) =>
  new Promise<string>((resolve, reject) => {
    const request = httpRequest(
      url,
      { headers: { host: 'app.example.com' }, agent: false },
      (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => resolve(body))
        response.on('error', reject)
      },
    )
    request.on('error', reject)
    request.end()
  })
test(
  'live image and Compose deployment, volume retention, rollback, and failed replacement recovery',
  { skip: process.env.RUN_PLATFORM_DOCKER !== '1', timeout: 180000 },
  async () => {
    const suffix = randomUUID().slice(0, 8),
      service = `web-${suffix}`,
      name = `dedi-platformtest-${service}`,
      volume = `dedi-platform-test-${suffix}`,
      stack = `stack-${suffix}`
    const root = await mkdtemp(join(tmpdir(), 'dedi-platform-test-'))
    const config = readConfig({ ...process.env, DEPLOYMENTS_DIR: root })
    const job: any = {
      id: randomUUID(),
      revision: randomUUID(),
      project: 'platformtest',
      service,
      config: {
        connector_id: randomUUID(),
        source: { type: 'image', image: 'nginx:stable-alpine' },
        runtime: { volumes: [{ source: volume, target: '/data' }] },
      },
    }
    const signal = AbortSignal.timeout(150000)
    try {
      const artifacts = await executeServiceRun(job, config, signal)
      assert.ok(artifacts.image)
      docker('exec', name, 'sh', '-c', 'echo retained > /data/marker')
      const withVariable = {
        ...job,
        id: randomUUID(),
        artifacts,
        config: {
          ...job.config,
          runtime: {
            ...job.config.runtime,
            environment: { REMOVED_VARIABLE: 'old-value' },
          },
        },
      }
      await executeServiceRun(withVariable, config, signal)
      assert.ok(
        JSON.parse(docker('inspect', name))[0].Config.Env.includes(
          'REMOVED_VARIABLE=old-value',
        ),
      )
      await executeServiceRun(
        { ...job, id: randomUUID(), artifacts },
        config,
        signal,
      )
      assert.equal(docker('exec', name, 'cat', '/data/marker'), 'retained')
      assert.ok(
        !JSON.parse(docker('inspect', name))[0].Config.Env.some(
          (value: string) => value.startsWith('REMOVED_VARIABLE='),
        ),
      )
      const runtime = runtimeOperations(config)
      const target = docker('inspect', '--format', '{{.Id}}', name)
      const base = { container: target, owner: 'test-owner' }
      const opened = (await runtime.execute({
        ...base,
        action: 'terminal-open',
      })) as { session: string }
      await runtime.execute({
        ...base,
        action: 'terminal-resize',
        session: opened.session,
        rows: 30,
        cols: 100,
      })
      await runtime.execute({
        ...base,
        action: 'terminal-write',
        session: opened.session,
        input: 'tty\r',
      })
      await delay(300)
      const terminal = (await runtime.execute({
        ...base,
        action: 'terminal-read',
        session: opened.session,
      })) as { output: string }
      assert.match(terminal.output, /\/dev\/pts\//)
      await assert.rejects(() =>
        runtime.execute({
          ...base,
          owner: 'another-user',
          action: 'terminal-read',
          session: opened.session,
        }),
      )
      await runtime.execute({
        ...base,
        action: 'terminal-close',
        session: opened.session,
      })
      await assert.rejects(() =>
        runtime.execute({
          ...base,
          action: 'terminal-read',
          session: opened.session,
        }),
      )
      runtime.close()
      await assert.rejects(() =>
        executeServiceRun(
          {
            ...job,
            id: randomUUID(),
            artifacts,
            config: {
              ...job.config,
              runtime: {
                ...job.config.runtime,
                healthcheck: { command: ['/bin/false'], intervalSeconds: 1 },
              },
            },
          },
          config,
          signal,
        ),
      )
      assert.equal(
        docker('inspect', '--format', '{{.State.Running}}', name),
        'true',
      )
      assert.equal(docker('exec', name, 'cat', '/data/marker'), 'retained')
      const composeJob = {
        ...job,
        id: randomUUID(),
        service: stack,
        config: {
          ...job.config,
          source: {
            type: 'compose',
            content: `services:\n  web:\n    image: nginx:stable-alpine\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n`,
          },
          runtime: {},
        },
      }
      const composeArtifacts = await executeServiceRun(
        composeJob,
        config,
        signal,
      )
      assert.ok(composeArtifacts.web)
      await executeServiceRun(
        { ...composeJob, id: randomUUID(), artifacts: composeArtifacts },
        config,
        signal,
      )
    } finally {
      try {
        docker('rm', '--force', name)
      } catch {}
      const ids = docker(
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=dedi-platformtest-${stack}`,
      )
        .split('\n')
        .filter(Boolean)
      if (ids.length) docker('rm', '--force', ...ids)
      for (const v of [volume, `dedi-platformtest-${stack}_data`])
        try {
          docker('volume', 'rm', v)
        } catch {}
      try {
        docker('network', 'rm', `dedi-platformtest-${stack}_default`)
      } catch {}
      await rm(root, { recursive: true, force: true })
    }
  },
)
test(
  'NGINX prototype keeps HTTP traffic and WebSockets alive through validated graceful reloads',
  { skip: process.env.RUN_PLATFORM_DOCKER !== '1', timeout: 120000 },
  async () => {
    const suffix = randomUUID().slice(0, 8),
      network = `dedi-proxy-test-${suffix}`,
      backend = `dedi-proxy-backend-${suffix}`,
      proxy = `dedi-proxy-test-${suffix}`
    const root = await mkdtemp(join(tmpdir(), 'dedi-proxy-test-'))
    let socket: WebSocket | undefined
    try {
      docker('network', 'create', network)
      const source = `const http=require('http'),crypto=require('crypto');const server=http.createServer((q,s)=>{if(q.url==='/stream'){let n=0;const t=setInterval(()=>{s.write('x');if(++n===30){clearInterval(t);s.end()}},100)}else s.end('ok')});server.on('upgrade',(q,s)=>{const key=crypto.createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');s.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+'\\r\\n\\r\\n');const timer=setInterval(()=>s.write(Buffer.from([129,2,111,107])),100);s.on('error',()=>clearInterval(timer));s.on('close',()=>clearInterval(timer));});server.listen(3000,'0.0.0.0');`
      docker(
        'run',
        '-d',
        '--name',
        backend,
        '--network',
        network,
        'node:22-alpine',
        'node',
        '-e',
        source,
      )
      const address = JSON.parse(docker('inspect', backend))[0].NetworkSettings
        .Networks[network].IPAddress
      const route = {
        config: domainSchema.parse({
          hostname: 'app.example.com',
          container: backend,
          network,
          port: 3000,
        }),
        address,
        certificate: false,
      }
      await writeFile(
        join(root, 'nginx.conf'),
        renderNginx([route], 'a'.repeat(64)),
      )
      docker(
        'create',
        '--name',
        proxy,
        '--network',
        network,
        '--publish',
        '127.0.0.1::80',
        'nginx:stable-alpine',
        'nginx',
        '-g',
        'daemon off;',
        '-c',
        '/etc/nginx/nginx.conf',
      )
      docker('cp', join(root, 'nginx.conf'), `${proxy}:/etc/nginx/nginx.conf`)
      docker('start', proxy)
      const port = JSON.parse(docker('inspect', proxy))[0].NetworkSettings
        .Ports['80/tcp'][0].HostPort
      const url = `http://127.0.0.1:${port}`
      for (let i = 0; i < 30; i++) {
        try {
          if ((await http(url)) === 'ok') break
        } catch {}
        await delay(100)
      }
      socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { host: 'app.example.com' },
      })
      await new Promise<void>((resolve, reject) => {
        socket!.once('open', resolve)
        socket!.once('error', reject)
      })
      let frames = 0,
        closed = false
      socket.on('message', () => frames++)
      socket.on('close', () => {
        closed = true
      })
      const requests = (async () => {
        for (let i = 0; i < 50; i++) {
          assert.equal(await http(url), 'ok')
          await delay(20)
        }
      })()
      void requests.catch(() => {})
      const stream = http(url + '/stream')
      void stream.catch(() => {})
      for (const revision of ['b', 'c', 'd']) {
        await writeFile(
          join(root, 'candidate.conf'),
          renderNginx([route], revision.repeat(64)),
        )
        docker(
          'cp',
          join(root, 'candidate.conf'),
          `${proxy}:/etc/nginx/candidate.conf`,
        )
        docker('exec', proxy, 'nginx', '-t', '-c', '/etc/nginx/candidate.conf')
        docker(
          'exec',
          proxy,
          'cp',
          '/etc/nginx/candidate.conf',
          '/etc/nginx/nginx.conf',
        )
        docker('exec', proxy, 'nginx', '-s', 'reload')
        await delay(200)
        assert.equal(
          docker(
            'exec',
            proxy,
            'wget',
            '-qO-',
            'http://127.0.0.1:8081/revision',
          ),
          revision.repeat(64),
        )
      }
      await writeFile(
        join(root, 'invalid.conf'),
        'invalid nginx configuration;',
      )
      docker(
        'cp',
        join(root, 'invalid.conf'),
        `${proxy}:/etc/nginx/candidate.conf`,
      )
      assert.throws(() =>
        docker('exec', proxy, 'nginx', '-t', '-c', '/etc/nginx/candidate.conf'),
      )
      await requests
      assert.equal((await stream).length, 30)
      assert.ok(frames > 0)
      assert.equal(closed, false)
    } finally {
      socket?.terminate()
      for (const name of [proxy, backend])
        try {
          docker('rm', '--force', name)
        } catch {}
      try {
        docker('network', 'rm', network)
      } catch {}
      await rm(root, { recursive: true, force: true })
    }
  },
)
