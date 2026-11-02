# Troubleshooting

Start with the actual diagnostic and preserve the original operation identity. Retrying blindly can obscure a recoverable outcome.

## The service cannot open state

Check Node 24/npm 11, Git availability, local filesystem paths and permissions. One service holds an instance state lock. Stop that exact instance normally before offline CLI work. Never delete a lock or signal a PID without proving it is the relevant owner. A stale-looking PID or elapsed time alone is insufficient.

An unselected new instance can show `INSTANCE_UNINITIALIZED` in doctor. Start the service, pair locally and choose a vault. A populated existing vault should not require recreating agents or rerunning optional setup.

## A model is unavailable

Open Settings for the selected provider, then inspect the agent's model. Check credential availability and explicit environment references. A key resolving locally is unverified until an actual deliberate request succeeds. An unsupported thinking level requires a supported choice or Default; credentials do not repair that mismatch.

Existing conversations keep their pinned definitions. Save the repaired agent and explicitly reload an eligible idle conversation, or start new work. Queued work or unsettled effects can correctly prevent reload.

## A browser disconnects

Reconnect or reload/re-pair when authentication expires. Review retained drafts and original receipts before retrying a save or send. The browser never queues an offline mutation for automatic later submission. Explicit Disconnect and a confirmed full reload have their documented draft-clearing behavior; keep important unsent text elsewhere when deliberately leaving.

A waiting UI update activates only by explicit choice. Unconfirmed command receipts must be reconciled before reload. Other tabs may need explicit Reload after a controller update.

## A project is available but cannot execute

Checkout and execution ownership are different. Inspect Projects details for binding/authority diagnostics. Do not claim ownership based on a clone, origin marker or portable catalog record. Used bindings require the original Git root and common directory. Another host's report is a historical view, not local authority.

## A Git or recovery operation is blocked

Keep its original intent, source/destination, staging state, index preimages and diagnostics. Use **Review original operation** and explicitly resume that same operation only after restoring the reviewed conditions. Do not start a replacement intent, overwrite an external index or clear ownership/quarantine fences.

A timed-out process may still exist. Recovery requires positive descendant/effect shutdown evidence. An incomplete or old backup may remain quarantined permanently; use [backup and recovery](backup-and-recovery.md) rather than forcing it executable.

## Report a bug

Record version, host OS, the user-visible trigger, expected/actual behavior and sanitized error code. Use a disposable reproduction when possible. Keep credentials, pairing secrets, private paths and transcripts out of public issues. Follow [security reporting](security.md) for sensitive details.
