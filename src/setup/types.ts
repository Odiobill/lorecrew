export type SetupPreference='personal'|'coding';
export interface SetupState {
 version:1;revision:string;preference?:SetupPreference;agentId?:string;additionalAgentIds:string[];groupId?:string;projectId?:string;sessionId?:string;completed:boolean;pendingOperations:Record<string,string>;
}
export interface SetupSaveInput {expectedRevision:string|null;choices:Partial<Pick<SetupState,'preference'|'agentId'|'additionalAgentIds'|'groupId'|'projectId'|'sessionId'|'completed'>>;pendingOperations?:Record<string,string>}
export interface SetupVaultView {path:string;kind:'new'|'configured'|'existing_incomplete'}
export interface SetupView {vault:SetupVaultView;entry:'starter'|'workspace';state:SetupState|null;needsSetup:boolean;readiness:{model:'missing_model'|'missing_credential'|'unverified'|'verified'|'failed';verifiedAt?:string;sessionId?:string;project:'not_selected'|'ready'|'claimed_unbound'|'unavailable';fleetConfigured:boolean}}
export interface ProjectInspection {path:string;kind:'git'|'directory';suggestedRepositoryKey?:string}
export interface ProjectConnectionInput {projectId:string;title:string;repositoryKey:string;path:string}
export interface ProjectConnection {projectId:string;state:'ready'|'claimed_unbound';diagnostic?:string}

export interface HostFolderListing {path:string;parent:string|null;selectable:boolean;items:Array<{name:string;path:string}>;nextCursor?:string}
export interface ProjectPreview {path:string;kind:'git'|'directory';repositoryKey:string;title:string;token:string}
export type ProjectWorkflowInput={mode:'existing';projectId:string;title:string;path:string;repositoryKey:string;previewToken:string}|{mode:'new';projectId:string;title:string;parentPath:string;folderName:string}|{mode:'clone';projectId:string;title:string;url:string;parentPath:string;folderName:string};
export interface ProjectWorkflowResult {projectId:string;title:string;path:string;repositoryKey:string;kind:'git'|'directory';state:'ready'|'claimed_unbound';diagnostic?:string;reused?:boolean}
export interface ProjectWorkflowPending {projectId:string;title:string;path:string;mode:'existing'|'new'|'clone';phase:'planned'|'folder'|'connecting'|'connected';canAdoptExisting:boolean;diagnostic?:string}
export interface ProjectSetupOptions {ownership:import('./ownership.js').OwnershipSetupView;defaultPath:string;projects:Array<{projectId:string;title:string;path?:string;repositoryKey:string;state:'ready'|'claimed_unbound'|'unavailable'}>;pending:ProjectWorkflowPending[]}
export type VaultChoice={kind:'clone';url:string;parentPath:string;folderName:string}|{kind:'new';parentPath:string;folderName:string}|{kind:'existing';path:string};
export interface VaultPreview {token:string;path:string;kind:'new'|'existing';revision:string}
export interface StartupView {instanceId:string;phase:'vault_required'|'initializing'|'migration_required'|'ready';revision:string;defaultVaultDir:string;vaultDir?:string;diagnostic?:string}
