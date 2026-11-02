import type { Id, Json, Revision } from '../contracts/base.js';

export interface Concept { path: string; revision: Revision; metadata: Record<string, Json>; body: string }
/** A string replaces the document; a metadata patch retains unspecified fields and body bytes. */
export type ProposalContent = string | { metadata: Record<string, Json>; body?: string };
export interface VaultProposal { id: Id; path: string; expectedRevision: Revision | null; content: ProposalContent; actor: string; preconditions?: Array<{path:string;revision:string|null}>; snapshotPrecondition?:{types:string[];revision:string} }
export interface VaultDiagnostic { code: string; severity: 'info' | 'warning' | 'error'; message: string; remediation: string }
export interface Vault {
  read(path: string): Promise<Concept>;
  propose(proposal: VaultProposal, admit?: (tx: import('../storage/store.js').Tx) => void): Promise<{revision: Revision}>;
  list(): Promise<Concept[]>;
  diagnose(): Promise<VaultDiagnostic[]>;
}
