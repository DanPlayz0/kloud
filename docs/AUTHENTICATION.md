# Account security

## Login addresses and direct management access

`PUBLIC_ORIGIN` is the canonical address used for CLI invitations and webhook URLs.
Set `ALLOWED_ORIGINS` to a comma-separated list of additional browser addresses.
Every entry must be an exact origin (scheme, hostname/IP, and port), without a
trailing slash or path. `PUBLIC_ORIGIN` is always included automatically; wildcards
are rejected. For example:

```dotenv
PUBLIC_ORIGIN=https://kloud.example.com
ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080,http://[::1]:8080,http://192.168.1.10:8080,http://203.0.113.10:8080
```

Replace the example LAN and public IP addresses with your server's addresses. Add
any additional tunnel domains as exact HTTPS origins. Compose defaults already
include localhost and IPv4/IPv6 loopback on port 8080. Restart the API after changing
these runtime settings; frontend rebuilding is not required for address changes.

The dashboard's published management port is **8080**. Accessing
`http://SERVER_IP:8080` goes directly to the dashboard website container, bypassing
an external reverse proxy, Cloudflare Tunnel, and service routing. Keep this port
reachable through your intended firewall/VPN access path for recovery. Port 3000
serves the API only. The direct management route still needs the dashboard website
and API containers running; if the dashboard's own web server is down, use SSH.

HTTP access is supported for explicitly configured addresses, including public IPs
in production. HTTP transmits credentials, codes, and sessions without encryption;
prefer direct HTTPS or an SSH/VPN path for remote recovery. HTTPS addresses receive
Secure cookies; HTTP addresses receive HTTP-compatible cookies. Cookies are
HttpOnly, SameSite=Strict, and host-only: sign in separately on each hostname/IP.
The API does not infer trusted origins or cookie security from arbitrary Host or
forwarded headers. The UI sends an allowlisted origin hint for read-only capability
reporting; this does not authorize mutations without a valid browser Origin.

Passkeys remain scoped to a relying-party hostname. A passkey registered on
localhost does not work on an unrelated tunnel domain; register another passkey
there after logging in with another factor or a recovery code. Passkey enrollment
and use are offered on HTTPS domain names and localhost, not raw IP addresses or
other HTTP hostnames. When a configured `WEBAUTHN_RP_ID` is a valid suffix of the
accessed hostname, it is retained; otherwise new credentials use that hostname.

Keep `WEBAUTHN_RP_ID` set to the **original** relying-party ID when applying migration
12 (for example `localhost` for locally enrolled keys). The migration records that
ID on existing credentials. New credentials store their own RP ID. Enabled 2FA is
never bypassed when a passkey is unavailable: configure TOTP, Email, or save recovery
codes before relying on direct-IP access. Browser-created invitations use the
address you are currently using so they remain usable while the proxy is down.
For a CLI-generated link, replace its origin with an allowed working address while
keeping `/enroll` and the full `#token` fragment unchanged.

Deploy API and website together and run migrations before starting the updated API.

## Optional second factors

Open **Account security** from the account menu to enable any combination of Email,
Authenticator app (TOTP), and Passkey. Login requires your password and any one enabled
method. Existing users with passkeys retain Passkey 2FA after migration; new accounts
start with password-only login. Save the ten recovery codes shown when first enabling
2FA. Each code works once; generating a replacement set invalidates the previous codes.
Changing security settings requires your password and an existing factor or recovery
code, signs out other sessions, and rotates your current session.

For TOTP, set `AUTH_ENCRYPTION_KEY` to 32 random bytes encoded as 64 hex characters:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep this key stable and back it up separately from PostgreSQL. Losing it requires
recovery codes or administrator recovery for affected accounts.

For Email 2FA, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and optionally
`SMTP_USER` / `SMTP_PASSWORD` together. Set `SMTP_TLS=starttls` for port 587 or
`SMTP_TLS=implicit` for port 465. `SMTP_TLS=plain` is for local development and is
rejected in production. Certificate validation is always enabled. Provider APIs are
not included; providers such as Amazon SES or Resend can use their SMTP service.
Email verification stays unavailable until SMTP is configured. Delivery failures
never bypass 2FA; use another enabled factor or a recovery code.

Codes expire after five minutes, allow five attempts, and email sends are limited to
one per minute and five per 15 minutes per user. A server without working SMTP or the
original TOTP encryption key retains enrolled protection; it does not downgrade users
to password-only login.

Administrator enrollment reset and `pnpm --filter @kloud/api cli recover <username>`
clear the password and all factors/codes, terminate sessions, and issue a fresh
password-enrollment invitation. Deploy the API and website together and run migrations
before starting the updated API; the authentication response format has changed.

To run authentication integration tests, set `TEST_DATABASE_URL` to an isolated
PostgreSQL database. Tests create and drop their own schemas and start a local SMTP
server. Browser tests use `E2E_DATABASE_URL` and Chromium virtual WebAuthn devices.
