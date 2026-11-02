export interface CheckoutAssociation {
 projectId:string;path:string;commonDir:string;rootIdentity:{dev:number;ino:number;uid:number};
 evidence:{kind:'alias'|'operator_assertion'|'legacy_binding';alias?:string;source?:string};operationId:string;revision:string;
}
export interface CheckoutObservation {state:'missing'|'available'|'repair';association?:CheckoutAssociation;revision:string|null;diagnostic?:{code:string;message:string}}
