import {expect,it} from 'vitest';
import {pendingSave,reapplyDefinition} from '../../web/features/definition-drafts.js';
it('reapplies local fields while preserving concurrent names, model options and unrelated memberships',()=>{
 const base={id:'a',name:'Ada',personality:'Helpful',responsibilities:['Code'],groups:['one','two'],model:{provider:'p',modelId:'old',thinkingLevel:'high'},revision:'old'};
 const draft={...base,personality:'My text',groups:['one','three'],model:{...base.model,modelId:'new'}};
 const current={...base,name:'Remote Ada',groups:['one','two','four'],model:{...base.model,thinkingLevel:'low'},revision:'current'};
 expect(reapplyDefinition(base,draft,current)).toEqual({...current,personality:'My text',groups:['one','four','three'],model:{provider:'p',modelId:'new',thinkingLevel:'low'}});
 expect(base.groups).toEqual(['one','two']);
});
it('membership receipts preserve every unrelated field without editor normalization',()=>{
 const record={value:{id:'a',name:'Ada',personality:'Helpful',responsibilities:[' Keep spacing ',''],groups:['one'],model:{provider:'p',modelId:'m',thinkingLevel:'high'},revision:'r1'},base:{id:'a',revision:'r1'}};
 const pending=pendingSave(record);expect(pending.method).toBe('PUT');expect(pending.body).toEqual({id:'a',name:'Ada',personality:'Helpful',responsibilities:[' Keep spacing ',''],groups:['one'],model:{provider:'p',modelId:'m',thinkingLevel:'high'},expectedRevision:'r1'});
});
it('refuses to reapply edits onto a different definition identity',()=>{
 expect(()=>reapplyDefinition({id:'a',revision:'r1'},{id:'a',revision:'r1'},{id:'b',revision:'r2'})).toThrow(/identity/);
});
it('reapplies a selected provider/model pair atomically while preserving concurrent options',()=>{
 const base={id:'a',revision:'r1',model:{provider:'p',modelId:'old',thinkingLevel:'high'}};const draft={...base,model:{...base.model,modelId:'chosen'}};const current={...base,revision:'r2',model:{provider:'q',modelId:'other',thinkingLevel:'low'}};
 expect(reapplyDefinition(base,draft,current).model).toEqual({provider:'p',modelId:'chosen',thinkingLevel:'low'});
});
it('reapplies deliberate Default by removing thinking while retaining a concurrent name',()=>{const base:{id:string;revision:string;name:string;model:{provider:string;modelId:string;thinkingLevel?:string}}={id:'a',revision:'r1',name:'Ada',model:{provider:'p',modelId:'m',thinkingLevel:'high'}},draft={...base,model:{provider:'p',modelId:'m'}},current={...base,revision:'r2',name:'Current Ada',model:{...base.model,thinkingLevel:'low'}};const merged=reapplyDefinition(base,draft,current);expect(merged.name).toBe('Current Ada');expect(merged.model).not.toHaveProperty('thinkingLevel');expect(pendingSave({value:merged,base:current}).body).toMatchObject({expectedRevision:'r2',model:{provider:'p',modelId:'m'}});});
it('retains a frozen explicit Off save while later edits have Default',()=>{const base={id:'a',revision:'r',model:{provider:'p',modelId:'m'}},value={...base,model:{...base.model,thinkingLevel:'off'}},pending=pendingSave({value,base});expect(pendingSave({value:base,base,pending})).toBe(pending);expect(pending.body).toMatchObject({model:{thinkingLevel:'off'}});});
