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

| Method/path                 | Input                                                | Result                                                                                         |
| --------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /auth/setup`           | None                                                 | `{ required: boolean }`; true only when no accounts exist                                      |
| `POST /auth/setup/options`  | `{ username, password }`, password 12–256 characters | Registration options and five-minute `setup` cookie; empty installations only                  |
| `POST /auth/setup/verify`   | SimpleWebAuthn registration response                 | Atomically creates the first Server Administrator with password and passkey; sign in afterward |
| `POST /auth/password`       | `{ username, password }`                             | WebAuthn authentication options; sets five-minute `pending` cookie, never a session            |
| `POST /auth/verify`         | SimpleWebAuthn authentication response               | `{ ok: true }`; sets eight-hour `session` cookie                                               |
| `POST /auth/enroll/options` | `{ token, password }`, password 12–256 characters    | Registration options and five-minute `enrollment` cookie                                       |
| `POST /auth/enroll/verify`  | SimpleWebAuthn registration response                 | Atomically consumes invitation, registers passkey and password; sign in afterward              |
| `POST /auth/logout`         | None                                                 | Deletes current session and clears cookie                                                      |
| `GET /auth/me`              | Session                                              | `{ id, username, admin, capabilities }`                                                        |

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

| Method/path                                          | Result                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /projects`                                      | Accessible `{ slug, name, grant_mode, role, can_manage_access }[]` |
| `GET /projects/{project}/containers`                 | Container rows for an accessible project                           |
| `GET /projects/{project}/applications/{application}` | `{ slug }` if an assigned application exists                       |

A container row contains `connector_id`, `connector_name`, `host`, `seen`, `stale`,
`container_id`, effective `project`, effective `application`, `assignment`
(`label` or `manual`), and `data` (the sanitized protocol container below).
Unassigned containers are never returned to project members. CPU is a percentage
of one CPU and may exceed 100 on multicore workloads. Memory values are bytes;
unavailable metrics are `null`. The website hides all stale metrics.

## Administration

Server Administrators (`admin: true`, formerly super-admin) can use every route.
Other accounts need the matching server capability: `projects.manage` for project
administration, `users.manage` for account administration, `connectors.manage` for
connector administration, and `inventory.manage` for inventory and assignments.
Project managers also have full access to all projects' members and containers.
The other server capabilities do not grant project access.

| Method/path                                     | Input or behavior                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /admin/projects`                           | Lists all projects                                                                           |
| `POST /admin/projects`                          | `{ slug, name }`                                                                             |
| `GET /admin/users`                              | Users with disabled/enrolled status and project slugs                                        |
| `POST /admin/users`                             | `{ username, admin?: boolean, capabilities?: string[] }`; returns `{ enrollmentUrl }`        |
| `PUT /admin/users/{id}`                         | `{ disabled, projects?: string[], admin?: boolean, capabilities?: string[] }`                |
| `POST /admin/users/{id}/enrollment`             | Resets credentials and returns `{ enrollmentUrl }`; self-reset uses CLI                      |
| `GET /admin/connectors`                         | Names, host, discovery/revocation status and last-seen time; never tokens                    |
| `POST /admin/connectors`                        | `{ name }`; returns `{ id, token }` once                                                     |
| `PUT /admin/connectors/{id}`                    | `{ discovery, revoked }`; revocation is permanent                                            |
| `GET /admin/containers`                         | Assigned inventory plus unassigned inventory from discovery-enabled connectors               |
| `PUT /admin/containers/{connector}/{container}` | `{ project, application }` to assign; JSON `null` to unassign                                |
| `GET /admin/containers/projects`                | Project slug/name choices for inventory assignment (`inventory.manage`)                      |
| `PUT /admin/projects/{project}`                 | `{ name }`; changes display name, retaining the slug                                         |
| `DELETE /admin/projects/{project}`              | Deletes project records, memberships, assignments and grants; Docker containers keep running |

Successful mutations return `{ ok: true }` unless stated otherwise. Create routes
return 201. Container assignment requires discovery enabled and cannot override a
valid label assignment. Project and application slugs match
`^[a-z0-9]+(?:-[a-z0-9]+)*$` and are at most 100 characters.

Only Server Administrators may assign server capabilities or change Server
Administrator status. Delegated user managers cannot modify or reset privileged
accounts. Optional `projects` replaces the user's membership list and additionally
requires `projects.manage`; retained memberships keep their roles and grants, and
new memberships have no grants. Omit it to leave memberships unchanged.

## Project access and container grants

Project Administrators (`role: "admin"`) can manage their own project's access.
They cannot change project records, move containers, manage connectors, or reset
credentials. Project Members (`role: "member"`) can open their project but see
only containers covered by View grants. Application existence checks use the same
filter. Inaccessible projects/applications return 404; unauthorized management of
an accessible project returns 403.

The following routes require Project Administrator or `projects.manage`:

| Method/path                                      | Input or result                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `GET /projects/{project}/access`                 | `{ grant_mode, members: [{ id, username, disabled, role, grants }] }` |
| `PUT /projects/{project}/access/settings`        | `{ grant_mode: "id" \| "name" }`                                      |
| `POST /projects/{project}/access/members`        | `{ username, role, grants }`; 201 with `{ ok: true, enrollmentUrl? }` |
| `PUT /projects/{project}/access/members/{id}`    | `{ role, grants }`; replaces this membership's role and grants        |
| `DELETE /projects/{project}/access/members/{id}` | Removes only this membership and its grants                           |

Invitations create ordinary accounts or add an existing account to the project.
Only newly created accounts receive an enrollment link (valid for 24 hours).
Existing credentials and memberships elsewhere are untouched; disabled accounts
must be handled by a Server Administrator. Existing memberships return 409.

A grant has `{ capability, kind, connector_id, target }`:

- `capability`: `view`, `logs`, `lifecycle`, `terminal`, or `configuration`.
  **Only View is implemented.** The other four are stored permissions for planned
  features and do not enable Docker operations today. Each operational grant
  automatically includes View for its same target.
- `kind: "all"`: `connector_id` and `target` are null; covers current and future
  containers assigned to the project.
- `kind: "id"`: connector UUID plus a 64-character container ID. Recreation needs
  a new grant.
- `kind: "name"`: connector UUID plus the exact reported container name. Matching
  is case-sensitive and follows recreation on that connector within that project.

Grants are additive, without deny rules. They are bound to the membership and
effective project assignment. Snapshot replacement does not delete them, and they
never grant access while the container belongs to another project. Project and
Server Administrators implicitly have all container capabilities.

`grant_mode` defaults to `id` and only controls the editor's default for new grants.
ID and name grants can coexist; changing this setting preserves all grants.
Migration 3 gives existing memberships a project-wide View grant, preserving
visibility to current and future containers. New members start without grants.

Permission changes are serialized and authority is rechecked after locking.
Removing, demoting, or disabling the last active Server Administrator or the last
active Project Administrator returns 409. Project deletion through server project
management is allowed. Permission changes apply to existing sessions immediately
on their next request.

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
