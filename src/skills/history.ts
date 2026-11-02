import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Vault } from '../vault/types.js';
import { revisionOf } from '../vault/parse.js';
import { skillHistory } from './catalog.js';
import { historyPath, note, hashSnapshot, type SkillSnapshot } from './proposals.js';
export async function archiveSkill(ctx:InstanceContext,vault:Vault,qualifiedId:string,snapshot:SkillSnapshot,actor:string):Promise<void>{
 const path=historyPath(qualifiedId,snapshot.concept.revision);const content=note('SkillHistory',qualifiedId,{qualifiedId,snapshot,snapshotHash:hashSnapshot(snapshot)},'Retained exact skill bytes and resources; not a catalog definition.');
 try{const current=await vault.read(path);const retained=skillHistory([current],qualifiedId,snapshot.concept.revision);if(retained?.raw!==snapshot.raw||hashSnapshot(retained)!==hashSnapshot(snapshot))throw new AppError('REVISION_CONFLICT','Skill history changed');return;}catch(error){if(!(error instanceof AppError)||error.code!=='NOT_FOUND')throw error;}
 await vault.propose({id:`skill-history:${revisionOf(path)}`,path,expectedRevision:null,actor,content});
}
