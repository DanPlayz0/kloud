# Reversible control-plane cutover

This is an execution checklist, not evidence that a migration or five-host setup
has been performed. Keep the existing platform until recovery and replacement
workflows have been verified using representative data and workloads.

## Before a maintenance window

For each app, record repository/provider, branch and exact serving commit,
Dockerfile/Compose paths, app root/build context, image digests, public build
arguments, private build secrets, runtime variables, credentials, volumes, networks,
container identities, restart policy, health checks, domains, certificates and
push-deployment triggers. Preserve current configuration and routing backups
outside the control-plane database. Record ownership of every persistent volume.
Inventory discovery does not transfer deployment ownership.

Create new Kloud PostgreSQL targets; validate a representative original custom
`.dmp` export using archive metadata and a compatible restore client. Restore to
new databases, verify schema, known rows, extensions, role ownership and app queries,
and verify a second recovery from an independently retained backup. Do not infer
PostgreSQL versions from filenames. Never overwrite the existing source database.

Complete variable edits and review additions, changes and removals. Verify current
connections, repository delegation, committed Dockerfile availability, build secrets,
registry authentication, readiness probes, domain targets and exact DNS records.
Verify VPN/container-to-database paths separately where cross-host access is needed.
A successful backup upload is not proof that a restoration succeeds.

Test candidate failure, readiness failure, API/connector restart, proxy cutover and
rollback behavior on isolated representative apps. In-place dependency restarts and
startup schema migrations can interrupt or affect both releases; compatible app-owned
migrations remain the app owner's responsibility.

## Deliberate takeover

1. Schedule and announce the brief proxy interruption; name the operator and a
   rollback decision point. Preserve direct management access outside ports 80/443.
2. Disable the old platform's deployment trigger for the selected app before
   enabling Kloud's trigger. Confirm only one controller may mutate it.
3. Confirm all data backups, old route configuration and certificates are retained.
   Switch app connection strings only after explicitly verifying the new database.
4. Stop the old public proxy deliberately and verify ports 80/443 are released.
   Do not launch a competing Kloud proxy on those ports beforehand.
5. Start Kloud's reviewed proxy configuration, verify HTTP routing from an external
   client and complete real HTTP-01 certificate issuance on the intended hostname.
   Check certificate validity, hostname and HTTPS separately from DNS/route status.
6. Verify login, app queries, writes, uploads, background jobs and connector health.
   Record the serving release, runtime identities and data verification results.

## Rollback

If route/certificate or app verification fails, disable new deployment triggers,
stop the new public proxy, release 80/443, and restart the preserved former proxy
configuration. Restore the previous app ownership and triggers only after confirming
that the new controller is inactive. Preserve both databases and all backup artifacts.
A code/image rollback does not undo database changes: decide data rollback using the
verified recovery procedure, with an explicit assessment of writes since cutover.
Never delete volumes, databases or backups as a side effect of removing an app record.

Keep the old platform until the owner explicitly approves retirement after recovery,
application, public routing and operational acceptance checks. No production cutover
date or automatic retirement is implied by repository implementation.
