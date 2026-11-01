# PM2 applications

Compute / PM2 manages applications already registered with an existing Linux PM2
daemon. Each connector attaches to one PM2 home. An application is the exact
combination of connector, namespace, and name; cluster workers belong to that
application. The connector's PM2 client is pinned to 7.1.1. Validate daemon/client
compatibility with your installed PM2 version before rollout.

## Enable on a host

Upgrade the API and apply migrations before enabling PM2 on connectors. Existing
Docker-only connectors remain compatible. Build the connector after installing
workspace dependencies, then run it as the same OS user that runs PM2:

```dotenv
API_URL=https://dashboard.example.com/api/
CONNECTOR_TOKEN=<dashboard-generated-connector-token>
CONNECTOR_HOST=my-server
PM2_ENABLED=true
PM2_HOME=/home/app/.pm2
DOCKER_ENABLED=false
```

Keep `DOCKER_ENABLED=true` when this connector should also collect Docker
inventory. PM2 monitoring and lifecycle actions do not require Docker or
`RUNTIME_ENABLED`. PM2 is disabled by default. Start your PM2 daemon on the host
before running the connector; the connector never starts, resurrects, upgrades,
or kills the daemon. A systemd connector service should use the PM2 user's `User`
and an explicit `PM2_HOME`.

## Run the connector in Docker

Build from the repository root:

```sh
docker build -f apps/connector/Dockerfile -t kloud-connector:local .
docker run -d --name kloud-connector --init \
  --user "$(id -u app):$(id -g app)" \
  --env API_URL=https://dashboard.example.com/api/ \
  --env CONNECTOR_TOKEN="$CONNECTOR_TOKEN" \
  --env CONNECTOR_HOST=my-server \
  --env DOCKER_ENABLED=false \
  --env PM2_ENABLED=true \
  --env PM2_HOME=/home/app/.pm2 \
  --mount type=bind,src=/home/app/.pm2,dst=/home/app/.pm2,readonly \
  kloud-connector:local
```

Use the host PM2 user's numeric UID/GID. Mount the PM2 home directory, rather
than individual sockets, so socket replacement after daemon restart works.
The directory contains `rpc.sock` for inventory and actions, and `pub.sock` for
live stdout/stderr events. A read-only filesystem mount permits
connecting to a Unix socket; the PM2 socket still authorizes lifecycle changes.
No host PID namespace, privileged mode, inbound port, or PM2 network endpoint is
needed.

PM2 returns absolute log paths. Every log directory outside `PM2_HOME` needs an
additional read-only bind mount at the **same absolute path** inside the
connector, for example:

```sh
--mount type=bind,src=/var/log/my-app,dst=/var/log/my-app,readonly
```

For the standalone GHCR connector, copy `compose.connector.pm2.yaml` alongside
`compose.connector.yaml`. Set these values in their shared `.env`, replacing
`app` and the example IDs with the user running your existing PM2 daemon:

```dotenv
PM2_ENABLED=true
PM2_HOME=/home/app/.pm2
PM2_UID=1000
PM2_GID=1000
```

Find the numeric IDs with `id -u app` and `id -g app`. Start with both files:

```sh
docker compose -f compose.connector.yaml -f compose.connector.pm2.yaml up -d --force-recreate connector
```

The override enables PM2, runs as that host UID/GID, and binds the entire PM2 home
read-only at the same absolute path. It fails if the host directory does not
exist, rather than silently creating an empty directory. Add read-only binds for
external log directories to the override. Use both files for subsequent updates.
If also enabling deployments, make the deployment directory writable by this
PM2 UID/GID instead of assuming UID 1000.

The base Compose file retains Docker's socket and socket group. For PM2-only
hosts without Docker socket access, use a separate service matching the
`docker run` example above, without the Docker socket mount or group.

## Assignment and access

1. Enable discovery in Administration / Connectors.
2. Open Administration / Inventory, find PM2 inventory, and assign an application
   to a project. This requires `inventory.manage`.
3. Open the project's Access page and grant View, Logs, Manage, or Delete for
   individual PM2 apps or all PM2 apps in the project. New members have no PM2
   access by default. Other grants imply View; Manage does not include Delete or
   Logs. Project administrators have all PM2 permissions.
4. Open Compute / PM2 and click an application row to inspect workers, logs,
   and lifecycle controls.

Assignments and grants survive temporary disappearance and recreation with the
same connector, namespace, and name. Moving or unassigning an app removes its
individual grants. Project-wide grants apply only to apps currently assigned to
that project. Unassigned discovered inventory is visible only to authorized
server inventory administrators. Disabling discovery stops collecting new
unassigned apps but continues collecting assigned apps.

Actions affect all current workers. Stop and Delete require confirmation. Delete
removes the app from the live PM2 instance; register it again on the server to
start it afterward. Actions never run `pm2 save`, change startup configuration,
clear logs, or change the saved boot list. A saved app may consequently return
after PM2 resurrection. Partial results identify unsuccessful workers. Timeout or
disconnect can leave an unknown outcome: inspect host state before retrying.

## Logs and troubleshooting

The default **Combined live** view captures stdout and stderr from the PM2 event
bus over one `pub.sock` subscription. Events stay in the order PM2 publishes them,
across both streams and all workers. Each chunk identifies its stream and worker;
multiline errors retain their context. This is PM2 arrival order, not a guarantee
of exact JavaScript call order across separate OS streams or processes.

Capture starts when the connector collects PM2 inventory, before a viewer opens.
The connector keeps a bounded in-memory host buffer (up to 4 MiB / 10,000 chunks;
individual chunks are capped at 12 KB). The browser receives the latest window
over SSE every 1.5 seconds, up to 200 lines / 48 KB. Repeated windows replace the
display rather than duplicating entries. Worker selection filters this ordered
feed. Pause retains the current display; Resume reads the latest window.

This is not durable log storage. High-volume output can exceed retention, and
connector or PM2 disconnections clear the live buffer. The connector reconnects
on the next collection or log request. The **stdout file** and **stderr file**
views retain access to older file tails, including rotation/truncation handling.
Historical separate files cannot reliably reconstruct combined ordering without
timestamps, so they are never silently substituted for the ordered live view.
File tails deduplicate shared worker files and share a read budget across up to
200 distinct files. Upgrade the API, website, and connector together for the new
`combined` stream.

- No inventory: check `PM2_ENABLED`, `PM2_HOME`, discovery, and the existing
  daemon's `rpc.sock`. Check loopback `/health` for `pm2Reachable`.
- Apps missing from a project: assign them in inventory and grant View.
- Live logs unavailable: verify `pub.sock` is mounted with the PM2 home and the
  connector user can connect to it. No log-file mounts are needed for live output.
- File logs unavailable: verify log directory mounts at identical absolute paths,
  ownership, read permissions, and regular log files. `/dev/null` and special
  files are not tailed. Environment variables and raw PM2 configuration are never
  sent as inventory; application log content is shown to users with Logs access.
- Stale/unavailable apps: operations require a successful PM2 snapshot within
  20 seconds, PM2 capability, and an active connector. Docker and PM2 freshness
  are independent. A failed PM2 collection retains the last inventory as stale;
  a successful empty list marks previously assigned apps unavailable.
- Daemon restarted: the connector reconnects using the mounted socket directory.
- Concurrent action: wait for the current app action to finish. Lifecycle
  requests are serialized per app and are never automatically retried.

## API

- `GET /admin/pm2`: discovered and assigned application inventory.
- `PUT /admin/pm2/:app`: `{ "project": "project-slug" }` or `{ "project": null }`.
- `GET /projects/:project/pm2`: applications visible to the caller.
- `GET /projects/:project/pm2/:app/permissions`: effective capabilities.
- `POST /projects/:project/pm2/:app/operation`: `{ "action": "restart" }`;
  supports start, stop, restart, reload, delete. Returns per-worker `{ id, ok }`
  results. Failed entries may have unknown outcomes.
- `GET /projects/:project/pm2/:app/logs?stream=combined&worker=0`: SSE output
  snapshots `{ output, unavailable }`; an `unavailable` event ends access.
  `stream` defaults to `combined`; `stdout` and `stderr` select historical file tails.
- Project member reads and writes include optional `pm2_grants`, an array of
  `{ "capability": "logs", "app": "assignment-uuid" }`; use `app: null` for
  project-wide grants. Omitting `pm2_grants` preserves existing grants.

The API resolves app UUIDs to host/name/namespace internally. Clients cannot
submit scripts, shell commands, environment updates, log paths, or PM2 patterns.

## Validation

`pnpm test`, `pnpm typecheck`, and `pnpm build` cover the workspace. Set
`TEST_DATABASE_URL` to an isolated PostgreSQL database for API integration tests.
Run the PM2 browser suite with `E2E_DATABASE_URL` pointing to a migrated isolated
database: `pnpm --filter @kloud/website test:e2e pm2.spec.ts`.
On an isolated Linux test host, run the real daemon tests with
`LIVE_PM2_TESTS=true pnpm --filter @kloud/connector exec tsx --test src/pm2.live.test.ts`.
They create and remove their own temporary PM2 home and fork/cluster apps. The
`PM2_LIVE_HOME` option is reserved for the disposable cross-container fixture;
never point it at a production PM2 home.
