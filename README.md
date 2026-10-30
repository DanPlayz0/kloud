# Dedi Dash

An npm workspaces monorepo with two private application packages in one Git repository:

- `apps/website`: Vite, React, TypeScript, and TanStack Router (code-based routes).
- `apps/api`: Hono, TypeScript, and `@hono/zod-openapi` for Zod schemas and OpenAPI generation.

## Getting started

Use Node.js 22.12+ and npm 11+.

```sh
npm install
npm run dev
```

The website runs at http://localhost:5173 and the API at http://localhost:3000.
Vite proxies `/api/*` requests to the API during development (removing the `/api` prefix).
The API offers `GET /health` and its generated specification at `GET /openapi.json`.
Set the `PORT` environment variable to change the API port; update the Vite proxy target to match.

## Commands

```sh
npm run build
npm run typecheck
npm test
npm run dev --workspace @dedi-dash/website
npm run dev --workspace @dedi-dash/api
npm run start --workspace @dedi-dash/api
npm run preview --workspace @dedi-dash/website
```

Build before running the API start command or website preview. For deployment, serve
`apps/website/dist` with an SPA fallback to `index.html` and proxy `/api/*` to the API
with the prefix removed. The Vite development proxy does not apply to production or preview.
