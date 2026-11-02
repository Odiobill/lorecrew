import {isDeepStrictEqual} from 'node:util';
import {assertAuthorityDomain,assertAuthorityScope,type AuthorityScope} from '../projects/authority-domain.js';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from './open.js';
import { GitClient } from '../git/client.js';
import { fetchControl, inControlRepo, resolveRemote } from '../projects/ownership.js';
import type { Assignment } from '../projects/types.js';
import type { WorkloadGrant } from '../projects/workload-grants.js';
export async function assertRestoredExecutionAllowed(ctx: Pick<InstanceContext, 'stateDir'>): Promise<void> {
    for (const file of ['restore-incomplete.json', 'restore-quarantine.json']) {
        try {
            await lstat(join(ctx.stateDir, file));
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                continue;
            throw error;
        }
        throw new AppError('RESTORE_QUARANTINED', 'Restored execution is quarantined; run restore-verify with ownership confirmation and an authoritative recovery point acknowledgment');
    }
}
/** The caller holds the instance lock. Verification never alters ownership fences or task receipts. */
export async function verifyRestoredInstance(ctx: InstanceContext, input: {
    authoritativeRecoveryPoint: boolean;
}): Promise<void> {
    try {
        await lstat(join(ctx.stateDir, 'restore-incomplete.json'));
        throw new AppError('RESTORE_INCOMPLETE', 'Repeat the interrupted restore into a fresh empty destination');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
    }
    const marker = join(ctx.stateDir, 'restore-quarantine.json');
    let restored: {
        instanceId: string;
        sourceStateDir: string;repositoryMigrationId?:string;
    };
    try {
        restored = JSON.parse(await readFile(marker, 'utf8'));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new AppError('NOT_RESTORED', 'Instance has no restore quarantine');
        throw error;
    }
    if(restored.repositoryMigrationId)throw new AppError('MIGRATION_REQUIRED','Resume the exact stopped repository migration; restore verification cannot clear its quarantine');
    if (input.authoritativeRecoveryPoint !== true)
        throw new AppError('RECOVERY_ACK_REQUIRED', 'Acknowledge no post-snapshot work occurred or independently audit all post-snapshot effects and missing receipts before resuming');
    if (restored.instanceId !== ctx.instanceId || typeof restored.sourceStateDir !== 'string')
        throw new AppError('INVALID_BACKUP', 'Restore identity differs from the instance');
    if(await ctx.store.read('authority-binding','current'))await assertAuthorityDomain(ctx);
    const projects = await ctx.store.list<{
        remote: string;authority?:AuthorityScope;
        assignment: Assignment;
    }>('assignment-grants');
    const workloads = await ctx.store.list<{
        remote: string;authority?:AuthorityScope;
        assignment: WorkloadGrant;
    }>('workload-grants');
    const all = [...projects, ...workloads], fleet = await ctx.store.read<{
        remote: string;
    }>('fleet', 'assignments');
    if(await ctx.store.read('authority-binding','current'))await ctx.store.transact(tx=>{for(const grant of all)assertAuthorityScope(tx,grant.authority);});
    if (all.length && !fleet)
        throw new AppError('ASSIGNMENT_UNCONFIRMED', 'Restored grants lack their assignment remote');
    if (fleet) {
        const git = new GitClient(), endpoint = await resolveRemote(ctx, git, fleet.remote);
        await inControlRepo(ctx, git, async (cwd) => {
            const snapshot = await fetchControl(git, cwd, endpoint,ctx);
            if (!snapshot)
                throw new AppError('ASSIGNMENT_UNCONFIRMED', 'Assignment control branch is absent');
            for (const cached of all) {
                const grant = cached.assignment;
                const remote = 'projectId' in grant ? snapshot.control.assignments.find(g => g.projectId === grant.projectId) : snapshot.control.workloads?.find(g => g.workloadId === grant.workloadId);
                if (cached.remote !== endpoint || !remote || !isDeepStrictEqual(grant,remote))
                    throw new AppError('RESTORE_OWNERSHIP_MISMATCH', 'Snapshot grant differs from shared authority; retain this history and use a fresh instance with explicit transfers for future work');
            }
        });
    }
    for (const kind of ['workspace', 'workload-workspace', 'project-binding'])
        for (const workspace of await ctx.store.list<{
            path: string;
            state?: string;
        }>(kind)) {
            if (workspace.state && workspace.state !== 'active')
                continue;
            const rel = relative(restored.sourceStateDir, workspace.path), inside = rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
            if (inside && restored.sourceStateDir !== ctx.stateDir)
                throw new AppError('RESTORE_PATH_MISMATCH', 'Active workspace paths require the original absolute state directory');
            try {
                if (!(await lstat(workspace.path)).isDirectory())
                    throw new Error();
            }
            catch {
                throw new AppError('WORKSPACE_MISSING', 'Restore original project/workspace paths before verification');
            }
        }
    // Ordinary cwd is host data, never relocated as managed state. Require the exact saved path.
    for(const execution of await ctx.store.list<import('../workspaces/context.js').ExecutionContext>('execution-context')) {
        if(execution.state!=='active')continue;
        const {assertExecutionCwd}=await import('../workspaces/context.js');
        await assertExecutionCwd(execution.cwd);
        if(execution.owner.kind!=='session') {
            const rel=relative(restored.sourceStateDir,execution.cwd);
            if(restored.sourceStateDir!==ctx.stateDir&&(rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep))))throw new AppError('RESTORE_PATH_MISMATCH','Active execution paths require the original absolute state directory');
        }
    }
    await ctx.store.transact(tx => { tx.put('restore-verification', ctx.instanceId, { at: new Date(ctx.clock.now()).toISOString(), authoritativeRecoveryPoint: true, grants: all.length }); tx.emit('instance.restore-verified', { instanceId: ctx.instanceId }); });
    await unlink(marker);
    const dir = await open(ctx.stateDir, 'r');
    try {
        await dir.sync();
    }
    finally {
        await dir.close();
    }
}
