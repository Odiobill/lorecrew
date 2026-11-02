import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { AppError } from '../contracts/base.js';
import type { GitClient } from '../git/client.js';
import type { RepositoryInspection, RepositorySnapshot } from './types.js';
export const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export const inputHash=(value:unknown)=>hash(JSON.stringify(value));
export async function fileHash(path:string):Promise<string|null>{try{return hash(await readFile(path));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
export async function readTreeEvidence(root:string):Promise<unknown[]>{
 const entries:unknown[]=[];async function walk(path:string,prefix:string){for(const name of (await readdir(path)).sort()){if(name==='.git')continue;const rel=prefix+name;const s=await lstat(join(path,name));if(s.isSymbolicLink())entries.push([rel,'symlink']);else if(s.isDirectory())await walk(join(path,name),rel+'/');else if(s.isFile())entries.push([rel,s.mode&0o777,await fileHash(join(path,name))]);else entries.push([rel,'special']);}}await walk(root,'');return entries;
}
export async function treeHash(root:string):Promise<string>{return inputHash(await readTreeEvidence(root));}
export async function inspectRepository(git:GitClient,path:string):Promise<RepositoryInspection>{
 const invalid:RepositoryInspection={path,kind:'invalid_git'};
 let canonical:string;try{canonical=await realpath(path);if(canonical!==resolve(path)||!(await lstat(path)).isDirectory())return invalid;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {path,kind:'empty'};throw e;}
 const run=async(args:string[])=>git.run(canonical,['--no-optional-locks',...args]);
 const root=await run(['rev-parse','--show-toplevel']);
 if(root.exitCode){const files=await readdir(canonical);if(files.includes('.git')||(await run(['rev-parse','--is-bare-repository'])).stdout.trim()==='true')return invalid;return {path:canonical,kind:files.length?'plain':'empty'};}
 if(root.stdout.trim()!==canonical)return invalid;
 const common=(await run(['rev-parse','--git-common-dir'])).stdout.trim();const commonDir=await realpath(isAbsolute(common)?common:resolve(canonical,common));
 const gitDir=(await run(['rev-parse','--absolute-git-dir'])).stdout.trim();
 const head=(await run(['rev-parse','--verify','HEAD']));const branch=(await run(['symbolic-ref','--quiet','--short','HEAD']));
 const indexPath=(await run(['rev-parse','--git-path','index'])).stdout.trim();
 const snapshot:RepositorySnapshot={commonDir,head:head.exitCode?null:head.stdout.trim(),branch:branch.exitCode?null:branch.stdout.trim(),indexHash:await fileHash(isAbsolute(indexPath)?indexPath:join(canonical,indexPath))??hash(''),worktreeHash:await treeHash(canonical),refsHash:hash((await run(['show-ref'])).stdout)};
 for(const [file,busy] of [['MERGE_HEAD','merge'],['rebase-merge','rebase'],['rebase-apply','rebase'],['index.lock','index_lock']] as const){try{await lstat(join(gitDir,file));snapshot.busy=busy;break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 if(!snapshot.branch)snapshot.busy??='detached';
 return {path:canonical,kind:'git',snapshot};
}
export function assertSnapshot(actual:RepositorySnapshot,expected?:RepositorySnapshot){if(actual.busy)throw new AppError('REPOSITORY_BUSY','Repository has an unresolved native Git operation',{state:actual.busy});if(expected&&inputHash(actual)!==inputHash(expected))throw new AppError('REPOSITORY_CHANGED','Repository changed; preserve external work and inspect again');}
