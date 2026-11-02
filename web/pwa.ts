import {hasUnsentDrafts,hasPendingReceipts} from './draft-guard.js';
export {hasUnsentDrafts} from './draft-guard.js';
type InstallEvent=Event&{prompt:()=>Promise<void>;userChoice:Promise<{outcome:string}>};
export type PwaState={supported:boolean;installed:boolean;installAvailable:boolean;update:'none'|'waiting'|'activating'|'ready';notice:string};
let state:PwaState={supported:!!navigator.serviceWorker,installed:window.matchMedia('(display-mode: standalone)').matches||(navigator as Navigator&{standalone?:boolean}).standalone===true,installAvailable:false,update:'none',notice:''};
const listeners=new Set<()=>void>();let registration:ServiceWorkerRegistration|undefined,installEvent:InstallEvent|undefined,requested=false,started:Promise<void>|undefined;
const emit=(patch:Partial<PwaState>)=>{state={...state,...patch};for(const listener of listeners)listener();};
export const pwaStore={subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},snapshot:()=>state};
function reload(){
 if(hasPendingReceipts()){emit({notice:'Resolve pending actions before reloading. Return to the retained draft and explicitly retry the same action to recover its receipt.'});return;}
 if(hasUnsentDrafts()&&!window.confirm('Reload to update Lorecrew? Unsent conversation text and other unsaved input may be lost. Saved definitions and tab recovery drafts remain. Cancel to keep working.'))return;
 window.location.reload();
}
export async function applyPwaUpdate(){
 emit({notice:''});
 if(registration?.waiting){requested=true;emit({update:'activating'});registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});return;}
 if(state.update==='ready')reload();
}
export async function installPwa(){
 const event=installEvent;if(!event)return;
 try{await event.prompt();await event.userChoice;}catch{emit({notice:'Use your browser’s installation menu if available.'});}
 finally{installEvent=undefined;emit({installAvailable:false});}
}
export async function checkPwaUpdate(){try{await registration?.update();}catch{emit({notice:'Cannot check for updates. Reconnect to the running host and try again.'});}}
export function registerPwa({onUpdateAvailable,onInstallAvailable}:{onUpdateAvailable?:()=>void;onInstallAvailable?:()=>void}={}):Promise<void>{
 if(started)return started;
 window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installEvent=event as InstallEvent;emit({installAvailable:true});onInstallAvailable?.();});
 window.addEventListener('appinstalled',()=>{installEvent=undefined;emit({installed:true,installAvailable:false});});
 const display=window.matchMedia('(display-mode: standalone)');display.addEventListener?.('change',event=>emit({installed:event.matches}));
 if(!navigator.serviceWorker)return started=Promise.resolve();
 started=(async()=>{
  // First installation/controller acquisition never reloads this tab.
  let controlled=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
   const updating=controlled||requested;controlled=true;
   if(!updating)return;
   emit({update:'ready'});onUpdateAvailable?.();
   const explicit=requested;requested=false;if(explicit)reload();
  });
  try{
   registration=await navigator.serviceWorker.register('/sw.js',{type:'module',updateViaCache:'none'});
   const waiting=()=>{if(registration?.waiting&&registration.active){emit({update:'waiting'});onUpdateAvailable?.();}};
   const installing=()=>{const candidate=registration?.installing;if(!candidate)return;candidate.addEventListener('statechange',()=>{if(candidate.state==='installed')waiting();if(candidate.state==='redundant')emit({notice:'The update could not be installed. Check again when connected.'});});};
   waiting();installing();registration.addEventListener('updatefound',installing);
  }catch{emit({supported:false,notice:'Service worker registration is unavailable. You can keep using Lorecrew in this browser.'});}
 })();return started;
}
