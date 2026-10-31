# Service deployment platform

Services is the default project workspace. Containers remains the runtime inventory.
Create a service from a registry image, GitHub Dockerfile, GitHub Compose repository,
or pasted image-only Compose definition. Configure its host, review, and save a draft
or deploy explicitly. Existing application URLs and legacy Git deployment settings
remain supported.

## Enable features

Apply migrations with `pnpm --filter @dedi-dash/api migrate`. Migration 8 adds
encrypted configuration revisions, deployment runs, connector capabilities, and routes.
Set `PLATFORM_ENCRYPTION_KEY` on the API to 32 random bytes represented as 64 hex
characters. Keep this key stable and back it up separately from PostgreSQL. Losing
it makes saved revisions unusable. Existing DNS encryption uses its separate key.

On each connector, opt in independently:

- `DEPLOYMENTS_ENABLED=true`: Git, image, and Compose deployment workers.
- `RUNTIME_ENABLED=true`: inspection, logs, start/stop/restart, and shell sessions.
- `PROXY_ENABLED=true`: managed per-host NGINX and certificate reconciliation.

All default to disabled. Updated connectors advertise capabilities over their existing
authenticated WebSocket. Older connectors continue sending inventory. Run the API as
a single instance for runtime RPC; the operation broker is process-local. Inventory
and queued deployments remain database-backed.

For deployments or proxy management, mount `DEPLOYMENTS_DIR` at the **same absolute
path on the Docker host and inside the connector**, using `compose.deployments.yaml`.
The directory must be writable by the connector user. Keep its permissions private.
The connector requires the Docker CLI and Compose plugin. The packaged image includes
both. The API never receives a Docker socket.

## Configuration and deployments

Configuration drafts are immutable encrypted revisions. Environment values, registry
passwords, and pasted Compose content are masked on reads. Saving an unchanged masked
value preserves it from the specified previous revision. To change Compose content,
replace the masked definition with the complete file.

Single-container settings expose environment, named volumes, ports, networks, restart
policy, CPU/memory limits, and health checks. Networks must already exist. Compose
owns stack runtime settings. Pasted Compose requires image references; repository
builds use GitHub Compose. Private image credentials are supported for image services;
private registry authentication for Compose and isolated Git builders remains a limitation.

Git deployments require a full commit SHA for manual builds. Saving a draft does not
activate or change automatic deployments; explicitly deploying selects its revision
for subsequent signed pushes. Signed pushes use the existing webhook endpoint and
enqueue the active encrypted revision. Existing
Git webhook URLs and secret rotation continue working. New Git sources show their
webhook URL and one-time secret rotation in the Source tab.

Both deployment queues serialize on the connector. Request keys deduplicate submitted
deployment requests. Ambiguous worker failures are marked failed, not retried as new
deployments. Successful image and Compose runs retain image references; Git runs retain
build artifacts. Rollback reuses the selected revision and retained artifacts. It does
not restore data. Do not prune retained images/checkouts that you intend to roll back to.

Single-container startup failures attempt to restore the prior container. Compose
failures require an explicit rollback. Named volumes survive redeployment and rollback.
Removing a service removes metadata/history/routes but leaves containers and volumes.
Removal is blocked during a running deployment.

## Permissions and runtime operations

Service create and deploy remain separate permissions. Creators receive existing
read/update/delete permissions, not deployment authority. A creator without deployment
permission can create metadata but needs an administrator to configure/deploy it.

Runtime inspection, logs, lifecycle, and shell access enforce the existing container
configuration/logs/lifecycle/terminal grants independently of service read access.
Administrators inherit these permissions. Read access alone never enables operations.
Runtime permissions are checked again before returning remote output. Stale hosts reject
operations. Internal dashboard containers cannot be operated.

Logs stream over authenticated SSE from a bounded 200-line tail. Terminal sessions use
Docker exec with a PTY, `/bin/sh`, and an xterm emulator, including terminal resizing.
Closing the dialog or losing the connector connection closes terminal attachments; inactive sessions expire
after 30 seconds. Commands already launched inside a container may outlive their client.

## Managed NGINX

Use a dedicated host or free ports 80/443 before enabling the proxy. Existing Coolify,
Dokploy, or other proxies must release those ports during your manual cutover. Route
targets must belong to the service and expose a specified Docker network. NGINX joins
only explicitly selected service networks, alongside its default bridge network.

The connector polls desired routes every five seconds, resolves container endpoints,
renders a candidate, validates with `nginx -t`, atomically activates it, reloads gracefully,
and checks a private revision endpoint. Failure restores the previous configuration.
The UI reports desired/applied revisions and reconciliation errors. It does not edit DNS;
use Cloud DNS separately with its existing permissions.

HTTPS uses Certbot webroot HTTP-01 challenges. Public DNS must resolve to the proxy and
port 80 must be reachable. Certificate material persists in the proxy directory. Renewal
runs every twelve hours and reloads NGINX. Wildcards, DNS-01, TCP/UDP ingress, and
cross-host routing are deferred. Proxy images are configurable via `PROXY_NGINX_IMAGE`
and `PROXY_CERTBOT_IMAGE`; pin tested image digests for production.

The routing controller is new and opt-in. Validate on a non-production host before
cutover. Real public ACME issuance/renewal needs an externally reachable domain and is
not covered by local tests. No comparative NGINX/Traefik throughput claim is made.

## Validation

`pnpm test`, `pnpm typecheck`, and `pnpm build` cover the workspace. Set
`TEST_DATABASE_URL` to an isolated PostgreSQL database for API integration tests.
Set `E2E_DATABASE_URL` to a migrated isolated database for Playwright.

Run `RUN_PLATFORM_DOCKER=1 pnpm --filter @dedi-dash/connector exec tsx --test src/platform.live.test.ts`
with Docker available for image/Compose replacement, rollback, volume retention,
and NGINX graceful reload checks under HTTP and WebSocket traffic. These use isolated
container/network names and ephemeral published ports; they do not modify running
production services. Existing opt-in Git build tests use `RUN_DEPLOYMENT_DOCKER=1`.
