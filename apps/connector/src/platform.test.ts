import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRuntime } from './platform.js'
import { runtimeSchema, domainSchema } from '@kloud/protocol/platform'
import { renderNginx } from './proxy.js'
test('runtime settings retain image defaults and anonymous storage while applying declared limits and named volumes', () => {
  const spec = applyRuntime(
    {
      Env: ['DEFAULT=yes', 'TOKEN=old'],
      HostConfig: {
        Mounts: [
          { Type: 'volume', Source: 'a'.repeat(64), Target: '/anonymous' },
        ],
      },
    },
    runtimeSchema.parse({
      environment: { TOKEN: 'new' },
      ports: [{ host: 8080, container: 80 }],
      volumes: [{ source: 'data', target: '/data' }],
      networks: ['app'],
      memoryMb: 128,
      cpus: 0.5,
    }),
  )
  assert.deepEqual(spec.Env, ['DEFAULT=yes', 'TOKEN=new'])
  assert.equal(spec.HostConfig.Memory, 128 * 1024 * 1024)
  assert.equal(spec.HostConfig.NanoCpus, 500000000)
  assert.equal(spec.HostConfig.Mounts.length, 2)
  assert.deepEqual(spec.HostConfig.PortBindings['80/tcp'], [
    { HostIp: '0.0.0.0', HostPort: '8080' },
  ])
  assert.deepEqual(spec.NetworkingConfig.EndpointsConfig, { app: {} })
})
test('NGINX renders validated routes, challenge paths, WebSockets and a private revision probe', () => {
  const config = domainSchema.parse({
    hostname: 'app.example.com',
    container: 'web',
    network: 'app',
    port: 3000,
    https: true,
  })
  const text = renderNginx(
    [{ config, address: '172.20.0.2', certificate: true }],
    'a'.repeat(64),
  )
  assert.match(text, /listen 443 ssl/)
  assert.match(text, /proxy_pass http:\/\/172.20.0.2:3000/)
  assert.match(text, /\.well-known\/acme-challenge/)
  assert.match(text, /proxy_set_header Upgrade/)
  assert.match(text, /listen 8081/)
  assert.throws(() =>
    renderNginx(
      [{ config, address: '127.0.0.1; include /secret', certificate: true }],
      'a'.repeat(64),
    ),
  )
  assert.ok(
    !renderNginx(
      [{ config, address: '172.20.0.2', certificate: false }],
      'a'.repeat(64),
    ).includes('listen 443 ssl'),
  )
})
