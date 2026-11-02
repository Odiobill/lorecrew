export interface SmokeReport {
  platform:string; arch:string;
  runtime:{node:string;git:string|null;dependencies:Record<string,string>};
  checks:Array<{name:string;state:'pass'|'fail'|'unavailable';details:string}>;
  rss:{idleBytes:number|null;activeBytes:number|null;workload:string};
  artifacts:{report:string;[key:string]:string};
}
export function runPlatformSmoke(options:{stateDir:string;vaultRemote?:string;modelA?:string;modelB?:string;mode?:'platform'|'providers';packageDir?:string;providerStateDir?:string;timeoutMs?:number}):Promise<SmokeReport>;

export function loadInstalledModule(packageDir:string,specifier:string):Promise<Record<string,unknown>>;

export interface GitHistoryOptions {
  sync:{status():Promise<{lastFetchAt?:string;error?:string;exportError?:string}>};
  git:{run(cwd:string,args:string[]):Promise<{stdout:string;stderr:string;exitCode:number}>};
  vaultDir:string;
  expected:{instanceId:string;sessionId:string;entryId:string;text:string};
  parseConcept:(path:string,content:string)=>{metadata:Record<string,unknown>;body:string};
}
export function verifyGitHistory(options:GitHistoryOptions):Promise<Record<string,unknown>>;
