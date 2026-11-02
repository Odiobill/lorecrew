export type ProjectSelection=
 |{mode:'new';projectId:string;title:string;parentPath:string;folderName:string}
 |{mode:'existing';projectId:string;title:string;path:string;catalogProjectId?:string;acknowledgeOpaque?:boolean}
 |{mode:'catalog-clone';projectId:string;url:string;parentPath:string;folderName:string;acknowledgeOpaque?:boolean};
export interface ProjectFlowPreview {operationId:string;revision:string;selection:ProjectSelection;projectId:string;title:string;registration:'new'|'recorded';path:string;catalogRevision:string;checkoutRevision:string|null;bindingRevision:string|null;identity:{kind:'alias'|'operator_assertion'|'new';alias?:string}}
export interface ProjectFlowOperation {operationId:string;projectId:string;phase:'planned'|'repository'|'registered'|'associated'|'bound'|'completed'|'blocked';result?:{projectId:string;path:string;checkoutAvailable:boolean;executionReady:boolean};diagnostic?:{code:string;message:string}}
