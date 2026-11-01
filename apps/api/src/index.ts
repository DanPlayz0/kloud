import { cleanOrganizationExpirations } from './organizations.js'
import { serve } from '@hono/node-server'
import { app } from './app.js'
import { attachConnectors } from './connectors.js'
import { pool } from './db.js'

const port = Number(process.env.PORT ?? 3000)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535')
}

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`)
})
const closeConnectors = attachConnectors(server as import('node:http').Server)
const cleanup = setInterval(() => {
  void cleanOrganizationExpirations().catch((error) =>
    console.error('Expiry cleanup failed:', error.message),
  )
}, 60000)
cleanup.unref()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(cleanup)
    closeConnectors()
    server.close(() => {
      void pool.end()
    })
  })
}
