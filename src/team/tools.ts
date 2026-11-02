import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import type { SessionRecord } from '../runtime/types.js';
import type { Team } from './types.js';
import { AppError } from '../contracts/base.js';
export function teamTools(team:()=>Team,session:(conversationId:number)=>SessionRecord) {
  const identity=(conversationId:number)=>{const record=session(conversationId);if(!record.input.teamTaskId)throw new AppError('TASK_REQUIRED','This session has no team assignment');return {taskId:record.input.teamTaskId,sessionId:record.session.id};};
  const result=(value:unknown)=>({output:[{type:'text' as const,text:JSON.stringify(value??{ok:true})}]});
  return defineExtension({name:'lorecrew-team',tools:[
    defineTool({name:'team_delegate',description:'Delegate a local task to a named agent or a helper:NAME temporary identity. Provide objective, deliverable, context references and dependencies.',replay:'safe',
      parameters:Type.Object({agentId:Type.String(),objective:Type.String(),deliverable:Type.String(),contextPaths:Type.Array(Type.String()),dependsOn:Type.Array(Type.String())}),
      async execute(args,api){const who=identity(api.conversationId);return result(await team().delegate({...args,requestId:`tool:${who.sessionId}:${api.taskId}`,parentTaskId:who.taskId}));}}),
    defineTool({name:'team_message',description:'Send a durable message directly to another local session.',replay:'safe',parameters:Type.Object({toSessionId:Type.String(),text:Type.String()}),
      async execute(args,api){const who=identity(api.conversationId);await team().message({...args,id:`tool:${who.sessionId}:${api.taskId}`,fromSessionId:who.sessionId,taskId:who.taskId});return result(undefined);}}),
    defineTool({name:'team_report',description:'Return a final result and evidence to the assigning agent after all delegated children have settled.',replay:'safe',parameters:Type.Object({state:Type.Union([Type.Literal('completed'),Type.Literal('failed'),Type.Literal('cancelled')]),outcome:Type.Any()}),
      async execute(args,api){const who=identity(api.conversationId);await team().report({...args,requestId:`tool:${who.sessionId}:${api.taskId}`,taskId:who.taskId});return result(undefined);}}),
    defineTool({name:'team_ask_user',description:'Request a human decision with a recommendation and exactly the tasks blocked by it. Independent work continues.',replay:'safe',parameters:Type.Object({question:Type.String(),recommendation:Type.String(),blockedTaskIds:Type.Array(Type.String())}),
      async execute(args,api){const who=identity(api.conversationId);return result(await team().ask({...args,id:`tool:${who.sessionId}:${api.taskId}`,taskId:who.taskId}));}}),
  ]});
}
