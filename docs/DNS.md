# Cloud DNS

Cloud DNS manages existing Cloudflare zones. Server-owned provider connections
delegate domains or record scopes to projects. Project administrators can also
connect private providers. Discovery lists zones but grants no access: select a
zone, project, and rules, then save project DNS access.

## Setup

Run the database migrations, then set `DNS_ENCRYPTION_KEY` in the API environment
(or the root Compose `.env`) to 32 random bytes encoded as 64 hex characters.
For example, run `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Keep the key stable and back it up separately from the database. Without it the
rest of the dashboard works, but DNS credentials cannot be stored or used.
Changing or losing it requires replacing every provider token. Never commit it.

Use **Create Cloudflare API token** in the provider setup form to open Cloudflare
with Zone Read, DNS Edit (which includes read), and the name `Kloud DNS`
prefilled. The template includes all zones; optionally restrict it to the desired
zones before creating the token, then copy and paste the token into the form.
Use Administration → DNS providers for shared connections, or Project → Cloud
DNS → Private providers for a connection restricted to one project.
Tokens are encrypted with AES-256-GCM and are never returned by any API.

## Delegation and member access

The `dns.manage` server capability manages shared providers and project
delegations. Server Administrators have this capability automatically. Private
connections are managed by project administrators (including existing
`projects.manage` authority); only Server Administrators have all authority
automatically. Private connections cannot be shared to other projects.

Each project delegation selects a zone, allowed types/actions, and one scope:

- `zone`: all records in that provider zone; target is null.
- `name`: an exact fully qualified DNS name.
- `subtree`: that name and its descendants, matched at DNS label boundaries.
- `record`: an existing provider record ID. Creation cannot be granted by ID.

DNS names normalize to lowercase Punycode without a trailing dot. A name such as
`*.example.com` is literal, not a permission pattern. Name scopes include future
matching records; ID scopes do not follow a deleted/recreated record.

Rules grant `read`, `create`, `update`, and/or `delete`; writes imply read.
Project administrators receive the project's delegated access. Other members
need DNS grants in Project Access. Every operation must match both project and
member grants. A project administrator cannot expand the provider owner's
delegation. Narrowing a delegation immediately caps previously saved member
grants, even if their stored rules are broader. Updates authorize the current
record and the proposed name/type; ID rules still require an allowed type and
the same zone.

For example, grant `discord.com`, `discord.gg`, `discord.new`, and
`discord.media` to Discord, and also grant `voice.discord.media` A/AAAA/SRV
records to Voice. A friend can receive a narrower exact-name or record-ID grant.
Projects with overlapping writable grants edit the same live records.

## Operational behavior

Cloudflare remains authoritative. All 21 currently supported create/update
record types have typed forms, including structured records. Provider/plan
restrictions are checked by Cloudflare. External edits can race dashboard edits;
there is no atomic conflict detection. Refresh before retrying an unconfirmed
write; writes are never retried automatically.

Writes and access changes use the existing permission transaction lock. Access
is rechecked after acquiring it. Revocation prevents subsequent operations;
an already-dispatched provider request can complete. Listing is filtered before
returning records, metadata, or counts. Disabled connections are unavailable to
projects; owners can still test credentials and inspect their connection.

Disconnecting a provider, revoking a delegation, or deleting a project removes
local access only. It never deletes live DNS records. Zone registration,
creation/deletion, DNSSEC, and automatic deployment-to-DNS wiring are outside v1.

## Testing

`pnpm test` includes schema, authorization, encryption, and mocked-provider tests.
Set `TEST_DATABASE_URL` to an isolated PostgreSQL 17 database to enable DNS
integration tests. They create/drop their own schema and mock Cloudflare; no live
DNS writes occur. Browser tests use `E2E_DATABASE_URL` and the existing Playwright
configuration. Run migrations on that isolated database before browser tests.
