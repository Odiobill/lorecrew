import type { SimpleStreamOptions,Model,Api } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from './scripted-provider.js';
export function thinkingCapture(){
 const requests:Array<{reasoning:SimpleStreamOptions['reasoning'];model:Model<Api>}>=[];
 return {requests,response:(_context:unknown,options:SimpleStreamOptions|undefined,_state:unknown,model:Model<Api>)=>{requests.push({reasoning:options?.reasoning,model:JSON.parse(JSON.stringify(model))});return fauxAssistantMessage('Settled thinking request');}};
}
