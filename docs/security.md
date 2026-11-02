# Security and trust

Lorecrew is for one trusted human owner and their controlled hosts. Agents have the permissions of the OS user running the service, including host files and supervised shell commands. This preview is not a filesystem sandbox or granular multi-user platform.

## Control the host and instructions

Run under an appropriately scoped OS account. Keep unrelated sensitive files out of that account's reach when possible. Review agent instructions, imported skills and commands before trusting them. Model output and imported content can be wrong or malicious.

Agent/group/global skill scopes organize discovery, not access control. A project's managed worktree and ownership checks coordinate Lorecrew-managed work; arbitrary external tools or editors can still change host files.

## Choose model providers deliberately

Lorecrew supports the configured provider/model through Pi AI, including compatible local endpoints. A remote provider receives the model request you send to it. Self-hosting the service does not make every model local. Keep keys and OAuth data in a private credential store, outside the vault and project repositories.

## Protect browser access

Start on loopback for local use. Treat pairing secrets and browser sessions as credentials. Revoke unneeded sessions. For remote access, set an explicit trusted origin and reviewed HTTPS proxy. Keep authentication, Origin checks and CSRF protection enabled.

The presentation website is static and separate from your running Lorecrew instance. It does not connect to your vault, providers or runtime and does not ask for credentials.

## Sharing and recovery

Review what belongs in the shared Markdown vault. Secret detection is best-effort and cannot prove every note safe. Git publication of knowledge does not grant execution ownership. Protect the hosting controls used for authority, and do not assume uncoordinated editors respect application locks.

Uncertain effects require investigation. Never clear lock, quarantine, permanent fence or operation history to bypass a blocker. Use the [backup/recovery procedure](backup-and-recovery.md), including fencing the original host and auditing the recovery point.

Report vulnerabilities through [the project's private reporting route](https://github.com/Odiobill/lorecrew/security/advisories/new). If unavailable, request a private contact without posting sensitive details.
