import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { Provider } from '@earendil-works/pi-ai';
/** Provider-owned, deterministic login fixture. Never contacts an account. */
export function scriptedLoginProviders():Provider[]{return builtinProviders().map(provider=>provider.id==='openai'?{...provider,auth:{...provider.auth,oauth:{name:'Scripted browser sign-in',loginLabel:'Sign in with browser',login:async interaction=>{
 interaction.notify({type:'auth_url',url:'https://example.test/authorize?state=scripted',instructions:'Open the provider page, then return here.'});
 interaction.notify({type:'device_code',userCode:'FAKE-CODE',verificationUri:'https://example.test/device'});
 const callback=await interaction.prompt({type:'manual_code',message:'Paste callback URL'});if(callback==='fail')throw Error('scripted-private-error');
 await interaction.prompt({type:'select',message:'Choose account',options:[{id:'personal',label:'Personal'},{id:'work',label:'Work'}]});
 await interaction.prompt({type:'secret',message:'Confirm sign-in code'});
 return {type:'oauth',access:'scripted-private-access',refresh:'scripted-private-refresh',expires:Date.now()+3600_000};
 },refresh:async()=>{throw Error('Unexpected provider refresh');},toAuth:async credential=>({apiKey:credential.access})}}}:provider);}
