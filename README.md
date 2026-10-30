# Dedi Dash

A pnpm workspaces monorepo with two private application packages in one Git repository:

- `apps/website`: Vite, React, TypeScript, and TanStack Router (file-based routes).
- `apps/api`: Hono, TypeScript, and `@hono/zod-openapi` for Zod schemas and OpenAPI generation.

## Getting started

Use Node.js 22.12+ and pnpm 12.16.1 (pinned in `packageManager`). With a Corepack-enabled
Node.js installation, run `corepack enable` to make the pinned pnpm version available.

```sh
pnpm install
pnpm dev
```

The website runs at http://localhost:5173 and the API at http://localhost:3000.
Vite proxies `/api/*` requests to the API during development (removing the `/api` prefix).
The API offers `GET /health` and its generated specification at `GET /openapi.json`.
Set the `PORT` environment variable to change the API port; update the Vite proxy target to match.

## Commands

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @dedi-dash/website dev
pnpm --filter @dedi-dash/api dev
pnpm --filter @dedi-dash/api start
pnpm --filter @dedi-dash/website preview
```

Build before running the API start command or website preview. For deployment, serve
`apps/website/dist` with an SPA fallback to `index.html` and proxy `/api/*` to the API
with the prefix removed. The Vite development proxy does not apply to production or preview.

Workspace packages are declared in `pnpm-workspace.yaml` and share `pnpm-lock.yaml`.
Use `pnpm install --frozen-lockfile` in CI to install the locked dependency versions.

## Website routes

Add route files under `apps/website/src/routes`. The TanStack Router Vite plugin
generates `src/routeTree.gen.ts` during development. Builds and type checks also
generate it automatically. The route tree and `.tanstack` cache are excluded from
Git and Docker build contexts; do not edit the generated route tree manually.

- `__root.tsx`: shared layout and not-found page; `<Outlet />` renders the current page.
- `index.tsx`: `/`.
- `about.tsx`: `/about`.
- `servers/index.tsx`: `/servers`.
- `servers/$serverId.tsx`: `/servers/:serverId` (dynamic parameter).

Each page exports `Route = createFileRoute('/path')({ component: Page })` from
`@tanstack/react-router`. The plugin keeps the route path in sync with the file.
Use `Route.useParams()` in a dynamic page to read parameters. Restart an existing
Vite dev server after changing the plugin configuration.

## Docker

Run both production apps from the repository root:

```sh
docker compose up --build -d
docker compose ps
```

Open http://localhost:8080 for the website. Nginx serves the built SPA with a fallback
for client-side routes and proxies `/api/*` to the API, removing the prefix.
Check http://localhost:8080/api/health or view the specification at
http://localhost:8080/api/openapi.json. The API is also available directly on port 3000.
Both images include health checks and run as non-root users; Compose waits for the
API to become healthy before starting the website.

Each app has a multi-stage Dockerfile. Always use the repository root as the build
context so pnpm can use the shared workspace lockfile:

```sh
docker build -f apps/api/Dockerfile -t dedi-dash-api .
docker build -f apps/website/Dockerfile -t dedi-dash-website .
```

The website container listens on port 8080 and uses `API_UPSTREAM=api:3000` by
default. When running the images outside Compose, put them on the same Docker
network and name the API container `api`, or set `API_UPSTREAM` to its host and port.
The upstream must resolve when Nginx starts. The API listens on port 3000 by default;
set `PORT` and adjust port mappings and `API_UPSTREAM` together to change it.

```sh
docker compose down
```
