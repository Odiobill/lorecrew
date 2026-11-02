export interface Preview3Report {checks:Array<{name:string;state:'pass'|'fail';details:string}>;artifacts:{root:string;report:string};candidate?:{packageDir:string;treeSha256:string;artifactSha256:string}}
export function runInstalledPreview3(options:{packageDir:string;stateDir:string;artifactSha256:string}):Promise<Preview3Report>;
