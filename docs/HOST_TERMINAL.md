# Browser SSH terminal

Administration > Connectors includes a **Host terminal** button. The browser
uses the authenticated dashboard API and the connector's existing outbound
WebSocket; the connector opens an SSH shell on its configured host. No inbound
dashboard connection to SSH is required. This works independently of Docker,
PM2 and container runtime operations.

Access requires Organization Administrator or `connectors.manage`. Project and
container terminal grants do not grant host shell access. Each session belongs
to the dashboard user who opened it. Permissions and connector revocation are
checked on every request, including before returning output. Sessions close
when the dialog closes, the connector disconnects, or polling stops for 30 seconds.

Configure the connector with:

```dotenv
HOST_TERMINAL_ENABLED=true
HOST_SSH_HOST=127.0.0.1
HOST_SSH_PORT=22
HOST_SSH_USER=app
HOST_SSH_PRIVATE_KEY_PATH=/home/app/.ssh/kloud_host
HOST_SSH_FINGERPRINT=SHA256:replace-with-the-host-key-fingerprint
```

Install the matching public key in the target account's `authorized_keys` and
allow SSH login and PTY allocation. The shell runs with that account's OS
permissions. Use an unencrypted, dedicated private key readable only by the
connector account; private keys stay on the connector and are never sent to
the dashboard. SSH password and interactive authentication are not supported.

Obtain the host fingerprint through a trusted console on the host, for example:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Copy the `SHA256:...` field exactly. If the host has multiple host keys, pin the
one negotiated by SSH (typically Ed25519), or configure sshd to offer that key.
Connections fail if the offered key differs. Restart the connector after changing
configuration; the button enables when it advertises `host-terminal` support.

For a containerized connector, `127.0.0.1` refers to the connector container.
Set `HOST_SSH_HOST=host.docker.internal` to reach the Docker host and use:

```sh
docker compose -f compose.connector.yaml -f compose.connector.ssh.yaml up -d
```

Set `HOST_SSH_PRIVATE_KEY_PATH` in `.env` to the absolute path on the Docker host.
The overlay mounts it read-only at `/run/secrets/host_ssh_key`. Ensure the
connector's container user can read it and sshd/firewall permits access from the
Docker network. You can instead specify a host address reachable from the
connector. Keep SSH configuration scoped to this host; the browser cannot choose
arbitrary SSH targets or credentials.
