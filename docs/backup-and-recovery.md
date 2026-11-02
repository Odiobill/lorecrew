# Backup and recovery

Git history preserves the vault's readable content. Local execution state, private receipts and credentials need a separate backup strategy. Never copy a live SQLite directory as an instance backup.

## Prepare a complete backup

Stop admissions, settle known work and stop the service normally. Positively prove journaled processes and descendants have stopped; a dead service PID alone is insufficient. Stop external editors and other writers too. Do not remove a lock merely because a deadline elapsed.

```sh
lorecrew backup --state-dir /local/lorecrew-state \
  --destination /private/backups/lorecrew-snapshot
```

The destination must not already exist or overlap state. The result is a directory containing a versioned manifest and files, not a tar archive. Keep the complete directory in private trusted storage. Hashes detect corruption, not publisher authenticity.

Back up these separately while their writers are stopped:

- The vault and its Git repository.
- Project repositories and Git worktree metadata.
- The dedicated credential store, or plan to sign in again.

The state backup retains local databases, identity, execution/ownership records, history pins, artifacts and recovery/workspace data. Absolute paths can matter. Restoring active work requires the original state/vault/project paths and worktree metadata; this is not a relocation tool. OAuth credential rollback can invalidate shared sign-in, so prefer fresh provider login when appropriate.

## Fence the original before restoring

Prevent the original identity and **all its descendants** from executing, including automatic restarts. Network disconnection is insufficient because confirmed owners can work offline. A lost host needs a real physical/administrative fence.

Restore only into an empty destination:

```sh
lorecrew restore --archive /private/backups/lorecrew-snapshot \
  --state-dir /local/lorecrew-state --original-instance-fenced
lorecrew doctor --json --state-dir /local/lorecrew-state
```

The flag is your assertion; it does not fence a host. Restore remains quarantined. Establish that no work occurred after the snapshot, or independently audit every later external effect and missing receipt. Never repeat a possibly non-idempotent action to discover its outcome.

## Verify before execution

Only after that audit, deliberately verify the authoritative recovery point:

```sh
lorecrew restore-verify --state-dir /local/lorecrew-state \
  --authoritative-recovery-point
```

Verification checks cached grants against fresh control state when required. Unreachable authority, missing original paths or mismatched grants keep execution quarantined. It does not acquire ownership, clear permanent fences or manufacture receipts.

If the snapshot cannot be established as authoritative, retain it as quarantined history. Create fresh future work through valid explicit transfers rather than enabling two copies of one identity. Keep partial/failed restores and diagnostics; do not remove quarantine, incomplete markers, permanent fences or journals to force reuse.

General cross-version upgrades, active workspace relocation and arbitrary rollback of all shared authority copies are not guaranteed. See [troubleshooting](troubleshooting.md) when a verifier refuses to proceed.
