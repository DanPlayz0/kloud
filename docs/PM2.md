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
docker build -f apps/connector/Dockerfile -t dedi-dash-connector:local .
docker run -d --name dedi-connector --init \
  --user "$(id -u app):$(id -g app)" \
  --env API_URL=https://dashboard.example.com/api/ \
  --env CONNECTOR_TOKEN="$CONNECTOR_TOKEN" \
  --env CONNECTOR_HOST=my-server \
  --env DOCKER_ENABLED=false \
  --env PM2_ENABLED=true \
  --env PM2_HOME=/home/app/.pm2 \
  --mount type=bind,src=/home/app/.pm2,dst=/home/app/.pm2,readonly \
  dedi-dash-connector:local
```

Use the host PM2 user's numeric UID/GID. Mount the PM2 home directory, rather
than individual sockets, so socket replacement after daemon restart works.
The directory contains `rpc.sock` and `pub.sock`; this connector uses only
`rpc.sock` and reads recent logs from files. A read-only filesystem mount permits
connecting to a Unix socket; the PM2 socket still authorizes lifecycle changes.
No host PID namespace, privileged mode, inbound port, or PM2 network endpoint is
needed.

PM2 returns absolute log paths. Every log directory outside `PM2_HOME` needs an
additional read-only bind mount at the **same absolute path** inside the
connector, for example:

```sh
--mount type=bind,src=/var/log/my-app,dst=/var/log/my-app,readonly
```

For Compose, create a local override for `connector` setting `user`, `PM2_HOME`,
and the mounts above. Set `PM2_ENABLED=true` in the root `.env`. The existing
Compose connector profile still mounts Docker's socket; use a separate PM2-only
service with the settings above when Docker access is unnecessary.

## Assignment and access

1. Enable discovery in Administration / Connectors.
2. Open Administration / Inventory, find PM2 inventory, and assign an application
   to a project. This requires `inventory.manage`.
3. Open the project's Access page and grant View, Logs, Manage, or Delete for
   individual PM2 apps or all PM2 apps in the project. New members have no PM2
   access by default. Other grants imply View; Manage does not include Delete or
   Logs. Project administrators have all PM2 permissions.
4. Open Compute / PM2. Expand applications to inspect workers, or open the app
   for logs and lifecycle controls.

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

The viewer replaces its recent-output window every 1.5 seconds, up to 200 lines
and 48 KB, with stdout/stderr and worker filters. It is a bounded recent tail,
not durable log storage: output between polls may exceed this window. Shared
worker log files appear once. Pause retains the current window; Resume reads the
latest window. Rotation and truncation are picked up on the next read.
The all-worker view shares its read budget across up to 200 distinct files; select
an individual worker for a larger tail when an application has many workers.

- No inventory: check `PM2_ENABLED`, `PM2_HOME`, discovery, and the existing
  daemon's `rpc.sock`. Check loopback `/health` for `pm2Reachable`.
- Apps missing from a project: assign them in inventory and grant View.
- Logs unavailable: verify log directory mounts at identical absolute paths,
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
- `GET /projects/:project/pm2/:app/logs?stream=stdout&worker=0`: SSE output
  snapshots `{ output, unavailable }`; an `unavailable` event ends access.
- Project member reads and writes include optional `pm2_grants`, an array of
  `{ "capability": "logs", "app": "assignment-uuid" }`; use `app: null` for
  project-wide grants. Omitting `pm2_grants` preserves existing grants.

The API resolves app UUIDs to host/name/namespace internally. Clients cannot
submit scripts, shell commands, environment updates, log paths, or PM2 patterns.

## Validation

`pnpm test`, `pnpm typecheck`, and `pnpm build` cover the workspace. Set
`TEST_DATABASE_URL` to an isolated PostgreSQL database for API integration tests.
Run the PM2 browser suite with `E2E_DATABASE_URL` pointing to a migrated isolated
database: `pnpm --filter @dedi-dash/website test:e2e pm2.spec.ts`.
On an isolated Linux test host, run the real daemon tests with
`LIVE_PM2_TESTS=true pnpm --filter @dedi-dash/connector exec tsx --test src/pm2.live.test.ts`.
They create and remove their own temporary PM2 home and fork/cluster apps. The
`PM2_LIVE_HOME` option is reserved for the disposable cross-container fixture;
never point it at a production PM2 home.
