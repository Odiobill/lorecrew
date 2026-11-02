import type {AgentDefinition} from '../../src/agents/types.js';
export function withGroupMembership(agent:AgentDefinition,groupId:string,member:boolean):AgentDefinition{
 if(agent.groups.includes(groupId)===member)return agent;
 return {...agent,groups:member?[...agent.groups,groupId]:agent.groups.filter(id=>id!==groupId)};
}
/** Qualified scope is identity; a substring in a description is never a scope match. */
export function groupSkillTarget(qualifiedId:string):string|undefined{
 const slash=qualifiedId.indexOf('/');if(slash<0||!qualifiedId.startsWith('group:'))return;
 return qualifiedId.slice('group:'.length,slash)||undefined;
}
