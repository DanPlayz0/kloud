# Account security

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
