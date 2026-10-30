import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'

export const app = new OpenAPIHono()

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  summary: 'Check API health',
  responses: {
    200: {
      description: 'The API is healthy',
      content: {
        'application/json': {
          schema: z.object({ status: z.literal('ok') }).openapi('Health'),
        },
      },
    },
  },
})

app.openapi(healthRoute, (c) => c.json({ status: 'ok' as const }, 200))

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: { title: 'Dedi Dash API', version: '0.1.0' },
})
