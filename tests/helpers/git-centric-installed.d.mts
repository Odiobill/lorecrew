export interface GitCentricReport {checks:Array<{name:string;state:'pass'|'fail';details:string}>;artifacts:{root:string;report:string};candidate?:{packageDir:string;treeSha256:string;artifactSha256:string}}
export const GIT_CENTRIC_PHASES:readonly string[];
export function runInstalledGitCentric(options:{packageDir:string;stateDir:string;artifactSha256:string;artifactPath:string;legacyPackageDir?:string;legacyArtifactSha256?:string;timeoutMs?:number}):Promise<GitCentricReport>;
