import { parseDocument } from 'yaml';
import { AppError } from '../contracts/base.js';
import { containsCredentials } from '../vault/indexes.js';
import { validatePath } from '../vault/parse.js';
export interface LocalImportPreview {name:string;description:string;body:string;resourceReferences:string[];warnings:string[]}
export function previewLocalSkill(markdown:string,options:{nativeBundle?:boolean}={}):LocalImportPreview {
 if(Buffer.byteLength(markdown)>1_048_576)throw new AppError('IMPORT_LIMIT','Single-file import exceeds 1 MiB');
 const match=/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(markdown);if(!match||match.index!==0)throw new AppError('INVALID_IMPORT','SKILL.md requires YAML frontmatter with name and description');
 const doc=parseDocument(match[1]!,{uniqueKeys:true});if(doc.errors.length)throw new AppError('INVALID_IMPORT','Malformed YAML frontmatter');
 let m:Record<string,unknown>;try{m=doc.toJS({maxAliasCount:100});}catch{throw new AppError('INVALID_IMPORT','Invalid frontmatter');}
 if(!m||typeof m!=='object'||Array.isArray(m)||typeof m.name!=='string'||typeof m.description!=='string'||!m.description.trim())throw new AppError('INVALID_IMPORT','Supply a name and description');
 if(containsCredentials(m))throw new AppError('CREDENTIAL_VALUE','Remove credential values and machine paths before importing');
 const warnings=['Imported content is unvalidated. Execution compatibility unverified.'];if(Object.keys(m).some(k=>!['name','description','license','compatibility','metadata','allowed-tools'].includes(k)))warnings.push('Foreign type, activation, verification and other metadata are retained only in original source text; they confer no authority.');
 const resources=!options.nativeBundle&&Array.isArray(m.resources)?m.resources:[];if(options.nativeBundle&&m.resources!==undefined)warnings.push('Upstream resource declarations are inert original-path aliases; the complete frozen inventory supplies supporting text.');for(const path of resources){if(typeof path!=='string')throw new AppError('INVALID_IMPORT','Resource references must be Markdown paths');validatePath(path);}
 return {name:m.name,description:m.description,body:markdown.slice(match[0].length),resourceReferences:resources as string[],warnings};
}
