# Security policy

## Supported versions

Cadence is an internal application with one production deployment: whatever is on `main` and
deployed by CI to the Nomad job `cadence`. Only that version receives fixes; there are no
maintained release branches.

## Reporting a vulnerability

Do not open a public issue or pull request for a security problem, and do not test against the
production instance or the production CRM.

Report it privately through GitHub's private vulnerability reporting for this repository
(Security > Report a vulnerability), or directly to the repository's maintainers. Include what you
found, how to reproduce it, and what it exposes. Expect an acknowledgement within two working days.

## Accepted risks

Known, decided and left as they are (the reasoning is in DECISIONS.md):

- `/login/admin` stays open as a password way in for admins, with no second factor. It takes 5
  wrong passwords per address and caller in 15 minutes, 20 per caller, and 50 per address a day;
  every wrong password and lock for a real account is in the audit log; an admin password needs
  12 characters and may not be a well-known one. Set `API_TRUSTED_PROXY_HOPS` behind the proxy so
  the per-caller counts see real addresses.
- Anyone in the Microsoft tenant at an internal domain who signs in joins as an untitled Junior FO,
  and every role reads every pod.
- The Twenty webhook accepts a plain body signature (no timestamp) and, with no secret, a shared
  `?token=`; a deployment can opt in to unsigned events with `CADENCE_WEBHOOK_OPEN=1`.
- The Bellwether integration is one shared key with no per-action scope or IP limit; its rate limit
  and the read API's are per process.
- The Microsoft client secret saved under Settings > Sign-in is stored in clear in the database; set
  `MICROSOFT_CLIENT_SECRET` in the server's environment instead to keep it out of backups.
- No Content-Security-Policy `script-src` (Next's inline scripts would need nonces); framing by other
  sites, plugins and `<base>` are refused.

## If a secret may have leaked

Rotate it first, investigate second. Every key Cadence uses, where it lives and how to rotate it is
in [DEPLOY.md](DEPLOY.md), "Rotate a key"; to stop every write to the CRM at once, see
"Stop all CRM writes" in the same file.
