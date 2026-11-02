import { assertThinkingChoice } from '../runtime/thinking.js';
import { AppError } from '../contracts/base.js';
import { resolveAgent } from '../agents/resolve.js';
import { readCompatibleSettings } from '../runtime/providers.js';
import type { InstanceContext } from '../instance/open.js';
import type { Vault } from '../vault/types.js';
import type { Runtime,SessionRecord } from '../runtime/types.js';
export type AgentUseTarget={agentId:string}|{sessionId:string};
export interface AgentUseReadiness {agentId:string;agentRevision:string;model:{provider:string;modelId:string};state:'ready'|'missing_credentials'|'missing_provider_config'|'unknown_model'|'unsupported_thinking_level';reason?:string}
/** Metadata only. Existing sessions retain their pinned agent and endpoint identity. */
export async function checkAgentUse({ctx,vault,runtime}:{ctx:InstanceContext;vault:Vault;runtime:Runtime},target:AgentUseTarget):Promise<AgentUseReadiness>{
 const record='sessionId' in target?await ctx.store.read<SessionRecord>('runtime-session',target.sessionId):undefined;
 if('sessionId' in target&&!record)throw new AppError('NOT_FOUND','Conversation not found');
 const agent=record?.agent??await resolveAgent(vault,(target as {agentId:string}).agentId);
 const identity={agentId:record?.session.agentId??agent.id,agentRevision:record?.session.agentRevision??agent.revision,model:record?.session.model??agent.model};
 if(identity.model.provider==='openai-compatible'){
  const config=await readCompatibleSettings(ctx),pinned=record?.modelDescriptor;
  if(!config||pinned&&(pinned.baseUrl!==config.baseUrl||pinned.id!==config.modelId))return {...identity,state:'missing_provider_config',reason:'Restore the configured endpoint for this agent. Existing conversations keep their pinned endpoint.'};
 }
 const model=(await runtime.listModels()).find(m=>m.provider===identity.model.provider&&m.modelId===identity.model.modelId);
 try{assertThinkingChoice(agent.model,record?.modelDescriptor??model);}catch(error){if(error instanceof AppError&&error.code==='UNSUPPORTED_THINKING_LEVEL')return {...identity,state:'unsupported_thinking_level',reason:error.message};}
 return {...identity,state:!model?'unknown_model':model.available?'ready':'missing_credentials'};
}
