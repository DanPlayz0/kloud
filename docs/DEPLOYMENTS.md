# Legacy GitHub deployment reference

For current setup, use [repository connections](REPOSITORIES.md),
[readiness-gated releases](ROLLOUTS.md), and
[implementation status](FEATURE_IMPLEMENTATION.md). New repository onboarding uses
App installation/repository/branch selection or Repository URL + PAT. Existing
manual configurations can be reviewed into versioned drafts; legacy connector-token
use requires an administrator-approved app/repository/host binding. Workers without
`rollout-v1` cannot claim release jobs. Unreviewed legacy replacement is blocked.

The older stable-container and stop-first implementation described below is retained
as a compatibility reference, not the default rollout policy or a production
availability guarantee. Current blue/green ordering, timeout, queue and recovery
rules in ROLLOUTS.md supersede those historical descriptions.

Create a Dockerfile application or Docker Compose service from **Compute / Services**.
Open the service to select a host, GitHub `owner/repo`, branch, repository-relative
build file, and build context/project directory. Services have persistent identities
and permissions, independent of container IDs.

Services own their deployment configuration and history, and create containers on the
first build. Dockerfile services use the reserved name `kloud-<project>-<service>`;
Compose services use a stable project name derived from the deployment ID and deploy
every service in the Compose file, including dependencies. Assignment labels apply
to every container. Image-only Compose services are supported alongside builds.
New Dockerfile containers inherit their image configuration and restart unless
stopped; use Compose to declare published ports, environment, mounts, and networks.

Existing configurations that redeploy an assigned container by stable name retain
that behavior. New services select a deployment host without requiring a container.

## Build isolation

Each deployment has three steps:

1. A temporary non-root checkout helper fetches the pushed commit into a private
   Docker volume. The credential-bearing checkout container is then destroyed.
2. A fresh tools helper and a separate rootless BuildKit container build the
   Dockerfile or Compose targets without source credentials. Images are exported
   as archives with deployment-specific tags.
3. The trusted connector imports those images and applies an image-only runtime
   configuration to the service host. It never runs repository builds locally.

The helper and builder receive no host Docker socket, host filesystem bind mounts,
connector API token, or database credentials. Each build gets its own network,
workspace, and builder state. The helper has a read-only root filesystem, drops
all capabilities, and enables `no-new-privileges`. Both containers have CPU,
memory, and process limits. They publish no ports; outbound network access is
available for GitHub, registries, and package downloads.

Rootless BuildKit uses the native snapshotter with its process sandbox enabled.
It needs unprivileged user namespaces and the documented relaxed container
seccomp/AppArmor/proc mount settings. There is no privileged or host-daemon build
fallback. Builds use container isolation and share the host kernel; use a separate
build machine or VM for a stronger boundary between mutually untrusted tenants.
Runtime deployment remains a trusted operation: a Compose file can request host
mounts and privileged runtime containers, so service deploy grants confer host access.

Temporary containers, networks, and workspace volumes are removed on success,
failure, and cancellation. An enabled connector also removes its own build
resources older than 40 minutes after a crash. Export archives are deleted after
import. Retained Compose source directories support runtime bind mounts.

## Enable the worker

1. Run `pnpm --filter @kloud/api migrate` to apply pending migrations, or restart the
   Compose stack so the migration service runs before the API.
2. Set `DEPLOYMENTS_ENABLED=true` on the connector. The default is `false`.
   Native connectors need Docker CLI and Compose on PATH. Git and Buildx run in
   the helper image. Docker control commands use the configured `DOCKER_SOCKET`.
3. Set `DEPLOYMENTS_DIR` to a persistent directory writable by the connector user.
   The image defaults to `/var/lib/kloud/deployments`. For containerized
   connectors, bind mount that directory at the **same absolute host path** so
   Compose relative bind mounts resolve on the Docker daemon's host.
   On Linux, prepare the directory for the image's non-root user (UID 1000):

   ```sh
   sudo install -d -o 1000 -g 1000 /var/lib/kloud/deployments
   docker compose -f compose.yaml -f compose.deployments.yaml --profile connector up --build -d
   ```

   Adjust ownership for your connector user. Docker Desktop users may need to
   choose a shared absolute directory and update both the environment and bind
   mount accordingly. Read-only mode does not need a checkout volume.

   The deployment Compose override builds the helper automatically. For a native
   connector, build it once from the repository root:

   ```sh
   docker build -f apps/connector/Dockerfile --target build-helper -t kloud-build-helper:local .
   ```

   `DEPLOYMENTS_HELPER_IMAGE` selects that image. The default builder is
   `moby/buildkit:v0.28.0-rootless`, selected by `DEPLOYMENTS_BUILDKIT_IMAGE` and
   pulled automatically when absent. Both helper and builder default to a 2048 MiB
   memory limit each (`DEPLOYMENTS_BUILD_MEMORY_MB`), two CPUs each, and bounded
   process counts. Rebuild the helper when upgrading the connector's build protocol.

4. For private GitHub repositories, set `DEPLOYMENTS_GITHUB_TOKEN` on the connector
   to a token with read access to the source repository. It is forwarded only to
   the checkout helper, used through Git's transient HTTP configuration, and
   destroyed with that container before the tools helper starts. It is never
   written to the checkout or supplied to build containers. Host Git credential
   helpers are not inherited.

Organization Administrators,
project administrators, and users with the relevant service deploy permission
can configure deployments; service read access exposes history and build output.
Treat service deploy grants as trusted host access. Container
configuration/lifecycle grants alone do not confer this access. The API
does not need a Docker socket. The normal inventory WebSocket remains unchanged.

## Configure GitHub

Save the deployment from the application page. In GitHub repository Settings →
Webhooks → Add webhook:

- Payload URL: the generated URL (`https://your-dashboard/api/hooks/github/<id>`).
  This assumes the documented `/api` reverse proxy; when exposing the API
  directly, the backend route is `/hooks/github/<id>`.
- Content type: `application/json`.
- Secret: copy the secret displayed after saving. The API never returns it on
  reads. “Generate new webhook secret” invalidates the old secret; update GitHub
  immediately. Secrets are stored in the database for HMAC verification, so
  protect database access and backups.
- Events: push events; leave SSL verification enabled.

The API verifies SHA-256 HMAC over the original request bytes, then checks the
repository and exact branch. Pings and unrelated events are ignored, as are
branch deletions. Retries of the same GitHub delivery enqueue only once.
Payloads up to 2 MiB are accepted. Push a commit to start a build; saving a
configuration does not deploy existing source automatically.
To deploy without a push, enter a full 40-character commit SHA and choose **Deploy
commit**. The commit is fetched from the configured repository; deployments must be
enabled. Builds run through the same connector queue as webhook builds.

## Service permissions

Project access has separate service grants for **read**, **create**, **update**,
**delete**, and **deploy**. Grants target one service slug or all current and future
services in the project. Create is project-wide. Update, delete, and deploy imply
read for the same target; update changes service details, while deploy controls
deployment configuration, webhook secrets, and manual builds. Read includes build
history and output and visibility of containers assigned to that service.

Creators receive read, update, and delete grants for their own new service;
deployment permission must be granted separately. Administrators inherit all service
permissions. Removing membership revokes service grants. Existing container grants
remain independent. Migration 6 imports services from existing inventory, manual
assignments, and deployments without granting new member permissions.

Removing a service deletes its configuration, queued builds, history, and specific
grants. Running builds block removal. Running containers and persistent volumes
remain on their host; this action does not tear down runtime resources.

## Build modes

**Dockerfile:** set the Dockerfile path and build context relative to the
repository root. The worker builds a commit-tagged image before stopping the
target. It preserves runtime overrides, ports, mounts, restart policy, and
network aliases; unchanged image defaults are replaced with new image defaults.
It adds project/application labels so the replacement stays assigned when its
container ID changes. Compose-managed targets, auto-remove containers, and
shared-container network modes require Compose mode instead.

The old container is retained until the replacement starts and passes its health
check (60 seconds), or stays running for five seconds if it has no health check.
On a reported startup failure, the worker attempts to restore the old container.
There is brief downtime during replacement. A worker/host crash during replacement
can require manual recovery of the stopped `*-backup-<build-id>` container. The
worker does not remove volumes, and successful backup cleanup never passes `-v`.
New Dockerfile ENV values that exactly matched old image defaults follow the new
defaults; Docker inspection cannot distinguish an explicit override with the
same value. Use Compose for fully declarative runtime configuration.

**Existing Docker Compose target:** set the Compose file path, project directory (usually `.`),
and service name. The target must already be managed by that service. The worker
reuses its Compose project name to preserve named volumes and networks, requires
a service `build` declaration, builds first, then runs `up --detach --no-deps
--no-build --force-recreate --wait --wait-timeout 60` for that service only.
Dependencies must already exist. The Compose file defines runtime settings; the
helper adds dashboard assignment labels to the resolved runtime manifest.
Compose startup failures are recorded and do not automatically roll back.

Only one build runs at a time per connector, including when two workers poll with
the same credential. The worker checks out the exact pushed SHA rather than the
branch's latest head. Submodules, Git LFS, registry authentication inside the
isolated builder, and untracked source files are not provisioned automatically.
Compose interpolation happens in the helper using repository configuration;
connector environment variables are never exposed. Service `env_file` files are
resolved only during trusted runtime deployment. External runtime files must be
available to the connector at their declared absolute paths. Literal dollar signs
are preserved between build and deployment configuration. Multi-platform Docker
archive export is not supported; build for the target host. Use one self-contained
Compose file.

## History and recovery

Build history shows the latest 30 builds: queued, running, succeeded, or failed.
Final output is retained up to 48,000 characters and can contain build-command
output, so keep secrets out of build logs. The worker has a 30 minute deadline.
Lost workers are marked failed after 40 minutes when an enabled worker next polls;
ambiguous executions are never automatically retried. Push another commit or
redeliver the push under a new delivery ID after resolving a failure.

Editing a deployment cancels queued builds and is blocked while a build runs.
Disabling automatic deployment ignores new pushes. Secret rotation does not
cancel previously authenticated builds. Revoking the connector prevents new
claims and results; it does not forcibly interrupt a process already running on
the host (stop that worker directly if needed).

Built images and copied Compose source directories are retained,
because running Compose services may bind mount their source. Monitor disk space
and remove old checkouts/images only after confirming no containers use them.
Container ID grants on old containers do not automatically grant access to their
replacements; use name grants for access that should survive redeployment.

Protocol details: [API contracts](API.md#deployments).

Reference: [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
and [Docker Compose up](https://docs.docker.com/reference/cli/docker/compose/up/).
Build isolation follows [rootless BuildKit](https://github.com/moby/buildkit/blob/master/docs/rootless.md)
and the [Buildx remote driver](https://docs.docker.com/build/builders/drivers/remote/).
