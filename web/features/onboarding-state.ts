import { newOperationKey } from '../api.js';
/** Browser storage contains operation keys only, never payloads, drafts or credentials. */
export class SetupOperations {
 private storageKey:string;
 constructor(instanceId:string){this.storageKey='lorecrew:setup-operations:'+instanceId;}
 read():Record<string,string>{try{const value:unknown=JSON.parse(sessionStorage.getItem(this.storageKey)??'{}');if(!value||typeof value!=='object'||Array.isArray(value))return {};return Object.fromEntries(Object.entries(value).filter(([kind,key])=>/^(agent|additionalAgent|group|session|task|message|project|save)$/.test(kind)&&typeof key==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(key))) as Record<string,string>;}catch{return {};}}
 reconcile(canonical:Record<string,string>):void{sessionStorage.setItem(this.storageKey,JSON.stringify(canonical));}
 key(kind:string,canonical:Record<string,string>):string{const key=canonical[kind]??this.read()[kind]??newOperationKey();this.reconcile({...canonical,[kind]:key});return key;}
}
