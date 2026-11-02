import {thinkingLabel} from './thinking-label.js';
import {useState} from 'react';
import type {Snapshot} from '../api.js';
import type {AgentDefinition,GroupDefinition} from '../../src/agents/types.js';
export type AgentDraft=Omit<AgentDefinition,'revision'>&{revision?:string};
export const modelKey=(model:{provider:string;modelId:string})=>model.provider+'\0'+model.modelId;
export {thinkingLabel} from './thinking-label.js';
export function validThinkingChoice(model:AgentDraft['model'],models:Snapshot['models']){const descriptor=models.find(m=>modelKey(m)===modelKey(model));return !!descriptor&&(model.thinkingLevel===undefined||descriptor.supportedThinkingLevels.includes(model.thinkingLevel as typeof descriptor.supportedThinkingLevels[number]));}
export function ThinkingFields({model,models,disabled,onChange}:{model:AgentDraft['model'];models:Snapshot['models'];disabled:boolean;onChange:(model:AgentDraft['model'])=>void}){
 const levels=models.find(m=>modelKey(m)===modelKey(model))?.supportedThinkingLevels??[],unsupported=model.thinkingLevel!==undefined&&!levels.includes(model.thinkingLevel as typeof levels[number]);
 return <><label>Thinking level<select aria-label="Thinking level" disabled={disabled} aria-invalid={unsupported||undefined} value={model.thinkingLevel??''} onChange={e=>{const {thinkingLevel:_old,...choice}=model;onChange(e.target.value?{...choice,thinkingLevel:e.target.value}:choice);}}><option value="">Default</option>{unsupported&&<option value={model.thinkingLevel}>Unavailable: {model.thinkingLevel}</option>}{levels.map(level=><option key={level} value={level}>{thinkingLabel({kind:'explicit',level})}</option>)}</select></label><p className="muted">Default leaves the thinking preference unset, using the runtime’s existing default. Agent edits apply to new conversations; explicit reload updates an existing conversation at an idle boundary.</p><p className="muted">Higher thinking levels can increase response time and token use. Supported levels vary by model.</p>{levels.length===1&&levels[0]==='off'&&<p className="muted">This model does not offer adjustable thinking. Default leaves the runtime preference unset; Off explicitly selects no thinking.</p>}{unsupported&&<p className="error" role="status">This thinking level is unavailable for the selected model. Choose a supported level or Default before saving.</p>}</>;
}

export function AgentModelFields({model,models,disabled,onChange,label='Model'}:{model:AgentDraft['model'];models:Snapshot['models'];disabled:boolean;onChange:(model:AgentDraft['model'])=>void;label?:string}){
 const [showUnavailable,setShowUnavailable]=useState(false);const exists=models.some(m=>modelKey(m)===modelKey(model));
 return <><label>{label}<select aria-label={label} disabled={disabled} value={modelKey(model)} onChange={e=>{const [provider,modelId]=e.target.value.split('\0');onChange({...model,provider:provider!,modelId:modelId!});}}>
 {!exists&&<option value={modelKey(model)}>{model.modelId?model.modelId+' · not in model catalog':'Select a model'}</option>}
 {models.filter(m=>m.available||showUnavailable||modelKey(m)===modelKey(model)).map(m=><option key={modelKey(m)} value={modelKey(m)}>{m.name} · {m.provider}{m.available?'':' · credential unavailable'}</option>)}</select></label>
 <label className="checkbox-row"><input type="checkbox" disabled={disabled} checked={showUnavailable} onChange={e=>setShowUnavailable(e.target.checked)}/>Show models without available credentials</label>
 <ThinkingFields model={model} models={models} disabled={disabled} onChange={onChange}/>{!models.length&&<p className="muted">No models are configured. Configure a provider on this instance, then select a model before saving.</p>}</>;
}
export function AgentForm({draft,models,groups,referencedGroups=[],disabled,fieldsLocked=false,saving=false,onChange,onSave,onCancel}:{draft:AgentDraft;models:Snapshot['models'];groups:GroupDefinition[];referencedGroups?:string[];disabled:boolean;fieldsLocked?:boolean;saving?:boolean;onChange:(value:AgentDraft)=>void;onSave:()=>void;onCancel:()=>void}){
 const valid=!!draft.name.trim()&&!!draft.personality.trim()&&validThinkingChoice(draft.model,models);
 return <form onSubmit={e=>{e.preventDefault();if(!disabled&&(fieldsLocked||valid))onSave();}}><fieldset className="definition-fields" disabled={disabled||fieldsLocked}>
 <label>Agent name<input value={draft.name} onChange={e=>onChange({...draft,name:e.target.value})}/></label>
 <label>Personality<textarea aria-label="Personality" rows={5} value={draft.personality} onChange={e=>onChange({...draft,personality:e.target.value})}/></label>
 <label>Responsibilities (one per line)<textarea rows={3} value={draft.responsibilities.join('\n')} onChange={e=>onChange({...draft,responsibilities:e.target.value.split('\n')})}/></label>
 <AgentModelFields model={draft.model} models={models} disabled={disabled} onChange={model=>onChange({...draft,model})}/>
 <fieldset className="definition-fields membership-options"><legend>Groups</legend>
 {!groups.length&&<p className="muted">Create a group to share context between agents.</p>}
 {[...groups,...[...new Set([...draft.groups,...referencedGroups])].filter(id=>!groups.some(g=>g.id===id)).map(id=>({id,name:id+' (not in this vault)'}))].map(g=><label className="checkbox-row" key={g.id}><input type="checkbox" checked={draft.groups.includes(g.id)} onChange={e=>onChange({...draft,groups:e.target.checked?[...draft.groups,g.id]:draft.groups.filter(id=>id!==g.id)})}/>{g.name}</label>)}
 </fieldset></fieldset><div className="definition-actions"><button disabled={disabled||saving||!fieldsLocked&&!valid} type="submit">{saving?'Saving…':draft.revision?'Save agent':'Create agent'}</button><button type="button" className="secondary" disabled={disabled||saving||fieldsLocked} onClick={onCancel}>{draft.revision?'Discard draft':'Cancel new agent'}</button></div></form>;
}
