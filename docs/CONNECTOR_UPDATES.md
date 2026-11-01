# Connector versions and automatic updates

The connector overview shows the **running** release name, commit hash, start time, update policy, and last check. `/health` on the connector host also returns that status. Newly published connector images embed the source commit and release name during CI. Existing images must be replaced once before they can report this information; `unknown` means the running artifact did not contain a commit. For source installations set `CONNECTOR_REVISION` to `git rev-parse HEAD` when starting the process. Version reports describe the authenticated connector, not a remotely attested build.

Only organization administrators or members with connector management permission can request an update check or change its automatic update policy. The selected policy survives reconnects. Updates are disabled by default. The operator must first configure an absolute `CONNECTOR_UPDATE_COMMAND` executable path on the connector host. Dashboard requests cannot supply commands, arguments, image names, repository URLs, or environment variables. Automatic checks run every 15 minutes; `CONNECTOR_UPDATE_INTERVAL_MS` permits 60 seconds to 24 hours. Only one local check runs at a time, with a 10-minute limit. Restarting the connector briefly interrupts inventory and host operations.

The executable must be owned and writable only by the trusted host operator. It runs as the connector's OS user, with its environment. Keep update output free of secrets. The dashboard reports generic errors; inspect the host's update log for details. A completed check means the configured executable exited successfully; the running commit after reconnection establishes which build actually started. An updater that schedules background work acknowledges scheduling, not successful replacement.

## Docker Compose installations

Use the supplied `compose.connector.updates.yaml` overlay and `scripts/update-connector-docker.sh`. Put the scripts and **all** selected Compose files plus `.env` in the same host directory. In `.env`, set:

```dotenv
KLOUD_UPDATE_DIRECTORY=/opt/kloud-connector
KLOUD_UPDATE_PROJECT=kloud-connector
KLOUD_UPDATE_COMPOSE_FILES=compose.connector.yaml:compose.connector.updates.yaml
CONNECTOR_AUTO_UPDATE=true
CONNECTOR_UPDATE_INTERVAL_MS=900000
```

Use the installation's existing Compose project name, visible with `docker compose ls`. Include any other overlays the installation requires (PM2, SSH, deployment mounts, ports, or networking) in `KLOUD_UPDATE_COMPOSE_FILES`, separated by colons, in their normal order. These paths are relative to `KLOUD_UPDATE_DIRECTORY`; paths must not contain colons. Keep `CONNECTOR_IMAGE` on the release channel you intend to follow, such as `ghcr.io/ashmwtech/kloud-connector:latest`; immutable digest references intentionally never advance. Pin `KLOUD_UPDATER_IMAGE` to an approved Docker CLI image digest if required by your host policy.

Apply the overlays using the same project name:

```sh
docker compose -p kloud-connector -f compose.connector.yaml -f compose.connector.updates.yaml up -d
```

The trusted script launches an independent Docker CLI helper, pulls the configured connector image, then asks Compose to replace **only the connector** and wait for its health check. The helper continues running while the old connector exits. It uses the host Docker socket and a read-only bind mount of the configured host directory; that directory must exist on the same Docker daemon. Existing Compose environment, volumes, groups, and overlays are retained. A failed pull leaves the existing connector running. A failed replacement is reported in the helper logs and requires operator inspection; automatic rollback is not performed.

The fixed helper name prevents overlapping replacements. Its last result/log remains available with `docker ps -a --filter name=kloud-update-` and `docker logs <helper-name>` until the next check replaces the stopped helper. The helper has `kloud.internal=true` and is excluded from discovered application containers. Registry authentication inside the helper is separate from host `docker login`; for private images provide an operator-reviewed custom updater with appropriate registry credentials. Do not put registry secrets in dashboard commands.

## PM2 source installations

Use a dedicated, clean connector checkout owned by the same OS user as the PM2 connector process. Install `git`, `pnpm`, Node.js, PM2, and Linux `flock` in the process PATH. Configure:

```dotenv
CONNECTOR_UPDATE_COMMAND=/opt/kloud-connector/scripts/update-connector-pm2.sh
CONNECTOR_AUTO_UPDATE=true
KLOUD_UPDATE_DIRECTORY=/opt/kloud-connector
KLOUD_UPDATE_PM2_NAME=kloud-connector
KLOUD_UPDATE_BRANCH=main
```

The helper fetches that configured branch, requires a clean matching local branch, fast-forwards without discarding changes, installs locked dependencies, compiles the connector, and restarts the existing PM2 process with its new commit and version in the environment. If there is no new commit it does nothing. Fetch/install/compilation failure prevents the restart, leaving the currently running process in place; inspect and repair the checkout before retrying. Pin the branch to your reviewed release channel. Do not point this updater at a checkout shared by the dashboard development server. Other supervisors can use their own absolute trusted executable implementing the same contract.
