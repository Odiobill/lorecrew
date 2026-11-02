import type { Concept } from '../vault/types.js';
export type SkillScope='global'|'group'|'agent';
/** Portable v1 contract for Task16: lifecycle changes edit vault metadata via proposals. */
export interface SkillMetadata {schemaVersion:1;name:string;scope:SkillScope;scopeId?:string;status:'active'|'candidate'|'deprecated';resources:string[]}
export interface SkillSummary {qualifiedId:string;description:string;scope:SkillScope;revision:string;evidenceState?:'tentative'|'validated'}
export interface SkillPage {items:SkillSummary[];nextCursor?:string}
export interface SkillDefinition {qualifiedId:string;description:string;skill:SkillMetadata;concept:Concept}
export interface LoadedSkill {revision:string;body:string;resources:Concept[]}
export interface LoadSkillRequest {sessionId:string;taskId:string;qualifiedId:string;revision?:string;trial?:boolean;requestId?:string}
export interface SkillPin {sessionId:string;taskId:string;qualifiedId:string;path:string;status:SkillMetadata['status'];loaded:LoadedSkill;importSnapshot?:import('./proposals.js').SkillSnapshot}
