import { AppError, type Json } from '../contracts/base.js';
import { assertUniqueIds, containsCredentials, stableId } from '../vault/indexes.js';
import type { Concept, Vault } from '../vault/types.js';
import type { AgentDefinition, GroupDefinition } from './types.js';

function object(value: Json | undefined): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_DEFINITION', 'Expected a portable definition mapping');
  return value;
}
function text(value: Json | undefined): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('INVALID_DEFINITION', 'Expected a nonempty definition string');
  return value;
}
function strings(value: Json | undefined): string[] {
  if (!Array.isArray(value)) throw new AppError('INVALID_DEFINITION', 'Expected a definition string list');
  return value.map(text);
}
function portableModel(value: Json | undefined): AgentDefinition['model'] {
  const model = object(value);
  const provider = text(model.provider); const modelId = text(model.modelId);
  // Providers are local binding names. Model IDs may include organization/model
  // namespaces, but explicit filesystem locations cannot travel with the vault.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider) || /^(?:\/|~[^/]*(?:\/|$)|[A-Za-z]:|file:)/i.test(modelId) || modelId.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(modelId) || /[\0\r\n]/.test(modelId)) throw new AppError('INVALID_DEFINITION', 'Use a logical provider binding name and model identifier; keep machine paths in local configuration');
  return {provider, modelId, ...(model.thinkingLevel === undefined ? {} : {thinkingLevel:text(model.thinkingLevel)})};
}
async function find(vault: Vault, id: string, type: string): Promise<{concept:Concept; definition:Record<string, Json>}> {
  const concepts = await vault.list(); assertUniqueIds(concepts);
  const concept = concepts.find(c => c.metadata.type === type && stableId(c) === id);
  if (!concept) throw new AppError('NOT_FOUND', `Portable ${type.toLowerCase()} definition not found`, {id});
  const definition = object(concept.metadata.lorecrew);
  if (containsCredentials(definition)) throw new AppError('CREDENTIAL_VALUE', 'Portable configuration must refer to local credential bindings');
  return {concept, definition};
}
export async function resolveAgent(vault: Vault, id: string): Promise<AgentDefinition> {
  const {concept} = await find(vault, id, 'Agent');
  return agentDefinition(concept);
}
export function agentDefinition(concept: Concept): AgentDefinition {
  const d = object(concept.metadata.lorecrew);
  return {id:text(d.id), name:text(d.name), personality:text(d.personality), responsibilities:strings(d.responsibilities), groups:strings(d.groups), model:portableModel(d.model), revision:concept.revision};
}
export async function resolveGroup(vault: Vault, id: string): Promise<GroupDefinition> {
  const {concept} = await find(vault, id, 'Group');
  return groupDefinition(concept);
}
export function groupDefinition(concept: Concept): GroupDefinition {
  const d = object(concept.metadata.lorecrew);
  return {id:text(d.id), name:text(d.name), description:text(d.description), revision:concept.revision};
}

/** Browsing a partial clone remains possible; execution still resolves and validates the requested identity. */
export async function listUsableAgents(vault:Vault):Promise<AgentDefinition[]> {
 const concepts=await vault.list();
 try{assertUniqueIds(concepts);}catch(e){if(e instanceof AppError&&e.code==='DUPLICATE_ID')return [];throw e;}
 return concepts.filter(c=>c.metadata.type==='Agent').flatMap(c=>{
  try{if(containsCredentials(c.metadata.lorecrew))return [];return [agentDefinition(c)];}
  catch(e){if(e instanceof AppError&&e.code==='INVALID_DEFINITION')return [];throw e;}
 });
}
