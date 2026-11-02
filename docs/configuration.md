# Configuration

Lorecrew reads the environment of the process that starts it. A background service does not automatically source your interactive shell profile.

## Paths and identity

| Setting | Default / meaning |
| --- | --- |
| Application prefix | `$HOME/.local/share/lorecrew/app` for managed installs |
| Managed command | `$HOME/.local/bin/lorecrew` |
| Runtime state | `$HOME/.local/state/lorecrew`; override with `--state-dir PATH` |
| Vault | Explicitly selected during first use; no preselected folder |
| Ordinary conversation cwd | The service host's recorded HOME |

State must be on a local filesystem outside vault/project worktrees. Keep each instance's state and identity separate. Missing recorded cwd blocks work; it is not silently replaced with the vault. Relocating an active instance is not supported.

## Credentials

Set `LORECREW_AUTH_FILE` to a dedicated private JSON credential store; the [quick start](getting-started.md#keep-credentials-separate) creates one without overwriting an existing file. Keep directory/file modes 0700/0600. Without an explicit override, Lorecrew uses the compatible Pi credential location selected by `PI_CODING_AGENT_DIR` or the shared Pi default.

Settings supports provider-owned API-key/OAuth flows and supported environment references. Stored secrets are masked; changing providers clears transient secret drafts. An explicitly selected but unset environment variable remains unavailable rather than falling back silently. Command-based credential values are unsupported because their descendants cannot satisfy the current stop-proof contract.

The provider/model catalog comes from the pinned Pi SDK. Credentials resolving locally means available/unverified, not that a live request succeeded. OAuth refresh can affect other applications if you deliberately share a credential file. Never publish the store or put keys in portable definitions or the vault.

## Browser access

Loopback is the default. Pair with the one-use terminal secret; browser sessions can be revoked. Closing the browser does not stop the service.

For deliberate LAN/remote access, configure the exact `--public-origin` and bind address. Keep Origin/CSRF checks enabled. Use HTTPS with a reviewed reverse proxy configuration for secure remote/PWA access. Do not infer trust from arbitrary forwarded headers. The included Caddy example is a template, not a configured deployment.

## Service environment

Provide explicit HOME, Node 24 executable, Git PATH, dedicated auth file and public origin. Review `lorecrew service print --platform systemd` or `--platform launchd` and replace every placeholder before installing anything. The installer never enables autostart. Host platform process-supervision limits still apply.

## Model and work configuration

Agent models/thinking, group memberships, skill discovery and routine schedules are configured through the UI and portable definitions. They do not create per-tool permission tiers. Foreground-priority gates coordinate background learning; there are no enforced token or monetary budgets in this preview.
