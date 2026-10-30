# API contracts

Browser-facing URLs use `/api`; the Hono server paths below omit that prefix.
JSON mutations require `Origin` equal to `PUBLIC_ORIGIN`. Sessions are opaque
HttpOnly, SameSite=Strict cookies, Secure under HTTPS. Responses are not cached.
The protected OpenAPI document is available at `GET /openapi.json`.

Errors use `{ "error": "message" }`. Statuses include 400 invalid input, 401
authentication required/failed, 403 forbidden, 404 missing or inaccessible project,
409 conflict, 429 throttled login, and 503 unavailable dependency. Requests are
limited to 64 KiB, apart from the separately bounded WebSocket protocol.

## Authentication

| Method/path                 | Input                                             | Result                                                                              |
| --------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /auth/setup`           | None                                              | `{ required: boolean }`; true only when no accounts exist                           |
| `POST /auth/setup/options`  | `{ username, password }`, password 12–256 characters | Registration options and five-minute `setup` cookie; empty installations only       |
| `POST /auth/setup/verify`   | SimpleWebAuthn registration response               | Atomically creates the first super-admin with password and passkey; sign in afterward |
| `POST /auth/password`       | `{ username, password }`                          | WebAuthn authentication options; sets five-minute `pending` cookie, never a session |
| `POST /auth/verify`         | SimpleWebAuthn authentication response            | `{ ok: true }`; sets eight-hour `session` cookie                                    |
| `POST /auth/enroll/options` | `{ token, password }`, password 12–256 characters | Registration options and five-minute `enrollment` cookie                            |
| `POST /auth/enroll/verify`  | SimpleWebAuthn registration response              | Atomically consumes invitation, registers passkey and password; sign in afterward   |
| `POST /auth/logout`         | None                                              | Deletes current session and clears cookie                                           |
| `GET /auth/me`              | Session                                           | `{ id, username, admin }`                                                           |

WebAuthn responses must match the stored one-time challenge, configured RP ID,
origin, and required user verification. Login permits ten password attempts per
normalized username per 15-minute window. Successful two-factor login clears that
username's counter. Disabled users cannot enroll or authenticate. Enrollment resets
invalidate existing sessions. Expired state is periodically deleted.

Once the API observes an existing account or commits first-account setup, it
caches that state in memory until the process restarts. Setup status checks and
rejected setup submissions then require no database access. Concurrent initial
status checks share one query; empty results and database failures are not cached.
Each API process maintains its own cache. Removing every account manually requires
restarting the API to reopen setup.

## Project data

| Method/path                                          | Result                                       |
| ---------------------------------------------------- | -------------------------------------------- |
| `GET /projects`                                      | Accessible `{ slug, name }[]`                |
| `GET /projects/{project}/containers`                 | Container rows for an accessible project     |
| `GET /projects/{project}/applications/{application}` | `{ slug }` if an assigned application exists |

A container row contains `connector_id`, `connector_name`, `host`, `seen`, `stale`,
`container_id`, effective `project`, effective `application`, `assignment`
(`label` or `manual`), and `data` (the sanitized protocol container below).
Unassigned containers are never returned to project members. CPU is a percentage
of one CPU and may exceed 100 on multicore workloads. Memory values are bytes;
unavailable metrics are `null`. The website hides all stale metrics.

## Administration

Every route below requires a super-admin session.

| Method/path                                     | Input or behavior                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /admin/projects`                           | Lists all projects                                                             |
| `POST /admin/projects`                          | `{ slug, name }`                                                               |
| `GET /admin/users`                              | Users with disabled/enrolled status and project slugs                          |
| `POST /admin/users`                             | `{ username, admin?: boolean }`; returns `{ enrollmentUrl }`                   |
| `PUT /admin/users/{id}`                         | `{ disabled, projects: string[] }`; replaces memberships                       |
| `POST /admin/users/{id}/enrollment`             | Resets credentials and returns `{ enrollmentUrl }`; self-reset uses CLI        |
| `GET /admin/connectors`                         | Names, host, discovery/revocation status and last-seen time; never tokens      |
| `POST /admin/connectors`                        | `{ name }`; returns `{ id, token }` once                                       |
| `PUT /admin/connectors/{id}`                    | `{ discovery, revoked }`; revocation is permanent                              |
| `GET /admin/containers`                         | Assigned inventory plus unassigned inventory from discovery-enabled connectors |
| `PUT /admin/containers/{connector}/{container}` | `{ project, application }` to assign; JSON `null` to unassign                  |

Successful mutations return `{ ok: true }` unless stated otherwise. Create routes
return 201. Container assignment requires discovery enabled and cannot override a
valid label assignment. Project and application slugs match
`^[a-z0-9]+(?:-[a-z0-9]+)*$` and are at most 100 characters.

## Connector protocol v1

Connect to `/connectors/ws` (or `/api/connectors/ws` behind Nginx) with
`Authorization: Bearer <connector-token>`. Authenticate before upgrading. Tokens
are hashed in PostgreSQL; revoked or invalid credentials receive HTTP 401.
Each connector has one active connection; a new connection replaces the previous
one. Maximum frame payload is 2 MiB. Invalid, binary, duplicate-ID, or overlapping
snapshot messages close the connection with policy-violation status.

Send a full snapshot:

```json
{
  "version": 1,
  "type": "snapshot",
  "host": "production-01",
  "containers": [
    {
      "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "name": "imgen",
      "state": "running",
      "project": "miki",
      "application": "imgen",
      "cpu": 12.5,
      "memory": 67108864,
      "memoryLimit": 268435456
    }
  ]
}
```

The server responds `{ "type": "accepted", "version": 1 }` after committing the
replacement transaction. Server receipt time defines freshness. Container IDs are
64 lowercase hexadecimal characters. States are `created`, `running`, `paused`,
`restarting`, `removing`, `exited`, or `dead`. Slugs and metrics can be null. Snapshots
contain at most 5,000 unique containers and reject unknown fields. Environments,
arbitrary Docker labels, credentials, and internal containers are never transmitted.
The shared `@dedi-dash/protocol` package defines validation for both endpoints.
