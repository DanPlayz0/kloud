import {
  mkdir,
  writeFile,
  rename,
  readFile,
  chmod,
  stat,
} from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash, X509Certificate } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { domainSchema, type Domain } from '@kloud/protocol/platform'
import type { ConnectorConfig } from './config.js'
import { engine, dockerHost, runCommand } from './deployment-process.js'
import { platformPost } from './platform.js'

export function renderNginx(
  routes: { config: Domain; address: string; certificate: boolean }[],
  revision: string,
) {
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new Error('Invalid proxy revision')
  const hosts = new Map<string, typeof routes>()
  for (const route of routes) {
    domainSchema.parse(route.config)
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(route.address))
      throw new Error('Proxy upstream must be an IPv4 container endpoint')
    const list = hosts.get(route.config.hostname) ?? []
    list.push(route)
    hosts.set(route.config.hostname, list)
  }
  const challenge =
    'location ^~ /.well-known/acme-challenge/ { root /var/www/acme; }'
  const servers = [...hosts]
    .map(([hostname, targets]) => {
      const tls = targets.every((t) => t.certificate)
      const locations = targets
        .map(
          ({ config, address }) =>
            `location ${config.path} { proxy_pass http://${address}:${config.port}; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade; proxy_read_timeout 3600s; }`,
        )
        .join('\n')
      const http =
        tls && targets.every((t) => t.config.redirect)
          ? 'location / { return 308 https://$host$request_uri; }'
          : locations
      return `server { listen 80; server_name ${hostname}; ${challenge} ${http} }\n${tls ? `server { listen 443 ssl; server_name ${hostname}; ssl_certificate /etc/letsencrypt/live/${hostname}/fullchain.pem; ssl_certificate_key /etc/letsencrypt/live/${hostname}/privkey.pem; ${locations} }` : ''}`
    })
    .join('\n')
  return `worker_processes auto;\nerror_log /dev/stderr warn;\npid /var/run/nginx.pid;\nevents { worker_connections 4096; }\nhttp { access_log /dev/stdout; map $http_upgrade $connection_upgrade { default upgrade; '' close; } server { listen 8081; location = /revision { return 200 '${revision}'; } } server { listen 80 default_server; server_name _; ${challenge} location / { return 404; } } ${servers} }\n`
}

export async function proxyWorker(
  config: ConnectorConfig,
  signal: AbortSignal,
) {
  const root = resolve(config.deploymentsDir, 'proxy'),
    name = 'kloud-nginx'
  await mkdir(root, { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'acme'), { recursive: true, mode: 0o755 })
  await chmod(join(root, 'acme'), 0o755)
  await mkdir(join(root, 'certificates'), { recursive: true, mode: 0o700 })
  const docker = ['--host', dockerHost(config.dockerSocket)]
  const image = process.env.PROXY_NGINX_IMAGE ?? 'nginx:stable-alpine'
  let certificates: Record<string, 'ready' | 'pending' | 'error'> = {}
  let applied: string | null = null,
    error: string | null = null,
    activeHash = '',
    renewal = 0
  const run = async (args: string[]) => {
    let output = ''
    try {
      return await runCommand(
        'docker',
        [...docker, ...args],
        root,
        AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        (text) => {
          output = (output + text).slice(-2000)
        },
      )
    } catch {
      throw new Error(
        output.trim().slice(-500) ||
          'NGINX command failed; check image availability, free ports 80/443, and host directory permissions',
      )
    }
  }
  const mount = [
    '--mount',
    `type=bind,source=${root},target=/etc/kloud,readonly`,
    '--mount',
    `type=bind,source=${join(root, 'acme')},target=/var/www/acme,readonly`,
    '--mount',
    `type=bind,source=${join(root, 'certificates')},target=/etc/letsencrypt,readonly`,
  ]
  async function activate(content: string) {
    await writeFile(join(root, 'candidate.conf'), content)
    await run([
      'run',
      '--rm',
      '--label',
      'kloud.internal=true',
      ...mount,
      image,
      'nginx',
      '-t',
      '-c',
      '/etc/kloud/candidate.conf',
    ])
    let old: string | undefined
    try {
      old = await readFile(join(root, 'active.conf'), 'utf8')
    } catch {}
    await rename(join(root, 'candidate.conf'), join(root, 'active.conf'))
    try {
      let proxy: any
      try {
        proxy = await engine(
          config.dockerSocket,
          'GET',
          `/containers/${name}/json`,
        )
      } catch (e) {
        if (!(
          e instanceof Error && e.message.startsWith('Docker GET failed (404):')
        ))
          throw e
      }
      if (proxy) {
        if (
          proxy.Config.Labels?.['kloud.internal'] !== 'true' ||
          proxy.Config.Labels?.['kloud.proxy'] !== 'true'
        )
          throw new Error('Proxy container name is already occupied')
        if (!proxy.State.Running)
          await engine(config.dockerSocket, 'POST', `/containers/${name}/start`)
        await run([
          'exec',
          name,
          'nginx',
          '-s',
          'reload',
          '-c',
          '/etc/kloud/active.conf',
        ])
      } else {
        await run([
          'run',
          '--detach',
          '--name',
          name,
          '--label',
          'kloud.internal=true',
          '--label',
          'kloud.proxy=true',
          '--restart',
          'unless-stopped',
          '--publish',
          '80:80',
          '--publish',
          '443:443',
          ...mount,
          image,
          'nginx',
          '-g',
          'daemon off;',
          '-c',
          '/etc/kloud/active.conf',
        ])
      }
      const revision = content.match(/return 200 '([a-f0-9]{64})'/)?.[1]
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          if (
            (
              await run([
                'exec',
                name,
                'wget',
                '-qO-',
                'http://127.0.0.1:8081/revision',
              ])
            ).trim() === revision
          )
            return
        } catch {}
        await delay(300, undefined, { signal })
      }
      throw new Error('Proxy did not activate the expected revision')
    } catch (e) {
      if (old) {
        await writeFile(join(root, 'restore.conf'), old)
        await rename(join(root, 'restore.conf'), join(root, 'active.conf'))
        await run([
          'exec',
          name,
          'nginx',
          '-s',
          'reload',
          '-c',
          '/etc/kloud/active.conf',
        ]).catch(() => {})
      }
      throw e
    }
  }
  while (!signal.aborted) {
    try {
      const state = await platformPost(
        config,
        'proxy',
        { applied, error, certificates },
        signal,
      )
      const targets: {
        config: Domain
        address: string
        certificate: boolean
      }[] = []
      const nextCertificates: typeof certificates = {}
      const networks = new Set<string>()
      for (const route of state.routes) {
        const domain = domainSchema.parse(route.config)
        const target = await engine(
          config.dockerSocket,
          'GET',
          `/containers/${encodeURIComponent(domain.container)}/json`,
        )
        if (
          target.Config.Labels?.['kloud.project'] !== route.project ||
          target.Config.Labels?.['kloud.application'] !== route.service ||
          target.Config.Labels?.['kloud.internal'] === 'true'
        )
          throw new Error('Route target is not owned by its service')
        const address =
          target.NetworkSettings.Networks?.[domain.network]?.IPAddress
        if (!address)
          throw new Error('Route network is not attached to its container')
        networks.add(domain.network)
        let certificate = false
        if (domain.https)
          try {
            const pem = await readFile(
              join(
                root,
                'certificates',
                'live',
                domain.hostname,
                'fullchain.pem',
              ),
            )
            const leaf = new X509Certificate(pem)
            certificate =
              Date.parse(leaf.validTo) > Date.now() &&
              Date.parse(leaf.validFrom) <= Date.now() &&
              !!leaf.checkHost(domain.hostname)
          } catch {}
        if (domain.https)
          nextCertificates[domain.hostname] = certificate ? 'ready' : 'pending'
        targets.push({ config: domain, address, certificate })
      }
      certificates = nextCertificates
      const hash = createHash('sha256')
        .update(JSON.stringify(targets))
        .digest('hex')
      if (hash !== activeHash) {
        // Bootstrap the challenge server before certificate issuance.
        let exists = false
        try {
          await engine(config.dockerSocket, 'GET', `/containers/${name}/json`)
          exists = true
        } catch (e) {
          if (!(
            e instanceof Error &&
            e.message.startsWith('Docker GET failed (404):')
          ))
            throw e
        }
        if (!exists) {
          const containers = await engine(
            config.dockerSocket,
            'GET',
            '/containers/json',
          )
          if (
            containers.some((c: any) =>
              c.Ports?.some(
                (p: any) => p.PublicPort === 80 || p.PublicPort === 443,
              ),
            )
          )
            throw new Error('Ports 80 or 443 are occupied by another container')
          await activate(renderNginx([], hash))
        }
        for (const network of networks) {
          const proxy = await engine(
            config.dockerSocket,
            'GET',
            `/containers/${name}/json`,
          )
          if (!proxy.NetworkSettings.Networks?.[network])
            await engine(
              config.dockerSocket,
              'POST',
              `/networks/${encodeURIComponent(network)}/connect`,
              { Container: name },
            )
        }
        await activate(renderNginx(targets, hash))
        activeHash = hash
      }
      for (const target of targets)
        if (target.config.https && !target.certificate) {
          try {
            await run([
              'run',
              '--rm',
              '--label',
              'kloud.internal=true',
              '--mount',
              `type=bind,source=${join(root, 'acme')},target=/var/www/acme`,
              '--mount',
              `type=bind,source=${join(root, 'certificates')},target=/etc/letsencrypt`,
              process.env.PROXY_CERTBOT_IMAGE ?? 'certbot/certbot:latest',
              'certonly',
              '--non-interactive',
              '--agree-tos',
              '--register-unsafely-without-email',
              '--webroot',
              '-w',
              '/var/www/acme',
              '-d',
              target.config.hostname,
            ])
            activeHash = ''
          } catch {
            certificates[target.config.hostname] = 'error'
          }
        }
      if (
        Date.now() - renewal > 12 * 60 * 60 * 1000 &&
        targets.some((t) => t.certificate)
      ) {
        const marker = join(root, 'certificates', '.kloud-renewed')
        const before = await stat(marker)
          .then((s) => s.mtimeMs)
          .catch(() => 0)
        await run([
          'run',
          '--rm',
          '--label',
          'kloud.internal=true',
          '--mount',
          `type=bind,source=${join(root, 'acme')},target=/var/www/acme`,
          '--mount',
          `type=bind,source=${join(root, 'certificates')},target=/etc/letsencrypt`,
          process.env.PROXY_CERTBOT_IMAGE ?? 'certbot/certbot:latest',
          'renew',
          '--deploy-hook',
          'touch /etc/letsencrypt/.kloud-renewed',
          '--webroot',
          '-w',
          '/var/www/acme',
        ])
        const renewed = await stat(marker)
          .then((s) => s.mtimeMs > before)
          .catch(() => false)
        if (renewed) {
          await run([
            'exec',
            name,
            'nginx',
            '-t',
            '-c',
            '/etc/kloud/active.conf',
          ])
          await run([
            'exec',
            name,
            'nginx',
            '-s',
            'reload',
            '-c',
            '/etc/kloud/active.conf',
          ])
        }
        renewal = Date.now()
      }
      applied = activeHash ? state.desired : null
      error = null
    } catch (e) {
      error =
        e instanceof Error
          ? e.message.slice(0, 500)
          : 'Proxy reconciliation failed'
    }
    await delay(5000, undefined, { signal }).catch(() => {})
  }
}
