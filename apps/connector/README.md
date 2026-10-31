# Server connector

The connector also supports existing Linux PM2 instances, independently of Docker.
See [PM2 setup](../../docs/PM2.md) for `PM2_ENABLED`, `PM2_HOME`, PM2-only hosts,
Docker socket/log mounts, and project permissions.

The connector collects read-only Docker inventory and CPU/RAM usage and sends
validated full snapshots to the API over an authenticated outbound WebSocket.
With deployments disabled (the default), it does not change containers.
Set `DEPLOYMENTS_ENABLED=true` to process authorized service deployments through
temporary checkout/build helpers and rootless BuildKit. The helpers receive no
host Docker socket or connector credential. The connector imports built images
and creates or updates the service's runtime containers.

See [service deployments and build isolation](../../docs/DEPLOYMENTS.md) for
building the helper image, host requirements, resource limits, and private GitHub
source credentials.

Copy `.env.example` to `.env` in this directory. Create a token in the dashboard's
Administration > Connectors screen and set `CONNECTOR_TOKEN`. Set `API_URL` to the
API base (`https://dashboard.example.com/api/` behind the website proxy), and
configure the local `DOCKER_SOCKET` and socket permissions.

```sh
pnpm --filter @dedi-dash/connector dev
pnpm --filter @dedi-dash/connector build
pnpm --filter @dedi-dash/connector start
```

The default Unix socket is `/var/run/docker.sock`; Windows uses
`//./pipe/docker_engine`. Collection runs every five seconds by default, with
bounded concurrency and a ten-second deadline. The connector reconnects with
backoff and reports API/Docker reachability at loopback-only
`http://127.0.0.1:3001/health`. Liveness stays healthy during upstream outages.

Containers labeled `dedi-dash.internal=true` are excluded. Only the explicit
`dedi-dash.project` and `dedi-dash.application` label values are transmitted;
environment variables and arbitrary labels are never included.

CPU usage is calculated from successive samples retained by the collector. The
first reading after startup, a counter reset, or a container restart may be
unavailable until the next collection.

For Compose deployment, token setup, manual assignment, and Linux socket-group
configuration, see [dashboard setup](../../docs/SETUP.md). The shared protocol and
API are documented in [API contracts](../../docs/API.md).
