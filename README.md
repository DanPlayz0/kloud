# Dedi Dash

A pnpm workspaces monorepo for an authenticated Docker compute dashboard:

- `apps/website`: Vite, React, TypeScript, and TanStack Router (file-based routes).
- `apps/api`: Hono, TypeScript, and `@hono/zod-openapi` for Zod schemas and OpenAPI generation.
- `apps/connector`: Docker and optional PM2 inventory, metrics, and authorized operations over authenticated WebSocket.
- `apps/protocol`: shared versioned connector validation and types.

Services is the deployment workspace; Containers provides runtime operations.
Compute / PM2 supports existing Node process manager applications, logs, project
permissions, and lifecycle actions. See [PM2 setup](docs/PM2.md) for host and Docker
connector configuration.
See [service platform setup and limitations](docs/PLATFORM.md) for encrypted drafts,
Git/image/Compose deployment, runtime permissions, rollback, and managed NGINX.

See [dashboard setup](docs/SETUP.md) for PostgreSQL, migrations, administrator
bootstrap, passkey enrollment, Docker connectors, and deployment. See
[API contracts](docs/API.md) for endpoint and connector protocol details.

## Getting started

Use Node.js 22.12+ and pnpm 12.16.1 (pinned in `packageManager`).
Install pnpm with `npm install --global pnpm@12.16.1` if needed.

```sh
pnpm install
pnpm --filter @dedi-dash/api migrate
pnpm --filter @dedi-dash/api dev
pnpm --filter @dedi-dash/website dev
```

The website runs at http://localhost:5173 and the API at http://localhost:3000.
Vite proxies `/api/*` requests to the API during development (removing the `/api` prefix).
Configure PostgreSQL and `apps/api/.env` first as described in the setup guide.
On an empty installation, open the website to create your Server Administrator account
with a username, password, and passkey. Setup closes as soon as an account exists.
The API offers public `GET /health` and authenticated `GET /openapi.json`.
Set the `PORT` environment variable to change the API port; update the Vite proxy target to match.

## Commands

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @dedi-dash/website dev
pnpm --filter @dedi-dash/api dev
pnpm --filter @dedi-dash/connector dev
pnpm --filter @dedi-dash/api start
pnpm --filter @dedi-dash/website preview
```

Build before running the API start command or website preview. For deployment, serve
`apps/website/dist` with an SPA fallback to `index.html` and proxy `/api/*` to the API
with the prefix removed. The Vite development proxy does not apply to production or preview.

Workspace packages are declared in `pnpm-workspace.yaml` and share `pnpm-lock.yaml`.
Use `pnpm install --frozen-lockfile` in CI to install the locked dependency versions.

`pnpm dev` starts all three apps and requires a configured connector token.
The connector sends Docker inventory every five seconds and serves local liveness
at http://127.0.0.1:3001/health. Optional [GitHub deployments](docs/DEPLOYMENTS.md)
create and redeploy Dockerfile applications and Compose stacks on pushes or manual
commit builds. Compute / Services provides persistent services and granular access.

## Website routes

Add route files under `apps/website/src/routes`. The TanStack Router Vite plugin
generates `src/routeTree.gen.ts` during development. Builds and type checks also
generate it automatically. The route tree and `.tanstack` cache are excluded from
Git and Docker build contexts; do not edit the generated route tree manually.

- `__root.tsx`: shared layout and not-found page; `<Outlet />` renders the current page.
- `index.tsx`: `/`.
- `about.tsx`: `/about`.
- `/login` and `/enroll`: password and passkey authentication.
- `/projects/$projectSlug/compute/containers`: Docker compute.
- `/projects/$projectSlug/compute/serverless`: Kubernetes placeholder.
- `/projects/$projectSlug/services`: Dockerfile applications and Compose services.
- `/projects/$projectSlug/applications/$appSlug`: deployment configuration and build history.
- `/projects/$projectSlug/access`: project roles, invitations, service permissions, container grants, and matching defaults.
- `/admin/$section`: server administration, authorized by individual capabilities.

Server Administrators have unrestricted access. Server capabilities independently
delegate users, projects (including project access and visibility), connectors,
and inventory management. Project Administrators manage members and container
grants within their project. Members need View grants for selected container IDs,
exact names on a connector, or all project containers. Existing memberships retain
project-wide View access after migration; new members start without grants.
Service grants independently control read, create, update, delete, and deploy for
one service or every service in a project. Service read follows container replacement;
deploy permits repository builds on a host. Create grants access to the new service
without granting deployment permission. Migration 6 imports existing services.
Logs, lifecycle, terminal, and configuration grants are stored for future features.
See [project access and container grants](docs/API.md#project-access-and-container-grants)
for matching rules and administrative safeguards.

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

Copy `.env.example` to `.env` first. PostgreSQL and the one-shot migration service
start before the API. Bootstrap an administrator using the setup guide.
Open http://localhost:8080 for the website. Nginx serves the built SPA with a fallback
for client-side routes and proxies `/api/*` to the API, removing the prefix.
Check http://localhost:8080/api/health or, after signing in, view the specification at
http://localhost:8080/api/openapi.json. The API is also available directly on port 3000.
Both images include health checks and run as non-root users; Compose waits for the
API to become healthy before starting the website.

Each app has a multi-stage Dockerfile. Always use the repository root as the build
context so pnpm can use the shared workspace lockfile:

```sh
docker build -f apps/api/Dockerfile -t dedi-dash-api .
docker build -f apps/website/Dockerfile -t dedi-dash-website .
docker build -f apps/connector/Dockerfile -t dedi-dash-connector .
```

The website container listens on port 8080 and uses `API_UPSTREAM=api:3000` by
default. When running the images outside Compose, put them on the same Docker
network and name the API container `api`, or set `API_UPSTREAM` to its host and port.
The upstream must resolve when Nginx starts. The API listens on port 3000 by default;
set `PORT` and adjust port mappings and `API_UPSTREAM` together to change it.

Include the optional connector with `docker compose --profile connector up --build -d`.
It connects outbound to the API and publishes no host ports. Configure its token
and Docker socket permissions as documented in [dashboard setup](docs/SETUP.md).

```sh
docker compose down
```

## Cloud DNS

Cloudflare connections support shared server providers, private project providers,
and DNS delegation down to individual records. See [Cloud DNS setup](docs/DNS.md)
for the required encryption key, token permissions, and sharing model.
