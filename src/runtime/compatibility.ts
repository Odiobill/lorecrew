import {inputHash} from '../repositories/inspect.js';
import { AppError } from '../contracts/base.js';
import type { StateContext } from '../instance/state.js';
/** Do not reinterpret old restricted sessions as full-tool sessions. History is deliberately excluded. */
export async function assertCurrentExecutionState(state:StateContext):Promise<void> {
 if(state.store.repositoryFormat()!==2||(await state.store.list<{state:string}>('repository-migration')).some(m=>m.state!=='completed'))throw new AppError('MIGRATION_REQUIRED','Stop Lorecrew and run repository migrate --inspect; preserve legacy data and execution evidence');
 for(const kind of ['workspace','plain-handoff','plain-execution-slot','plain-session'])for(const id of await state.store.keys(kind)){const value=await state.store.read<{git?:boolean}>(kind,id);if(kind==='workspace'&&value?.git!==false)continue;const retired=await state.store.read<{migrationId:string;hash:string}>('repository-retired-execution',JSON.stringify([kind,id]));if(retired?.hash===inputHash(value)&&(await state.store.read<{state:string}>('repository-migration',retired.migrationId))?.state==='completed')continue;throw new AppError('MIGRATION_REQUIRED','Legacy plain execution requires stopped conversion and fresh tasks; original records are retained');}
 for(const kind of ['runtime-session','team-task','workspace','team-request']) {
  for(const record of await state.store.list<unknown>(kind)) {
   if(!record||typeof record!=='object')continue;
   const value=record as Record<string,unknown>;const input=value.input;
   if(Object.hasOwn(value,'mode')||(input&&typeof input==='object'&&Object.hasOwn(input,'mode')))
    throw new AppError('PREVIEW_STATE_INCOMPATIBLE','This preview requires fresh local state: obsolete capability-mode execution records cannot be resumed. Stop Lorecrew and use the documented clean-trial sequence; retain historical vault evidence.',{kind});
  }
 }
}
