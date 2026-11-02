import {putRepositoryProblem} from '../repositories/problems.js';
import type {InstanceContext} from '../instance/open.js';
import type {RepositoryProblem,RepositoryRef} from '../repositories/types.js';
import {repositoryKey} from '../repositories/remote.js';
import {inputHash} from '../repositories/inspect.js';
export function openSyncProblems(ctx:InstanceContext,repo:RepositoryRef){
 return {
  async hold(code:string,revision:string,operationId?:string){const id=inputHash({repository:repositoryKey(repo),code}),next:RepositoryProblem={id,repositoryKind:repo.kind,repositoryId:repo.id,code,revision,state:'active',...operationId?{operationId}:{}},old=await ctx.store.read<RepositoryProblem>('repository-problem',id);if(inputHash(old??null)!==inputHash(next))await ctx.store.transact(tx=>putRepositoryProblem(tx,next));},
  async resolve(code:string){for(const old of await ctx.store.list<RepositoryProblem>('repository-problem'))if(old.repositoryKind===repo.kind&&old.repositoryId===repo.id&&old.code===code&&old.state==='active')await ctx.store.transact(tx=>putRepositoryProblem(tx,{...old,state:'resolved'}));}
 };
}
