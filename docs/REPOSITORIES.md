# Repository and registry connections

Repository deployment uses a saved, encrypted connection and an app-specific repository binding. The API resolves source credentials at dispatch; the connector supplies them only to its disposable checkout helper. Source credentials are absent from the build helper, runtime environment, saved checkout URL, and ordinary deployment configuration responses. Revoking a connection or removing/disabling its personal owner blocks future claims while leaving the serving app running.

Set a stable `PLATFORM_ENCRYPTION_KEY` in the API before creating connections, and back it up separately from PostgreSQL. Losing it makes saved source, registry, build, and runtime credentials unreadable. The application still requires one API instance for its process-local runtime broker.

## Prepare and administer Git connections

Open **Administration / Git connections** to prepare a shared GitHub App, GitHub PAT, Forgejo, or Gitea connection for a project before any service exists. The page lists personal and shared connections across projects, shows their ownership and status, and allows renaming, changing project availability, and revoking them. Credentials are never returned by the administration API.

In **Administration / Users**, Server Administrators can grant or remove **Create Git connections** (`git.create`) independently from **Manage all Git connections** (`git.manage`). Non-administrators are denied creation by default, including existing users after migration. Server Administrators retain all permissions. Managing connections does not itself grant creation permission. Creating a personal connection during service setup also requires deployment access to that service. Creating one in advance requires both Git permissions. Creation permission is checked again when completing GitHub setup, so removing it blocks an in-progress setup.

For shared connections, **Available to project deployers** permits users with service deployment access to browse and select repositories authorized by that connection. It does not expose credentials or permit changing delegation. Turn it off to limit new selections to explicit service repository bindings; existing bindings remain valid. Revocation blocks subsequent credential use, including queued builds. Users denied creation can still select authorized prepared or delegated connections in service setup. Repository and branch selection remain in the service's **Source** screen.

## Connect an app

Create the service record, open **Source**, and choose a setup method:

- **GitHub App installation**: choose **Add connection**, then **Create GitHub App**. Confirm the app on GitHub and install it on your personal account or the optional organization. Kloud exchanges the manifest code on the API server, encrypts the credentials, and verifies the installation before saving the connection. No App ID, installation ID, or private key needs to be copied. You can also select an authorized existing installation. Repository and branch selection happen here in service setup after installation. Each saved connection represents one installation.

- **Repository URL + personal access token**: add a PAT connection or select an authorized saved PAT. Enter `https://github.com/owner/repository` and validate access. Kloud requests that repository directly, without requiring a GitHub App, a `/user` lookup, or repository-listing permission. Select its branch after validation. Organization approval and SSO requirements still apply; a PAT does not bypass them.
- **Forgejo / Gitea access token**: enter the HTTPS provider origin, token-owner username and token. The token-owner username is used for HTTPS Git authentication. Enter a repository URL on that origin and select a branch.

Set `PUBLIC_ORIGIN` to the dashboard's externally accessible URL before creating an App. GitHub redirects to that origin, and push webhooks must be reachable there. Allow the GitHub popup and leave the connection setup page open while creating and installing the App. Setup states expire after 15 minutes per step, are bound to the signed-in user, project, and optional service, and cannot be reused after completion. The flow requests read access to repository contents and write access to repository hooks for the existing per-service automatic webhook setup.

For self-hosted providers, an administrator must first set `GIT_PROVIDER_ORIGINS` on the API to a comma-separated list of exact trusted HTTPS origins, for example `https://git.example.com,https://forge.internal.example`. Paths, credentials, query strings and fragments are rejected. This explicit origin authorization also permits deliberately configured private-network providers; Kloud does not automatically trust arbitrary internal addresses. Removing an origin disables subsequent use. The API and checkout helper both need network and TLS access to that origin. Verify API and webhook compatibility with the installed Forgejo/Gitea version.

Personal connections retain their owner. Users with **Manage all Git connections** can manage shared connections; creating them also requires **Create Git connections**. A connection owner or shared-connection manager with deployment access can replace the delegated repository list for a service in **Connection access and revocation**. Delegation does not disclose credentials or grant permission to deploy another service. Removing a repository binding blocks future dispatches, including already queued runs.

Existing manually configured GitHub sources remain supported through compatibility mode. They retain the connector-level source credential model. Migration preserves existing repository/host approvals; only server administrators may approve new or changed legacy repository/host pairs. App deployers may retain those exact approved sources. Selecting a scoped connection retires the app’s legacy approvals, so removing its connection ID cannot bypass delegation. Administrators can revoke an old repository/host approval through the legacy-source panel or DELETE `/projects/:project/git-connections/legacy/authorization`. Revocation blocks queued claims using that authorization. Prefer scoped connections for new apps.

## Reproducible build settings

Set these repository-relative POSIX paths separately:

- **Application root** identifies the app for framework/package-manager inspection.
- **Build file** identifies the committed Dockerfile or Compose definition, relative to repository root.
- **Build context** identifies the files Docker may use. A workspace app such as `apps/web` may need context `.` to include root lockfiles and shared packages.

Build paths must remain inside the checked-out repository, including after resolving symlinks. A missing configured build file blocks deployment. Existing prebuilt-image and image-only Compose sources do not require a Dockerfile.

**Inspect build inputs / suggest Dockerfile** reads selected app/root package metadata and lockfile evidence at the selected branch. pnpm alone is not treated as evidence of Next.js. Review and edit the suggestion, add an appropriate `.dockerignore`, and commit the Dockerfile yourself at the configured path. Kloud never commits a suggestion or deploys it as a dashboard-only override. Suggestions are starting points and may require production command, adapter, platform or dependency changes. Workspace suggestions require root context. The deployed build always uses the committed exact-commit contents.

Public build arguments are separate from runtime variables and private build secrets. Use them for intended public framework inputs such as `NEXT_PUBLIC_*` or `VITE_*`. The Dockerfile must declare/use the corresponding `ARG`; rebuild to change baked-in values. For Compose, declare nonsecret build arguments in the committed Compose definition.

## Private packages and registries

Add build secrets under **Private build and registry credentials**. For npm/pnpm private package configuration, use secret ID `npmrc` and supply the npm configuration as its value. The committed Dockerfile must consume the mount, for example:

```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install --frozen-lockfile
```

Secret files exist only in the disposable helper's temporary filesystem and are passed through BuildKit secret mounts. They are not ordinary Docker build arguments. Compose builds receive the same explicit build-secret IDs through a generated build-only secret configuration; the committed Dockerfile must still declare the matching secret mount. Build secrets are not automatically installed as runtime Compose secrets.

Registry credentials support private base images and runtime pulls. Use an app-specific encrypted credential or a reusable personal/shared registry connection. Reusable connections preserve ownership and app binding; owner disablement/project removal, connection revocation or delegation removal blocks subsequent use. Registry passwords are masked on normal reads. Choose one credential source per registry server. The worker uses isolated temporary Docker authentication and never alters the host's ordinary Docker login.

Output redaction covers supplied plaintext credentials and their HTTP Basic representation, including process-output chunk boundaries and dispatch-time encrypted redaction snapshots. Repository Dockerfiles remain trusted deployment code: intentionally transforming or exfiltrating a supplied secret is not prevented by redaction. Do not grant deploy permission to untrusted code authors.

## Push webhooks

After saving the source, choose automatic webhook setup. Kloud creates or updates only the hook whose callback exactly matches this app; unrelated provider hooks remain unchanged. It requests JSON push events, a signing secret, and TLS verification. Insufficient provider permission produces manual instructions instead of silently enabling polling.

For manual setup, add the displayed callback to the provider with JSON content type, push events, and the signing secret from the app webhook panel. Rotate the signing secret explicitly when needed and update the provider to match. If neither the user nor the token can manage hooks, choose **Use manual deployments only**. Manual deployment remains available; polling is not added. A saved draft alone does not deploy or activate a hook. Automatic dispatch requires completed app deployment setup and the app's automatic-deployment toggle.

Webhooks require a valid signature, matching canonical repository and configured branch. Delivery IDs are deduplicated and queued commits retain their exact configuration revision. GitHub and Forgejo/Gitea signature/event/delivery header variants are recognized for their configured provider. A network or organization-access failure is shown separately from webhook management availability.

## Verification limits

Unit and isolated PostgreSQL tests cover URL validation, JWT signing, ownership/delegation/revocation, direct-PAT access without listing, registry reuse, suggestion evidence, watch-path diff parsing and helper credential isolation. Tests do not substitute for deploying representative private repositories and private registries with real provider credentials. Before declaring the release accepted, exercise multiple App installations, removed installation access, organization SSO failures, installed Forgejo/Gitea versions, private npm/base/runtime images, and secret absence in exported image history and retained artifacts. Public HTTPS/domain verification is documented separately.
