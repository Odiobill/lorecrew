import { spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import type { InstanceContext } from './open.js';
import { openVault } from '../vault/write.js';
import { listModels, openProviders } from '../runtime/providers.js';
import { LinuxProcessProbe } from '../workspaces/processes.js';
import { assertRestoredExecutionAllowed } from './recovery.js';
export interface Diagnostic {
    code: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
    remediation: string;
}
export function prerequisiteDiagnostics(): Diagnostic[] {
    const node = Number(process.versions.node.split('.')[0]) === 24, git = spawnSync('git', ['--version'], { encoding: 'utf8' });
    return [
        { code: 'NODE_VERSION', severity: node ? 'info' : 'error', message: `Node.js ${process.versions.node} (${process.platform}/${process.arch})`, remediation: node ? 'None.' : 'Install Node.js 24 LTS and configure the service executable explicitly.' },
        { code: git.status === 0 ? 'GIT_AVAILABLE' : 'GIT_REQUIRED', severity: git.status === 0 ? 'info' : 'error', message: git.status === 0 ? git.stdout.trim() : 'Git is unavailable on PATH.', remediation: git.status === 0 ? 'None.' : 'Install Git and add its binary directory to the service PATH; shell profiles are not imported.' },
    ];
}
export async function diagnose(ctx: InstanceContext): Promise<Diagnostic[]> {
    const diagnostics = prerequisiteDiagnostics();
    const initialization=await ctx.store.read<{phase:string;diagnostic?:string}>('vault-initialization','current');
    if(initialization&&initialization.phase!=='ready'){diagnostics.push({code:'INSTANCE_UNINITIALIZED',severity:'error',message:initialization.diagnostic??'Vault initialization is incomplete.',remediation:'Start serve, pair locally and retry the saved vault binding; do not switch targets or clear ownership evidence.'});return diagnostics;}
    const {assertCurrentExecutionState}=await import('../runtime/compatibility.js');
    try{await assertCurrentExecutionState(ctx);}catch(error){diagnostics.push({code:error&&typeof error==='object'&&'code' in error?String(error.code):'PREVIEW_STATE_INCOMPATIBLE',severity:'error',message:error instanceof Error?error.message:'Obsolete preview state cannot be resumed.',remediation:'Stop the owner and run lorecrew repository migrate --inspect; preserve original paths, receipts and recovery evidence.'});return diagnostics;}
    const durability = ctx.store.durability();
    diagnostics.push({ code: 'CONTROL_DURABILITY', severity: durability.journalMode === 'wal' && durability.synchronous === 2 ? 'info' : 'error', message: `Control SQLite journal=${durability.journalMode}, synchronous=${durability.synchronous}.`, remediation: 'Use local storage; WAL and FULL synchronization are required.' });
    for (const issue of await openVault(ctx).diagnose())
        diagnostics.push({ code: issue.code, severity: issue.severity, message: issue.message, remediation: 'Repair the indicated vault document; see vault diagnostics and the OKF 0.2 format.' });
    try {
        const available = (await listModels(await openProviders(ctx.stateDir))).some(model => model.available);
        diagnostics.push({ code: available ? 'PROVIDER_CONFIGURED' : 'PROVIDER_UNAVAILABLE', severity: available ? 'info' : 'warning', message: available ? 'Provider credentials resolve in this process environment; authentication has not been tested.' : 'No configured provider credentials resolve in this process environment.', remediation: 'Use Settings to add shared Pi credentials or sign in, or set legacy providers.json environment references in the service; availability does not test provider authentication.' });
    }
    catch {
        diagnostics.push({ code: 'INVALID_PROVIDERS', severity: 'error', message: 'Provider configuration cannot be loaded.', remediation: 'Check the shared Pi auth file and supported provider modules/environment references in providers.json without printing credential contents.' });
    }
    for (const kind of ['project-binding', 'workspace', 'workload-workspace'])
        for (const workspace of await ctx.store.list<{
            path: string;
            state?: string;
        }>(kind)) {
            if (workspace.state && workspace.state !== 'active')
                continue;
            try {
                if (!(await lstat(workspace.path)).isDirectory())
                    throw new Error();
            }
            catch {
                diagnostics.push({ code: 'WORKSPACE_MISSING', severity: 'error', message: `Missing ${kind} directory: ${workspace.path}`, remediation: 'Restore the original local project/workspace path. Never reset ownership fences to work around a missing directory.' });
            }
        }
    const probe = await new LinuxProcessProbe().snapshot();
    diagnostics.push({ code: 'PROCESS_SUPERVISION', severity: probe.complete ? 'info' : 'warning', message: probe.complete ? 'Linux process enumeration is available; each command still requires its own descendant proof.' : probe.reason ?? 'Complete process evidence is unavailable.', remediation: probe.complete ? 'Keep inherited process evidence intact.' : 'Use a supported Linux /proc host for execution requiring positive quiescence; handoff fails closed when process proof is unavailable.' });
    try {
        await assertRestoredExecutionAllowed(ctx);
    }
    catch {
        diagnostics.push({ code: 'RESTORE_QUARANTINED', severity: 'error', message: 'Restored execution remains quarantined.', remediation: 'Run restore-verify only after original-device fencing, authoritative recovery-point audit and online ownership confirmation; see backup-restore.md.' });
    }
    return diagnostics;
}
