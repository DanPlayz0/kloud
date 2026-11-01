#!/bin/sh
# Invoked by the connector's trusted updater. The replacement runs independently
# so replacing the connector cannot kill the Compose operation halfway through.
set -eu
: "${KLOUD_UPDATE_DIRECTORY:?Set an absolute host directory containing the connector Compose files}"
: "${KLOUD_UPDATE_PROJECT:?Set the existing Docker Compose project name}"
case "$KLOUD_UPDATE_DIRECTORY" in /*) ;; *) echo 'Update directory must be absolute' >&2; exit 1;; esac
case "$KLOUD_UPDATE_PROJECT" in [a-z0-9]* ) ;; *) echo 'Invalid Compose project name' >&2; exit 1;; esac
case "$KLOUD_UPDATE_PROJECT" in *[!a-z0-9_-]*) echo 'Invalid Compose project name' >&2; exit 1;; esac
helper="kloud-update-$KLOUD_UPDATE_PROJECT"
socket="${DOCKER_SOCKET:-/var/run/docker.sock}"
export DOCKER_HOST="unix://$socket"
if docker inspect --type container "$helper" >/dev/null 2>&1; then
  if [ "$(docker inspect --format '{{.State.Running}}' "$helper")" = true ]; then exit 0; fi
  docker rm "$helper" >/dev/null
fi
# This image and every file below are selected locally by the host operator.
# No dashboard request can supply executable text, image references or paths.
docker run --detach --init --name "$helper" --label kloud.internal=true \
  --mount "type=bind,src=$socket,dst=/var/run/docker.sock" \
  --mount "type=bind,src=$KLOUD_UPDATE_DIRECTORY,dst=$KLOUD_UPDATE_DIRECTORY,readonly" \
  --env "KLOUD_UPDATE_DIRECTORY=$KLOUD_UPDATE_DIRECTORY" \
  --env "KLOUD_UPDATE_PROJECT=$KLOUD_UPDATE_PROJECT" \
  --env "KLOUD_UPDATE_COMPOSE_FILES=${KLOUD_UPDATE_COMPOSE_FILES:-compose.connector.yaml:compose.connector.updates.yaml}" \
  "${KLOUD_UPDATER_IMAGE:-docker:29-cli}" sh -eu -c '
    cd "$KLOUD_UPDATE_DIRECTORY"
    set -- --project-name "$KLOUD_UPDATE_PROJECT" --project-directory "$KLOUD_UPDATE_DIRECTORY"
    old_ifs=$IFS; IFS=:
    for file in $KLOUD_UPDATE_COMPOSE_FILES; do
      test -f "$file"
      set -- "$@" -f "$file"
    done
    IFS=$old_ifs
    docker compose "$@" pull connector
    docker compose "$@" up -d --no-deps --wait --wait-timeout 120 connector
  ' >/dev/null
