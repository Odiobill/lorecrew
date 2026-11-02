import {GitClient} from '../git/client.js';
import {inspectRepository,inputHash} from '../repositories/inspect.js';
import {projectPathAllowed} from '../setup/folders.js';
import { realpath, stat,lstat } from 'node:fs/promises';
import { stableId } from '../runtime/admission.js';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { ProjectBinding } from '../workspaces/types.js';

export async function bindProject(ctx: InstanceContext, input: {projectId: string; path: string;expectedRevision?:string|null;requestId?:string;expectedCanonicalPath?:string;expectedRepositoryCommonDir?:string;expectedRootIdentity?:{dev:number;ino:number;uid:number};beforeCommit?:(tx:import('../storage/store.js').Tx)=>void}): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.projectId)) throw new AppError('INVALID_PROJECT', 'Invalid project ID');
  const path = await realpath(input.path);
  if(input.expectedCanonicalPath!==undefined&&path!==input.expectedCanonicalPath)throw new AppError('PROJECT_FOLDER_CHANGED','The project folder target changed before binding. Review the original folder before retrying.');
  if (!(await stat(path)).isDirectory()) throw new AppError('INVALID_PROJECT_PATH', 'Project binding must be a directory');
  const inspected=await inspectRepository(new GitClient(),path);if(!projectPathAllowed(ctx,path)||inspected.kind!=='git'||!inspected.snapshot?.head||!inspected.snapshot.branch)throw new AppError('INVALID_GIT_PROJECT','Bind a separate Git repository root with a usable initial commit');
  const info=await lstat(path);if(input.expectedRepositoryCommonDir&&input.expectedRepositoryCommonDir!==inspected.snapshot.commonDir||input.expectedRootIdentity&&inputHash(input.expectedRootIdentity)!==inputHash({dev:info.dev,ino:info.ino,uid:info.uid}))throw new AppError('PROJECT_FOLDER_CHANGED','The original repository target changed before binding');
  const known=await ctx.store.list<ProjectBinding>('project-binding');const clashes:ProjectBinding[]=[];for(const other of known)if(other.projectId!==input.projectId&&(other.commonDir??(await inspectRepository(new GitClient(),other.path)).snapshot?.commonDir)===inspected.snapshot.commonDir)clashes.push(other);
  await ctx.store.transact(tx => {
    input.beforeCommit?.(tx);
    const checkoutOwner=tx.get<{projectId:string}>('project-checkout-common-dir',inspected.snapshot!.commonDir);if(checkoutOwner&&checkoutOwner.projectId!==input.projectId)throw new AppError('PROJECT_PATH_CONFLICT','This Git repository is reserved by another project checkout');
    if(input.requestId&&tx.get('project-binding-receipt',input.requestId))return;
    const repositoryOwner=tx.get<{projectId:string}>('project-repository-binding',inspected.snapshot!.commonDir);if(repositoryOwner&&repositoryOwner.projectId!==input.projectId||clashes.some(other=>tx.get<ProjectBinding>('project-binding',other.projectId)?.path===other.path))throw new AppError('PROJECT_PATH_CONFLICT','This Git repository already belongs to another project; reuse its existing identity');
    const previous = tx.get<ProjectBinding>('project-binding', input.projectId);
    if(input.expectedRevision!==undefined&&input.expectedRevision!==(previous?stableId(previous.projectId,previous.path):null))throw new AppError('REVISION_CONFLICT','Project binding changed');
    if (previous?.path !== path && previous?.used) throw new AppError('BINDING_IN_USE', 'Project workspaces already use this binding');
    if(previous?.used&&previous.commonDir&&previous.commonDir!==inspected.snapshot!.commonDir)throw new AppError('BINDING_CHANGED','The original used Git common directory changed');
    if(previous?.used&&previous.rootIdentity&&inputHash(previous.rootIdentity)!==inputHash({dev:info.dev,ino:info.ino,uid:info.uid}))throw new AppError('BINDING_CHANGED','The original used repository target changed');
    if(previous?.commonDir&&previous.commonDir!==inspected.snapshot!.commonDir&&tx.get<{projectId:string}>('project-repository-binding',previous.commonDir)?.projectId===input.projectId)tx.delete('project-repository-binding',previous.commonDir);
    tx.put('project-repository-binding',inspected.snapshot!.commonDir,{projectId:input.projectId});
    if(input.requestId)tx.put('project-binding-receipt',input.requestId,{projectId:input.projectId,path});
    tx.put('project-binding', input.projectId, { projectId: input.projectId, path,commonDir:inspected.snapshot!.commonDir,rootIdentity:{dev:info.dev,ino:info.ino,uid:info.uid}, ...(previous?.used ? {used:true} : {}) });
  });
}
