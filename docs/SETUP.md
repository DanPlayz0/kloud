# Kloud setup

## Upgrading an existing installation

The Kloud rename changes package scopes to `@kloud/*`, Docker labels to
`kloud.*`, generated container and image names to `kloud-*` or `kloud/*`,
and the default deployment path to `/var/lib/kloud/deployments`.
Reinstall workspace dependencies and rebuild all images and connectors together.

Before upgrading an existing host, back up PostgreSQL and deployment storage.
Keep its existing database credentials in `DATABASE_URL`; the new `kloud`
database/user defaults apply only to new PostgreSQL volumes. Configure the
PostgreSQL service with `POSTGRES_USER`, `POSTGRES_DB`, and `POSTGRES_PASSWORD`
in `.env` to match an existing volume; its health check uses those values.
For a volume initialized before the rename, the original user and database
are `dedi_dash` and the original local development password is
`dedi_dash_local`. Keep those values and the matching `DATABASE_URL` for that
volume, or use the credentials you set when it was initialized. Changing
container environment variables does not rename an existing database or role.
If migration reports `password authentication failed for user "kloud"` and
PostgreSQL reports `role "kloud" does not exist`, restore these original
connection settings and run `docker compose up -d --build` again.
Keep the existing Compose project name so its named volumes are reused.
Keep the existing `DEPLOYMENTS_DIR` and bind mounts, or copy the deployment
directory to the new path while deployments are stopped. Preserve encryption
keys, retained images, and checkout paths required by historical rollbacks.

Recreate managed containers with the new `kloud.project`, `kloud.application`,
and `kloud.internal` labels before enabling runtime operations. Update manual
labels and recreate internal helper containers as well. During a maintenance
window, stop and remove the previous managed NGINX container before enabling
the new `kloud-nginx` container, reusing the proxy and certificate storage.
The source rename does not migrate running infrastructure automatically.
Existing passkeys remain valid when the origin and relying-party ID stay the same.

The website supports passwords with optional Email, TOTP, and Passkey second factors. PostgreSQL stores
accounts, sessions, project access, connector credentials, inventory, and manual
assignments. There is no public signup or demo-data fallback. See [Account security](AUTHENTICATION.md) for optional factor configuration.

## Local Docker Compose

1. Copy the root `.env.example` to `.env`.
2. Run `docker compose up --build -d`. PostgreSQL starts first, then the one-shot
   migration service, then the API and website.
3. Open `http://localhost:8080`. With no accounts, the website prompts you to
   create the Server Administrator with a username and a password of at least 12 characters.
4. Sign in using your password. Optionally enable second factors in Account security. Setup is unavailable once any account exists.
5. In **Administration → Projects**, create a project. In **Connectors**, create
   a connector and copy its token immediately; it cannot be retrieved later.

Local Compose uses the development database password `kloud_local`. For
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
`pnpm --filter @kloud/connector start`. Use `API_URL=https://dashboard.example.com/api/`
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
  kloud.project: your-project-slug
  kloud.application: imgen
```

Create the project in the dashboard first. Slugs contain lowercase letters,
digits, and single separating hyphens. Both labels must be valid. Application
slugs identify the future application page; no application-management UI is needed.

For manual assignment, a Server Administrator enables **Discover unassigned containers**
on the connector, opens **Inventory**, and chooses a project and application slug.
Assignments are stored in PostgreSQL and do not change Docker labels. Valid label
assignments take precedence. Disabling discovery hides unassigned inventory while
preserving existing manual assignments. Recreating a container changes its Docker
ID and requires reassignment. Dashboard services use `kloud.internal=true` and
are excluded before transmission, even with discovery enabled.

## Users and recovery

Server Administrators invite users, grant project memberships, disable accounts, and reset
enrollment in **Users**. Invitation links expire after 24 hours and are single-use.
Share them manually. Resetting enrollment invalidates the user's current sessions
and credentials. Ordinary users see only their assigned projects; Server Administrators
see all projects. Users cannot disable themselves through the UI.

Recover an administrator's lost credentials or second factors using server access:

```sh
docker compose run --rm api node apps/api/dist/cli.js recover owner
```

This revokes the user's sessions and credentials, re-enables the account, and prints
a fresh password-enrollment link. All second factors and recovery codes are cleared.

## Development and verification

Use Node 22.12+ and the pinned pnpm version. Start a local PostgreSQL instance:

```sh
docker run --name kloud-postgres -e POSTGRES_USER=kloud -e POSTGRES_PASSWORD=kloud_local -e POSTGRES_DB=kloud -p 127.0.0.1:5432:5432 -v kloud-dev-postgres:/var/lib/postgresql/data -d postgres:17-alpine
```

Copy `apps/api/.env.example` to `apps/api/.env`, then:

```sh
pnpm install
pnpm --filter @kloud/api migrate
pnpm --filter @kloud/api dev
pnpm --filter @kloud/website dev
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
run `pnpm --filter @kloud/website exec playwright install chromium`, then
`pnpm --filter @kloud/website test:e2e`. The suite starts its API on port 3100
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

Set `PUBLIC_ORIGIN` to the canonical website origin without a trailing slash,
`ALLOWED_ORIGINS` to additional exact localhost, IP, or domain origins, and
`DATABASE_URL` to PostgreSQL. These are API runtime settings, not frontend build
variables. Preserve the original `WEBAUTHN_RP_ID` during migration so existing
passkeys retain their scope. See [login addresses and direct management access](AUTHENTICATION.md#login-addresses-and-direct-management-access)
for tunnel setup, port 8080 recovery access, cookie behavior, and passkey limits.
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
