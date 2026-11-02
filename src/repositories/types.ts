export type RepositoryKind = 'vault'|'project';
export interface RepositoryRef {kind:RepositoryKind;id:string;path:string}
export interface RemoteTarget {name:string;endpoint:string;ref:string;revision:string}
export interface RepositorySnapshot {commonDir:string;head:string|null;branch:string|null;indexHash:string;worktreeHash:string;refsHash:string;busy?:'merge'|'rebase'|'index_lock'|'detached'|'external_change'}
export interface RepositoryInspection {path:string;kind:'empty'|'git'|'plain'|'invalid_git';snapshot?:RepositorySnapshot;target?:RemoteTarget}
export interface Checkpoint {id:string;repositoryId:string;commit:string;ref:string;parent:string|null;files:Array<{path:string;hash:string|null}>}
export interface CheckpointInput {repo:RepositoryRef;expected:RepositorySnapshot;files:Array<{path:string;hash:string|null;content?:string|null}>;parent?:string|null;message:string;purpose:'initial'|'vault_batch'|'task'|'project'|'handoff'}
export interface RepositoryCreate {repo:RepositoryRef;parentPath:string;folderName:string;scaffold:Array<{path:string;content:string}>}
export interface RepositoryClone {repo:RepositoryRef;url:string;parentPath:string;folderName:string}
export interface PublicationInput {repo:RepositoryRef;target:RemoteTarget;refs:Array<{localRef:string;commit:string;remoteRef:string}>}
export interface PublicationReceipt {id:string;confirmed:boolean;refs:PublicationInput['refs']}
export interface RepositoryProblem {id:string;repositoryKind:RepositoryKind;repositoryId:string;code:string;revision:string;state:'active'|'resolved';operationId?:string}
export interface VaultIdentity {version:1;vaultId:string;domainId:string;originInstanceId:string}
export interface AuthorityBinding {version:2;vaultId:string;domainId:string;epoch:number;originInstanceId:string;mode:'local'|'shared';remote:string}
export type OperationKind='checkpoint'|'adopt'|'create'|'clone'|'fetch'|'integrate'|'publish'|'confirm_remote'|'worktree';

/** Private ordinary-vault queue lineage; it grants no remote acknowledgement. */
export interface PublicationSuccessor {inputHash:string;previous:{requestId:string;input:PublicationInput}}
