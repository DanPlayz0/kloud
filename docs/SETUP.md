# Dashboard setup

The website requires password **and** passkey authentication. PostgreSQL stores
accounts, sessions, project access, connector credentials, inventory, and manual
assignments. There is no public signup, password-only login, or demo-data fallback.

## Local Docker Compose

1. Copy the root `.env.example` to `.env`.
2. Run `docker compose up --build -d`. PostgreSQL starts first, then the one-shot
   migration service, then the API and website.
3. Open `http://localhost:8080`. With no accounts, the website prompts you to
   create the Server Administrator with a username, a password of at least 12 characters,
   and a passkey. The account is created only after successful passkey registration.
4. Sign in using both factors. Setup is unavailable once any account exists.
5. In **Administration → Projects**, create a project. In **Connectors**, create
   a connector and copy its token immediately; it cannot be retrieved later.

Local Compose uses the development database password `dedi_dash_local`. For
production, set a strong `POSTGRES_PASSWORD` and the matching password in
`DATABASE_URL` before creating the PostgreSQL volume. Changing the environment
does not change a password in an existing volume.

## Connect a Docker host

Run the connector on each Docker host. It connects outbound to the API over
WebSocket; the dashboard never connects to an exposed Docker daemon.

For the host running Compose, set `CONNECTOR_TOKEN`, `CONNECTOR_HOST`, and
`DOCKER_GID` in the root `.env`, then run:

```sh
docker compose --profile connector up --build -d connector
```

On Linux, obtain the socket group with `stat -c '%g' /var/run/docker.sock` and use
it as `DOCKER_GID`. The connector runs as a non-root user with this extra group.
The socket mount allows access to the Docker API; the connector issues only GET
requests. A read-only socket mount does not itself restrict Docker API methods.

For a separate host, install the workspace and build the connector, copy
`apps/connector/.env.example` to `apps/connector/.env`, configure it, then run
`pnpm --filter @dedi-dash/connector start`. Use `API_URL=https://dashboard.example.com/api/`
for an externally hosted dashboard. Windows defaults to `//./pipe/docker_engine`;
set `DOCKER_SOCKET` explicitly if your Docker engine uses a different named pipe.

| Variable           | Default                   | Meaning                                                      |
| ------------------ | ------------------------- | ------------------------------------------------------------ |
| `API_URL`          | `http://localhost:3000`   | HTTP(S) API base; `/api/` is needed behind the website proxy |
| `CONNECTOR_TOKEN`  | Required                  | Unique token from the admin screen                           |
| `CONNECTOR_HOST`   | Hostname or `docker-host` | Host label displayed in the table                            |
| `DOCKER_SOCKET`    | Platform-specific         | Local Unix socket or Windows named pipe                      |
| `POLL_INTERVAL_MS` | `5000`                    | Delay between collections                                    |
| `HEALTH_PORT`      | `3001`                    | Loopback-only liveness port                                  |

Snapshots replace the connector's previous inventory. Collection uses bounded
concurrency and a ten-second deadline. Connections reconnect with exponential
backoff and jitter. Ping/pong checks detect broken connections. A host becomes
stale after 20 seconds without an accepted snapshot; its old metrics are hidden.
Revoked credentials disconnect within ten seconds and cannot reconnect.

## Assign containers

For automatic assignment, label containers when creating them:

```yaml
labels:
  dedi-dash.project: miki
  dedi-dash.application: imgen
```

Create the project in the dashboard first. Slugs contain lowercase letters,
digits, and single separating hyphens. Both labels must be valid. Application
slugs identify the future application page; no application-management UI is needed.

For manual assignment, a Server Administrator enables **Discover unassigned containers**
on the connector, opens **Inventory**, and chooses a project and application slug.
Assignments are stored in PostgreSQL and do not change Docker labels. Valid label
assignments take precedence. Disabling discovery hides unassigned inventory while
preserving existing manual assignments. Recreating a container changes its Docker
ID and requires reassignment. Dashboard services use `dedi-dash.internal=true` and
are excluded before transmission, even with discovery enabled.

## Users and recovery

Server Administrators invite users, grant project memberships, disable accounts, and reset
enrollment in **Users**. Invitation links expire after 24 hours and are single-use.
Share them manually. Resetting enrollment invalidates the user's current sessions
and credentials. Ordinary users see only their assigned projects; Server Administrators
see all projects. Users cannot disable themselves through the UI.

Recover an administrator's lost passkey using server access:

```sh
docker compose run --rm api node apps/api/dist/cli.js recover owner
```

This revokes the user's sessions and credentials, re-enables the account, and prints
a fresh enrollment link. It never grants a password-only session.

## Development and verification

Use Node 22.12+ and the pinned pnpm version. Start a local PostgreSQL instance:

```sh
docker run --name dedi-dash-postgres -e POSTGRES_USER=dedi_dash -e POSTGRES_PASSWORD=dedi_dash_local -e POSTGRES_DB=dedi_dash -p 127.0.0.1:5432:5432 -v dedi-dash-dev-postgres:/var/lib/postgresql/data -d postgres:17-alpine
```

Copy `apps/api/.env.example` to `apps/api/.env`, then:

```sh
pnpm install
pnpm --filter @dedi-dash/api migrate
pnpm --filter @dedi-dash/api dev
pnpm --filter @dedi-dash/website dev
```

The development website runs at `http://localhost:5173`; `/api/*` is proxied to
port 3000. Run the connector separately after creating its token.

```sh
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
```

For PostgreSQL integration coverage, set `TEST_DATABASE_URL` to a disposable
PostgreSQL database before `pnpm test`. Tests create and remove their own isolated
schema. Without that variable, database integration is explicitly skipped.

For browser coverage, set `E2E_DATABASE_URL` to a **separate migrated test database**,
run `pnpm --filter @dedi-dash/website exec playwright install chromium`, then
`pnpm --filter @dedi-dash/website test:e2e`. The suite starts its API on port 3100
and website on 5174, uses a virtual passkey authenticator, and saves desktop/mobile
screenshots under `apps/website/test-results`. Test users and inventory are removed
after the run. Do not point browser tests at a production database.

An additional opt-in live Docker test runs when both `RUN_LIVE_DOCKER=1` and
`TEST_DATABASE_URL` are set. Build the images with `docker compose build api website connector`
first. This test requires Docker Desktop's `host.docker.internal` routing and a
locally published test database; it starts and removes isolated API, website,
connector, and fixture containers, checking Nginx WebSocket forwarding, real metrics,
reconnects, and revocation.

## Production

Set `PUBLIC_ORIGIN` to the exact HTTPS website origin without a trailing slash,
`WEBAUTHN_RP_ID` to its hostname, and `DATABASE_URL` to PostgreSQL. These settings
are API runtime settings, not frontend build variables. Keep the RP ID stable so
existing passkeys continue to work. HTTP is supported only for localhost testing.
Terminate TLS at your reverse proxy and forward WebSocket upgrades to the website;
the included Nginx configuration forwards upgrades through `/api/` to the API.

To use an external PostgreSQL server without starting the bundled database:

```sh
docker compose build api website
docker compose run --rm --no-deps migrate
docker compose up -d --no-deps api website
```

Configure certificate verification in the PostgreSQL connection settings as required
by your provider. Back up PostgreSQL regularly. The migration command is explicit,
transactional, and protected against concurrent migration processes.

Public probes are `/api/health` and website `/healthz`. The authenticated API
specification is `/api/openapi.json`; see [API.md](API.md) for contracts and protocol.
