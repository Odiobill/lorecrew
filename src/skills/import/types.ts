import type { LocalImportPreview } from '../import.js';
export interface GitHubSourceInput {url:string;ref?:string;path?:string}
export interface SourceSnapshot {sourceId:string;repositoryUrl:string;requestedRef:string;commit:string;skillPaths:string[];expiresAt:string;requestedSlug?:string}
export interface ImportFileEntry {originalPath:string;kind:'text'|'script'|'binary'|'symlink'|'submodule'|'lfs'|'unsupported';mode:string;size:number;sha256:string;resourcePath?:string;resourceRevision?:string}
export interface ImportIssue {code:string;path?:string;blocking:boolean;message:string}
export interface NativeImportPreview {previewId:string;manifestHash:string;contentHash:string;source:{repositoryUrl:string;requestedRef:string;commit:string;skillRoot:string;originalUrl:string};files:ImportFileEntry[];issues:ImportIssue[];expiresAt:string}
export interface TreeEntry {path:string;mode:string;type:string;sha:string;size?:number}
export interface SourceRecord extends SourceSnapshot {principalId:string;originalUrl:string;entries:TreeEntry[];owner:string;repo:string}
export interface PreviewRecord extends LocalImportPreview {sourceId?:string;principalId:string;nativeImport:NativeImportPreview;texts:Record<string,string>}
export interface ResourceMapping {fromPath:string;originalTarget:string;vaultPath:string;expectedRevision:string}
export interface ImportProvenance {schemaVersion:1;source:NativeImportPreview['source'];manifestHash:string;contentHash:string;originalSkillResourcePath:string;files:ImportFileEntry[];resourceMappings:ResourceMapping[];dependencies?:Array<{path:string;revision:string}>}
