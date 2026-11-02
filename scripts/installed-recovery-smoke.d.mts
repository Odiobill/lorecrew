export interface RecoveryReport {checks:Array<{name:string;state:'pass'|'fail'|'unavailable';details:string}>;artifacts:{report:string;[key:string]:string}}
export function runInstalledRecovery(options:{packageDir:string;stateDir:string;artifactSha256:string;timeoutMs?:number}):Promise<RecoveryReport>;
export function installedIdentity(packageDir:string):Promise<{packageDir:string;treeSha256:string;packages:Array<{path:string;name:string;version:string}>}>;
export function scriptedSkillSource(version?:number):{get(path:string,signal:AbortSignal):Promise<unknown>};

export function runRecoveryChild(input:{stateDir:string;home:string;timeoutMs?:number;restoreStateDir?:string},label:string,args:string[],options?:{cwd?:string;allowed?:number[]}):Promise<{code:number}>;

export function withOfflineAuthority(remote:string,verify:()=>Promise<void>):Promise<void>;
