import type { ApiKeyCredential } from '@earendil-works/pi-ai';
import { AppError } from '../contracts/base.js';

/** Commands remain untouched in Pi's file, but cannot bypass process supervision. */
export function hasCredentialCommand(credential:ApiKeyCredential|undefined):boolean {
  return [credential?.key,...Object.values(credential?.env??{})]
    .some(value=>value!==undefined&&(value.startsWith('!')||(process.env[value]?.startsWith('!')??false)));
}
function resolveValue(value:string,signal:AbortSignal):string {
  signal.throwIfAborted();
  const resolved=process.env[value]??value;
  if(value.startsWith('!')||resolved.startsWith('!')) {
    throw new AppError('CREDENTIAL_COMMAND_UNSUPPORTED','Credential commands are unsupported; use a literal value or environment reference');
  }
  return resolved;
}
export async function resolveKeyConfig(credential:ApiKeyCredential|undefined,signal:AbortSignal):Promise<ApiKeyCredential|undefined> {
  if(!credential)return undefined;
  const key=credential.key===undefined?undefined:resolveValue(credential.key,signal);
  const env=credential.env?Object.fromEntries(Object.entries(credential.env).map(([name,value])=>[name,resolveValue(value,signal)])):undefined;
  return {...credential,...key===undefined?{}:{key},...env?{env}:{}};
}
