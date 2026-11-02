export interface ThinkingProjectsReport {checks:Array<{name:string;state:'pass'|'fail';details:string}>;artifacts:{root:string;report:string};candidate?:{packageDir:string;treeSha256:string;artifactSha256:string}}
export const THINKING_PROJECTS_PHASES:readonly string[];
export function assertThinkingProjectsPhases(checks:ThinkingProjectsReport['checks']):void;
export function runInstalledThinkingProjects(options:{packageDir:string;stateDir:string;artifactPath:string;artifactSha256:string;timeoutMs?:number}):Promise<ThinkingProjectsReport>;
