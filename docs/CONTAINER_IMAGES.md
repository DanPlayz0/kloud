# Published container images

The **Publish container images** GitHub Actions workflow builds and pushes these
images to GitHub Container Registry (GHCR), using the repository's owner in
lowercase and the Kloud image names:

| Image | Purpose |
| --- | --- |
| `ghcr.io/owner/kloud-connector` | Host connector |
| `ghcr.io/owner/kloud-build-helper` | Isolated deployment helper |
| `ghcr.io/owner/kloud-api` | API and database migration CLI |
| `ghcr.io/owner/kloud-website` | Website and API proxy |

For example, repository `Danny/kloud` publishes
`ghcr.io/danny/kloud-connector:latest`.
All images support `linux/amd64` and `linux/arm64`.

## Publish automatically

Push this repository, including `.github/workflows/publish-images.yml`, to GitHub.
Enable Actions if disabled. No additional publishing secrets are needed: the
workflow uses the built-in `GITHUB_TOKEN` with `packages: write` permission.
Organization policies must allow Actions and package creation.

- Pushes to the default branch publish `latest` and `sha-<full-commit-sha>` tags.
- Version tags such as `v1.2.3` publish `1.2.3`, `1.2`, and the commit tag.
  Prereleases such as `v1.2.3-rc.1` publish their full version without moving `1.2`.
- **Actions > Publish container images > Run workflow** publishes the selected
  ref's commit tag; it also updates `latest` when running on the default branch.

`latest` tracks the default branch. Use a full version, commit tag, or image digest
when you want to pin a server to a specific build. Published tags and digests appear
in each build job's summary and on the repository's Packages page.

Packages are initially private. For anonymous pulls, change each package's
visibility to public in its package settings. For private pulls, give the server's
GitHub user access to the package and authenticate using a classic personal access
token with `read:packages` (authorize organization SSO if required):

```sh
docker login ghcr.io -u YOUR_GITHUB_USERNAME
```

Enter the token at the password prompt. See GitHub's
[container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
for package permissions and authentication.

## Run the connector on a separate Linux server

The recommended deployment is `compose.connector.auto.yaml`: one Compose file
with its updater embedded, plus a dedicated `.env`. Automatic updates are enabled
by default. Follow [single-file connector setup](CONNECTOR_UPDATES.md#single-file-installation)
for the host directory and existing Compose project settings. It requires no
repository checkout or separate update script. The manual-update installation
below remains available for hosts with their own update management.

Only Docker with Compose, `compose.connector.yaml`, and a `.env` file are needed
on the server. Copy the Compose file from this repository into a dedicated folder.
Create a token in **Administration > Connectors**, then copy
`.env.connector.example` to `.env` next to the Compose file and edit it. The minimal
settings are:

```dotenv
CONNECTOR_IMAGE=ghcr.io/owner/kloud-connector:latest
API_URL=https://dashboard.example.com/api/
CONNECTOR_TOKEN=replace-with-your-connector-token
CONNECTOR_HOST=upstream-server
DOCKER_GID=replace-with-socket-group-id
```

Replace `owner` with your lowercase GitHub repository owner. Set
`DOCKER_GID` to the output of `stat -c '%g' /var/run/docker.sock` on the server.
Restrict access to the token file with `chmod 600 .env`. For a private image,
log in to GHCR first as described above.

The Compose service uses `env_file: .env` to pass additional settings such as
`RUNTIME_ENABLED`, `PROXY_ENABLED`, and `POLL_INTERVAL_MS` into the container.
Compose's automatic `.env` loading alone only substitutes `${...}` values in the
Compose file; it does not inject every variable into the service. Explicit
`environment` entries take precedence over `env_file`; `DOCKER_SOCKET` stays
`/var/run/docker.sock` to match the declared socket mount. Keep this `.env`
dedicated to the connector, since all its variables are passed to the container.

After editing `.env`, apply changes by recreating the connector:

```sh
docker compose -f compose.connector.yaml up -d --force-recreate connector
```

`docker compose restart` does not apply environment changes. To verify a specific
non-secret setting without printing tokens, for example:

```sh
docker compose -f compose.connector.yaml exec connector printenv RUNTIME_ENABLED
```

To replace a connector credential, choose **Rotate token** on its card in
**Administration > Connectors** (or its overview) and confirm. The old token is
invalidated and the host is disconnected. Copy the new token shown beneath that
connector's controls, update `CONNECTOR_TOKEN` in the host's `.env`, then run the
recreate command above. The connector keeps its identity and resource assignments.
**Delete connector** removes the connector from the dashboard and permanently
invalidates its token after confirmation. Host workloads continue running.

Feature flags do not add host mounts. For PM2, add `-f compose.connector.pm2.yaml`
and configure `PM2_HOME`, `PM2_UID`, and `PM2_GID` as described in
[PM2 setup](PM2.md). This override binds the host PM2 home read-only and uses the
PM2 user's numeric IDs. To enable application builds, set
`DEPLOYMENTS_ENABLED=true`, pull the configured helper image, and add this local
`compose.connector.local.yaml` override:

```yaml
services:
  connector:
    volumes:
      - ${DEPLOYMENTS_DIR:-/var/lib/kloud/deployments}:${DEPLOYMENTS_DIR:-/var/lib/kloud/deployments}
```

Prepare that directory for the connector's UID 1000 (adjust the path if changed):

```sh
sudo install -d -o 1000 -g 1000 /var/lib/kloud/deployments
docker compose -f compose.connector.yaml -f compose.connector.local.yaml up -d --force-recreate connector
```

Use both Compose files on subsequent updates. See [deployment setup](DEPLOYMENTS.md)
for host requirements and helper configuration.

Start the connector:

```sh
docker compose -f compose.connector.yaml pull
docker compose -f compose.connector.yaml up -d
docker compose -f compose.connector.yaml logs -f connector
```

Run the first two commands again to install a newer image. Publishing an image
does not automatically restart existing server containers. The connector needs
outbound access to the dashboard and publishes no host ports.

This Compose file enables Docker inventory and metrics. For application
deployments, follow [deployment setup](DEPLOYMENTS.md) and set
`DEPLOYMENTS_HELPER_IMAGE` to the published `kloud-build-helper` image with
the same version or commit tag as the connector. Pull that helper image onto the
host before deploying, especially when using a private package.
