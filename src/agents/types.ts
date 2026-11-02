import type { Id, Revision } from '../contracts/base.js';
export interface AgentDefinition {
  id: Id; name: string; personality: string; responsibilities: string[]; groups: Id[];
  model: { provider: string; modelId: string; thinkingLevel?: string }; revision: Revision;
}
export interface GroupDefinition { id: Id; name: string; description: string; revision: Revision }
