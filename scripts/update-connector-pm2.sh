#!/bin/sh
# Install in a dedicated connector checkout, owned by the OS user running PM2.
set -eu
: "${KLOUD_UPDATE_DIRECTORY:?Set the dedicated connector repository checkout}"
: "${KLOUD_UPDATE_PM2_NAME:?Set the existing connector PM2 process name}"
case "$KLOUD_UPDATE_DIRECTORY" in /*) ;; *) echo 'Update directory must be absolute' >&2; exit 1;; esac
cd "$KLOUD_UPDATE_DIRECTORY"
# flock releases automatically on exit, including a supervisor restart.
exec 9> .connector-update.lock
flock -n 9 || exit 0
branch="${KLOUD_UPDATE_BRANCH:-main}"
[ "$(git symbolic-ref --short HEAD)" = "$branch" ]
# Never discard local edits or deploy unreviewed detached commits.
[ -z "$(git status --porcelain --untracked-files=no)" ]
git fetch --no-tags origin "$branch"
if [ "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)" ] && [ "${CONNECTOR_REVISION:-unknown}" = "$(git rev-parse HEAD)" ]; then exit 0; fi
git merge --ff-only FETCH_HEAD
pnpm install --frozen-lockfile
pnpm --filter @kloud/connector exec tsc
CONNECTOR_REVISION=$(git rev-parse HEAD)
CONNECTOR_VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("apps/connector/package.json","utf8")).version')
export CONNECTOR_REVISION CONNECTOR_VERSION
pm2 restart "$KLOUD_UPDATE_PM2_NAME" --update-env
