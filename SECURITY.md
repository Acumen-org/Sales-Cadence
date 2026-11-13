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

## If a secret may have leaked

Rotate it first, investigate second. Every key Cadence uses, where it lives and how to rotate it is
in [DEPLOY.md](DEPLOY.md), "Rotate a key"; to stop every write to the CRM at once, see
"Stop all CRM writes" in the same file.
