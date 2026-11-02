export interface ProjectRegistration { id: string; repositoryKey: string; title: string }
export interface Assignment { checkpoint?:import('./handoff-manifest.js').HandoffReference;projectId: string; repositoryKey: string; ownerId: string; generation: number; transitionId: string }
export interface TransferRequest { checkpoint?:import('./handoff-manifest.js').HandoffReference;projectId: string; expectedGeneration: number; targetInstanceId: string; transitionId: string }
export interface HandoffState extends TransferRequest { phase: 'closed' | 'revoked' | 'published'; quiescenceProven?: true; assignment?: Assignment }
/** Durable local fence. Only acceptance of a later, confirmed generation can reopen it. */
export interface ProjectAdmission { generation: number; closed: boolean }
export interface QuiescenceProbe { stopAndProve(projectId: string): Promise<{quiescent: boolean; reason?: string}> }
export interface Ownership {
  claim(project: ProjectRegistration, requestId: string): Promise<Assignment>;
  assertOwner(projectId: string, generation: number): Promise<void>;
  closeAdmission(request: TransferRequest): Promise<HandoffState>;
  inspectHandoff(projectId: string): Promise<HandoffState | undefined>;
  proveQuiescence(request: TransferRequest, probe: QuiescenceProbe): Promise<void>;
  revokeLocal(projectId: string, generation: number): Promise<void>;
  publishTransfer(request: TransferRequest): Promise<Assignment>;
  acceptGrant(projectId: string): Promise<Assignment>;
}
