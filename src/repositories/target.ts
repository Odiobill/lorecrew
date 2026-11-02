import type {GitClient} from '../git/client.js';
import type {RepositorySnapshot,RemoteTarget} from './types.js';
import {AppError} from '../contracts/base.js';
import {inputHash,inspectRepository} from './inspect.js';
import {validateRemote} from './create.js';
/** Configuration is observed without transport, mutation, or storing credential-bearing values. */
export async function discoverRepositoryTarget(git:GitClient,path:string,snapshot?:RepositorySnapshot):Promise<RemoteTarget|undefined>{
 const current=snapshot??(await inspectRepository(git,path)).snapshot;if(!current?.branch)return;
 const read=async(args:string[])=>{const result=await git.run(path,['--no-optional-locks',...args]);if(result.exitCode===1||result.exitCode===2)return [];if(result.exitCode)throw new AppError('REMOTE_CONFIGURATION_INVALID','Inspect the repository remote configuration');return result.stdout.trim().split('\n').filter(Boolean);};
 const configuredRemote=await read(['config','--get-all','branch.'+current.branch+'.remote']),configuredRef=await read(['config','--get-all','branch.'+current.branch+'.merge']);
 if(configuredRemote.length>1||configuredRef.length>1||!!configuredRemote.length!==!!configuredRef.length)throw new AppError('REMOTE_TARGET_AMBIGUOUS','Select one explicit branch upstream');
 const remotes=await read(['remote']);let name:string,ref:string;
 if(configuredRemote.length){name=configuredRemote[0]!;ref=configuredRef[0]!;if(!remotes.includes(name))throw new AppError('REMOTE_CONFIGURATION_INVALID','The configured upstream remote is missing');}
 else if(remotes.includes('origin')){name='origin';ref='refs/heads/'+current.branch;}
 else {if(remotes.length)throw new AppError('REMOTE_TARGET_AMBIGUOUS','Configure an explicit branch upstream or origin');return;}
 if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)||!ref.startsWith('refs/heads/')||(await git.run(path,['check-ref-format',ref])).exitCode)throw new AppError('REMOTE_CONFIGURATION_INVALID','Select an ordinary remote branch');
 const fetch=await read(['remote','get-url','--all',name]),push=await read(['remote','get-url','--push','--all',name]);
 if(fetch.length!==1||push.length!==1||fetch[0]!==push[0])throw new AppError('REMOTE_TARGET_AMBIGUOUS','Fetch and push must select the same single endpoint');
 const endpoint=fetch[0]!;validateRemote(endpoint);
 return {name,endpoint,ref,revision:inputHash({branch:current.branch,name,endpoint,ref,fetch,push})};
}
