import type { Api,Model,ModelThinkingLevel } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import type { AgentDefinition } from '../agents/types.js';
import type { ModelDescriptor } from './types.js';
import { AppError } from '../contracts/base.js';
export type ThinkingPreference={kind:'default'}|{kind:'explicit';level:string};
export function thinkingPreference(choice:AgentDefinition['model']):ThinkingPreference {
 return choice.thinkingLevel===undefined?{kind:'default'}:{kind:'explicit',level:choice.thinkingLevel};
}
export function supportedThinkingLevels(model:Model<Api>):ModelThinkingLevel[]{return getSupportedThinkingLevels(model);}
export function assertThinkingChoice(choice:AgentDefinition['model'],model:Model<Api>|ModelDescriptor|undefined):void {
 if(!model)throw new AppError('UNKNOWN_MODEL','Select a configured provider and model');
 if(choice.thinkingLevel===undefined)return;
 const levels='supportedThinkingLevels' in model?model.supportedThinkingLevels:supportedThinkingLevels(model);
 if(!levels.includes(choice.thinkingLevel as ModelThinkingLevel))throw new AppError('UNSUPPORTED_THINKING_LEVEL','Select a thinking level supported by this model, or Default.');
}
