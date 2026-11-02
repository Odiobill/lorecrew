import { assertRestoredExecutionAllowed } from '../instance/recovery.js';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { projectPathAllowed } from '../setup/folders.js';
import { inputHash,inspectRepository } from '../repositories/inspect.js';
import { withRepositoryOperation } from '../repositories/coordination.js';
import { runRepositoryGit } from '../repositories/git.js';
import { AppError } from '../contracts/base.js';
import type { ProjectAdmission } from '../projects/types.js';
import type { InstanceContext } from '../instance/open.js';
import { GitClient } from '../git/client.js';
import type { HostProcessRecord, ProjectBinding, Workspace, WorkspaceRecord } from './types.js';

const key = (value: string) => createHash('sha256').update(value).digest('hex');
export class WorkspaceManager {
  constructor(private readonly ctx: InstanceContext, private readonly git = new GitClient()) {}
  async acquire(input: {projectId: string; taskId: string; role?:'lead'}, options: {wait?:boolean} = {}): Promise<Workspace> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.taskId) || input.taskId.endsWith('.') || input.taskId.endsWith('.lock')) throw new AppError('INVALID_TASK', 'Task ID must be a safe Git branch component');
    return this.acquireWorkspace(input,options.wait!==false);
  }
  async acquireLead(projectId: string): Promise<Workspace> {
    return this.acquireWorkspace({projectId, taskId:'_lead'});
  }
  private async acquireWorkspace(input: {projectId: string; taskId: string; role?:'lead'}, wait=true): Promise<Workspace> {
    await assertRestoredExecutionAllowed(this.ctx);
    const binding = await this.ctx.store.read<ProjectBinding>('project-binding', input.projectId);
    if (!binding) throw new AppError('PROJECT_NOT_BOUND', 'Bind the project to a local directory first');
    if(!projectPathAllowed(this.ctx,binding.path))throw new AppError('INVALID_PROJECT_PATH','Project execution must be separate from the vault and private state');
    const inspection=await inspectRepository(this.git,binding.path);
    if(inspection.kind!=='git'||!inspection.snapshot?.head||!inspection.snapshot.branch)throw new AppError('MIGRATION_REQUIRED','This project requires an explicit stopped Git conversion before execution');
    const info=await lstat(binding.path);if(binding.commonDir&&binding.commonDir!==inspection.snapshot.commonDir||binding.rootIdentity&&inputHash(binding.rootIdentity)!==inputHash({dev:info.dev,ino:info.ino,uid:info.uid}))throw new AppError('BINDING_CHANGED','Original project repository placement changed');
    if(inspection.snapshot.busy)throw new AppError('REPOSITORY_BUSY','Resolve the native Git operation before execution');
    const isGit=true;
    const id = key(`${input.projectId}\0${input.taskId}`);
    let record: WorkspaceRecord;
    for (;;) {
      const claim = await this.ctx.store.transact(tx => {
        if (tx.get<ProjectAdmission>('project-admission', input.projectId)?.closed) throw new AppError('ADMISSION_CLOSED', 'Project handoff has closed local admission');
        const current = tx.get<ProjectBinding>('project-binding',input.projectId);
        if (current?.path !== binding.path) throw new AppError('BINDING_CHANGED','Project binding changed during acquisition');
        const previous = tx.get<WorkspaceRecord>('workspace',id);
        if(previous?.git===false||tx.get('repository-retired-execution',JSON.stringify(['workspace',id])))throw new AppError('MIGRATION_REQUIRED','A retained legacy workspace cannot resume; create a fresh Git task');
        if (previous?.state === 'active') return previous;
        if (previous && ['creating','failed'].includes(previous.state)) throw new AppError('WORKSPACE_UNCERTAIN','Workspace creation requires local recovery');
        const next: WorkspaceRecord = previous?.git ? {...previous, state:'creating'} : {
          ...input, id, source: binding.path, git:isGit,
          path: isGit ? join(this.ctx.stateDir,'workspaces',id) : binding.path,
          ...(isGit ? {branch: input.role==='lead' ? `lorecrew/lead/${input.projectId}/${input.taskId}` : input.taskId === '_lead' ? `lorecrew/lead/${input.projectId}` : `lorecrew/task/${input.taskId}`} : {}), state:'creating',
        };
        tx.put('project-binding', input.projectId, {...current,used:true});
        tx.put('workspace',id,next); return next;
      });
      if (claim) { record = claim; break; }
      throw new AppError('WORKSPACE_UNCERTAIN','Workspace acquisition did not produce a record');
    }
    if (record.state === 'active') return record;
    try {
      let exists = false;
      try { await lstat(record.path); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (isGit && !exists) {
        const branchExists = (await this.git.run(binding.path,['show-ref','--verify',`refs/heads/${record.branch!}`])).exitCode === 0;
        const args = ['worktree','add', ...(branchExists ? [] : ['-b',record.branch!]), record.path, branchExists ? record.branch! : 'HEAD'];
        await withRepositoryOperation(this.ctx,{kind:'project',id:input.projectId,path:binding.path},{kind:'worktree',requestId:'workspace-create:'+id,inputHash:key(JSON.stringify(args))},async({before})=>{if(before.commonDir!==inspection.snapshot!.commonDir||before.head!==inspection.snapshot!.head||before.indexHash!==inspection.snapshot!.indexHash||before.worktreeHash!==inspection.snapshot!.worktreeHash)throw new AppError('REPOSITORY_CHANGED','Project changed before worktree creation');const result=await runRepositoryGit(this.ctx,this.git,binding.path,['-c','core.hooksPath=/dev/null',...args]);if(result.exitCode)throw new AppError('WORKTREE_FAILED','Worktree creation failed; retained evidence requires inspection');});
      }
      record.state='active'; await this.ctx.store.transact(tx=>tx.put('workspace',id,record)); return record;
    } catch (error) {
      record.state='failed'; await this.ctx.store.transact(tx=>tx.put('workspace',id,record)); throw error;
    }
  }
  async release(id: string): Promise<void> {
    const record = await this.ctx.store.read<WorkspaceRecord>('workspace',id);
    if (!record || record.state === 'released') return;
    if (record.state !== 'active') throw new AppError('WORKSPACE_UNCERTAIN','Cannot release an uncertain workspace');
    // Retain worktrees, including clean ones: unpublished commits and dirty files are recovery data.
    await this.ctx.store.transact(tx=> {
      const requests=tx.get<string[]>('workspace-processes',id) ?? [];
      if (requests.some(request => {
        const process=tx.get<HostProcessRecord>('host-process',request);
        return !process || !(process.state === 'stopped' || (process.state === 'exited' && process.settled));
      })) throw new AppError('WORKSPACE_BUSY','Stop workspace processes before releasing its files');
      tx.put('workspace',id,{...record,state:'released'});

    });
  }
  async diff(id: string): Promise<string> {
    const record = await this.ctx.store.read<WorkspaceRecord>('workspace',id);
    if (!record) throw new AppError('WORKSPACE_NOT_FOUND','Unknown workspace');
    if (!record.git) throw new AppError('DIFF_UNAVAILABLE','Plain directories have no Git baseline');
    const result = await this.git.run(record.path,['diff','HEAD','--']);
    const status = await this.git.run(record.path,['status','--short','--untracked-files=all']);
    if (result.exitCode || status.exitCode) throw new AppError('DIFF_FAILED',result.stderr || status.stderr);
    return `${result.stdout}${status.stdout}`;
  }
}
