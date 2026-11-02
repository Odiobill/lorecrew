# Security

Lorecrew is a trusted, single-owner, self-hosted application. Its agents can read files and execute commands with the permissions of the OS user running the service. Agent/group/skill scopes organize context; they are not filesystem isolation or multi-user authorization boundaries.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Odiobill/lorecrew/security/advisories/new) when available. If that route is unavailable, open an issue asking for a private contact route without including the vulnerability details.

Do not post credentials, OAuth callbacks, pairing secrets, tokens, private transcripts, vault data or sensitive reproduction artifacts publicly. A useful private report explains affected versions, prerequisites, expected and actual behavior, and a minimal reproduction using disposable data.

## Operate deliberately

Bind to loopback for local use. Configure an explicit public origin and HTTPS before deliberate remote access. Keep state, credentials, vault and project paths separate. Review model providers and imported instructions. Stop all writers before backup; never clear locks, permanent fences or quarantine just to force work to resume.

See the [security guide](docs/security.md), [configuration](docs/configuration.md) and [backup/recovery](docs/backup-and-recovery.md) for operational details. The current preview does not provide a security sandbox, automatic forced ownership takeover or granular multi-user tenancy.
