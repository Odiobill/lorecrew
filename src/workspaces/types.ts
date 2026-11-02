export interface Workspace { id: string; projectId: string; taskId: string; path: string; branch?: string }
export interface WorkspaceRecord extends Workspace {
   source: string; git: boolean;
  state: 'creating' | 'active' | 'released' | 'failed';
}
export interface ProjectBinding { projectId: string; path: string; commonDir?:string;rootIdentity?:{dev:number;ino:number;uid:number};used?: boolean }
export interface ProcessIdentity { pid: number; parentPid: number; groupId: number; start: string; state: string; token?: string; markerReadable?: boolean }
/** A probe must report incomplete identity enumeration. Unreadable markers retain an opaque identity. */
export interface ProcessProbe { snapshot(): Promise<{ processes: ProcessIdentity[]; complete: boolean; reason?: string }> }
export interface HostProcessRecord {
  id: string; contextId:string; sessionId:string; projectId?: string; workloadId?:string; workspaceId?: string; command: string; token: string;
  state: 'launching' | 'running' | 'exited' | 'uncertain' | 'stopped';
  opaqueBefore?: string[]; baselineComplete?: boolean; settled?: boolean; pid?: number; start?: string; artifactPath?: string; reason?: string;
}

export interface WorkloadWorkspace {id:string;workloadId:string;generation:number;taskId:string;path:string;state:'active'|'released'}
