# Managed PostgreSQL and recovery

Enable `DATABASES_ENABLED=true` on a Docker-enabled connector. It advertises the
`postgres` capability; older connectors continue to collect inventory and cannot
accept database work. The project **PostgreSQL** page creates PostgreSQL 17.6
resources, imports custom archives, configures backup policies, runs backups and
restores into new resources. Image version `postgres:17.6-alpine` is fixed in the
worker; upgrading database majors is not performed automatically.

## Private databases and permissions

Each resource receives a unique named data volume and container. The container
joins `kloud-db-<project>` and publishes no host ports. Application containers on
the same host must join that network. Cross-host reachability needs separately
configured private networking; a Docker bridge does not span hosts. Public
PostgreSQL forwarding is unavailable until native PostgreSQL TLS is configured
and verified. An HTTP proxy certificate does not secure PostgreSQL traffic.

Generated credentials are encrypted by `PLATFORM_ENCRYPTION_KEY`. The app login
role `kloud` owns database `app` and has no superuser, role-creation or
database-creation authority. The separate bootstrap administrator password is
never returned by the credential-reveal endpoint. Creation, import and restore
never adopt an existing container or data volume.

Project/server administrators can manage resources. Database grants separately
control `read`, `manage`, `backup`, `restore`, `destinations`, and `reveal` and may
be project-wide or resource-specific. Configuration/deployment access to an app
does not grant these database rights. Administrators can delegate in **PostgreSQL → Database permissions**, or through
`PUT /projects/:project/databases/access/grants`, with a `user_id` and an array
of `{ resource: UUID|null, capability }` entries. Non-read grants also add read.
The owner must remain an enabled project member when a queued/scheduled job is
claimed. Revocation prevents subsequent execution and leaves data running.

App deletion cannot remove a database, its volume, or restore artifacts. There
is deliberately no implicit database deletion or volume-cleanup operation.

## Destination setup

For disk backups create an existing administrator-controlled directory and set
`BACKUP_DISK_ROOT` on the connector. Every configured disk destination must resolve
inside that root, including symlinks. The worker creates only
`<destination>/kloud/<policy UUID>/<job UUID>.dump`. Policy pruning can remove only
its own recorded artifacts; it never sweeps unrelated files. The connector
requires write access to these directories. The optional `compose.recovery.yaml` overlay enables database work and mounts an administrator-prepared host directory as `/var/lib/kloud/backups`; ensure the connector's non-root user can write it. Optional `BACKUP_STAGING_ROOT` selects
local temporary staging; the default is the connector deployment directory's
`database-staging` child.

S3 destinations use HTTPS, encrypted credentials, path-style S3 requests and
AWS Signature V4. Configure endpoint, region, bucket, key prefix and credentials.
Permissions must allow object PUT/GET/HEAD/DELETE in that prefix. The connection
test writes an isolated test object, verifies readback and removes it. Backups
record SHA-256, size, PostgreSQL server/client version and custom-archive format.
S3 PUT completion is checked with HEAD length and checksum metadata before its
restore point becomes complete. An S3 provider must support these standard
operations; test the actual endpoint before enabling a policy.

Each policy selects one disk destination, one S3 destination, or both. Limits,
minimum retained points and free-space reserve are explicit per destination;
there is no hidden global storage budget. Disk and S3 outcomes are independent.
A successful disk backup remains complete when S3 fails; history reports partial
success. S3-only staging is removed after upload/reporting and is not a retained
disk point. Failed artifacts never count as restore points.

Retention preserves the existing minimum number of complete restore points.
It rejects a new backup when the cap cannot be met without deleting protected
points. New artifacts are verified and finalized before eligible old artifacts
are pruned. This intentionally favors recoverability over admitting a backup
that relies on deleting a protected point first. Staging and destination free
space include reserves. Storage exhaustion fails the backup without removing
protected backups. Host jobs serialize backup/prune work.

## Schedules and execution

The editor offers daily, weekly, monthly and custom five-field cron schedules,
with an explicit IANA timezone and a next-run review. Cron supports numeric fields,
ranges, comma lists and steps; weekdays are 0 (Sunday) through 6. Restricted day
of month and weekday fields use standard OR semantics. DST is evaluated in the
selected local timezone. If both repeated wall-clock minutes match during a fall
transition, both are valid occurrences; nonexistent spring times are skipped.
The next-run preview searches up to one year. Delayed execution coalesces missed
schedule times into one due backup and computes the next future occurrence.

Jobs and outcomes are durable in PostgreSQL, with request-key deduplication.
Only one database operation runs on a connector at a time. A lost worker's lease
becomes `unknown` after 65 minutes and pauses database dispatch on that host;
no ambiguous restore is automatically repeated. An authorized manager can use
**Inspect and reconcile host** to queue a dedicated inspection while dispatch is
paused. It checks container ownership and confirms no `pg_dump`/`pg_restore` work
is active. An incomplete new create/import/restore target is stopped and retained;
the original operation is marked failed, never inferred successful. Existing
source databases and backup files are preserved. A running unhealthy target or
active recovery command keeps the pause in place. A fresh explicit operation
must use a new resource; reconciliation never replays an uncertain restore.

## Import and restore

Imports accept raw PostgreSQL `pg_dump --format=custom` archives with the `PGDMP`
signature, up to 64 MiB through the dashboard/API. Other formats and cluster-wide
`pg_dumpall` exports are rejected. Archive names are not used to infer a database
version. `pg_restore --list` must succeed with the pinned client; source and dump
client versions and required extensions are inspected before restore. A newer
archive/target requirement or missing extension fails with the new target
isolated and stopped. The source archive is retained until its operation reaches
an acknowledged successful outcome; failed/unknown uploads remain available for investigation. Per-project import staging is capped at 1 GiB. After a failed import is reconciled, an authorized user may explicitly discard its retained upload from history; this does not delete a database or volume. Failed restores keep their data volume for
inspection and never replace a working database.

Restore always creates a newly named resource and uses `--no-owner --no-acl`,
remapping object ownership to the restricted app role. Original role/ACL mapping
is not supported. Supported built-in extensions are installed before restoring
under the app role; third-party extension images need a separate reviewed image
policy. SQL is not executed by a host shell. Application connection strings are
changed only by a separate explicit app configuration edit.

Disk restores run on the destination's original host; an arbitrary local path
is not a cross-server transfer mechanism. S3 restore points can be restored to
another authorized PostgreSQL-enabled connector. The complete artifact is
checksummed before import; existing target containers and volumes are rejected.

## Verification and release gates

Focused unit tests cover cron/timezones, retention boundaries, archive metadata
and S3 signing. API integration tests use isolated PostgreSQL schemas to check
permission boundaries, encrypted credentials, request deduplication, policy
reviews, revoked connectors and unknown leases. The opt-in live test is:

```
RUN_POSTGRES_DOCKER=1 pnpm --filter @kloud/connector exec tsx --test src/postgres-recovery.live.test.ts
```

It creates disposable resources, inserts known data, produces a disk custom
backup, restores it into a new resource, verifies source/target rows, rejects an
existing target and checks a malformed archive. It cleans up only its own test
containers, volumes, network and directory. Set `DOCKER_SOCKET` when Docker uses
a nondefault socket.

The first-release migration gate still requires a representative actual existing
platform `.dmp` export, the actual S3 destination, storage-exhaustion/partial-upload
and lost-worker exercises, and private cross-host connectivity. Passing the
controlled disk recovery test is not evidence that those external workflows or
production data migration have been accepted. No external platform containers,
ports, triggers or databases are taken over by this implementation.
