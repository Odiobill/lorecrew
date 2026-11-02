# API and CLI

The browser and CLI use the same local runtime and guarded repository/ownership services. Start with the browser for ordinary work; use CLI diagnostics and reviewed operations when appropriate.

## Common commands

| Command | Purpose |
| --- | --- |
| `lorecrew serve` | Start the service and browser listener |
| `lorecrew doctor --json` | Inspect the stopped instance and host capabilities |
| `lorecrew init --vault PATH` | Explicit CLI vault initialization |
| `lorecrew session models` | Inspect configured model metadata |
| `lorecrew session create/submit/status/cancel` | Deliberate local conversation operations |
| `lorecrew repository status/clone/checkpoint/publish/confirm-remote` | Guarded native repository workflows |
| `lorecrew sharing enable/join/status` | Explicit sharing/authority configuration |
| `lorecrew project handoff/handoff-status/preflight/accept` | Checkpoint-aware stopped transfer |
| `lorecrew backup`, `restore`, `restore-verify` | Stopped, fenced recovery |
| `lorecrew service print --platform systemd` | Print a template for review |

In a source checkout, use `node dist/cli.js` instead of the managed command. `--state-dir PATH` selects a separate instance. Offline CLI operations require stopping the service that holds its state lock. Keep your selected `LORECREW_AUTH_FILE` in the command environment.

Repository/sharing/transfer mutations take reviewed JSON input through `--input FILE` and a stable `--request-id`. Inspect the actual operation schema/diagnostic before confirming; do not invent missing ownership or retry uncertain work under a new identity.

## HTTP API

The versioned service base is `/api/v1`. Browser pairing uses `/auth/login` and `/auth/session`; writable browser actions require authenticated sessions, correct Origin and CSRF. Scoped API tokens are separate from browser sessions. Do not disable browser-only restrictions to automate private setup/recovery routes.

Key resources include `/startup`, `/snapshot`, `/agents`, `/groups`, `/sessions`, `/tasks`, `/projects`, `/project-catalog` and `/project-workflows`. Responses are schema-validated; mutable operations retain revision/idempotency requirements. See the route schemas in the source for exact request/response types before building an integration.

Local events use server-sent events with cursors. A reset means fetch a fresh canonical snapshot and reconnect at its sequence. Private API/history responses are not service-worker cache content. A public static website cannot control a running instance without its explicit authenticated API access.

The API is an extension seam for future clients. It does not imply MCP connectors, remote command delivery or automatic cross-host control are already implemented.
