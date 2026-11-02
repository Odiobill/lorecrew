import { expect,it } from 'vitest';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { scriptedProvider } from '../helpers/scripted-provider.js';
import { listModels } from '../../src/runtime/providers.js';
it('capabilities_match_pinned_sdk',async()=>{
 const {models,faux}=scriptedProvider();const descriptor=models.getModels()[0]!;
 const variants=[{...descriptor,reasoning:false},{...descriptor,reasoning:true},{...descriptor,reasoning:true,thinkingLevelMap:{low:null,xhigh:'high',max:'high'}}];
 for(const model of variants){Object.assign(faux.models[0],model);const [publicModel]=await listModels(models);expect(publicModel).toHaveProperty('supportedThinkingLevels',getSupportedThinkingLevels(model));}
});
it('preserves_default_and_validates_explicit_without_clamping',async()=>{
 const {assertThinkingChoice,thinkingPreference}=await import('../../src/runtime/thinking.js');const {faux}=scriptedProvider();const model={...faux.models[0],reasoning:false};const choice={provider:model.provider,modelId:model.id};
 expect(thinkingPreference(choice)).toEqual({kind:'default'});expect(thinkingPreference({...choice,thinkingLevel:'off'})).toEqual({kind:'explicit',level:'off'});expect(()=>assertThinkingChoice(choice,model)).not.toThrow();expect(()=>assertThinkingChoice({...choice,thinkingLevel:'high'},model)).toThrowError(expect.objectContaining({code:'UNSUPPORTED_THINKING_LEVEL'}));expect(()=>assertThinkingChoice(choice,undefined)).toThrowError(expect.objectContaining({code:'UNKNOWN_MODEL'}));
});
