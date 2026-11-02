import { createHash } from 'node:crypto';
import { basename, posix } from 'node:path';
import { parseDocument, type Document } from 'yaml';
import { AppError, encodeJson, type Json } from '../contracts/base.js';
import type { Concept, ProposalContent } from './types.js';

export const revisionOf = (text: string): string => createHash('sha256').update(text).digest('hex');
export function validatePath(path: string): void {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || !path.endsWith('.md') || path.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) throw new AppError('UNSAFE_PATH', 'Use a relative markdown path within the vault');
}
function invalid(path: string): AppError { return new AppError('INVALID_CONCEPT', 'Invalid OKF document', {path}); }
function frontmatter(path: string, text: string): { document: Document; body: string; newline: string } | undefined {
  const match = /^(---\r?\n)([\s\S]*?)^---(?:\r?\n|$)/m.exec(text);
  if (!match || match.index !== 0) {
    if (/^---(?:\r?\n|$)/.test(text)) throw invalid(path);
    return undefined;
  }
  const document = parseDocument(match[2]!, { uniqueKeys: true });
  if (document.errors.length) throw invalid(path);
  return { document, body: text.slice(match[0].length), newline: match[1]!.includes('\r') ? '\r\n' : '\n' };
}
export function parseConcept(path: string, text: string): Concept {
  validatePath(path);
  const parsed = frontmatter(path, text);
  let metadata: Record<string, Json> = {};
  if (parsed) {
    try {
      const value: unknown = parsed.document.toJS({maxAliasCount: 100});
      encodeJson(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(path);
      metadata = value as Record<string, Json>;
    } catch { throw invalid(path); }
  }
  const name = basename(path);
  if (path === 'index.md') {
    if (metadata.okf_version !== '0.2') throw invalid(path);
  } else if (name === 'index.md' || name === 'log.md') {
    if (parsed) throw invalid(path);
    if (name === 'log.md') {
      for (const heading of text.matchAll(/^##[ \t]+(.+?)\r?$/gm)) {
        const date = heading[1]!;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw invalid(path);
      }
    }
  } else if (!parsed || typeof metadata.type !== 'string' || !metadata.type.trim()) throw invalid(path);
  return { path: posix.normalize(path), revision: revisionOf(text), metadata, body: parsed?.body ?? text };
}
export function patchContent(path: string, original: string | undefined, content: ProposalContent): string {
  if (typeof content === 'string') { parseConcept(path, content); return content; }
  encodeJson(content);
  if (!original) throw new AppError('INVALID_PROPOSAL', 'Metadata patches require an existing concept');
  parseConcept(path, original);
  const parsed = frontmatter(path, original);
  if (!parsed) throw new AppError('INVALID_PROPOSAL', 'Reserved plain markdown files do not have metadata');
  for (const [key, value] of Object.entries(content.metadata)) parsed.document.set(key, value);
  const yaml = parsed.document.toString().replace(/\r?\n/g, parsed.newline);
  const result = `---${parsed.newline}${yaml}---${parsed.newline}${content.body ?? parsed.body}`;
  parseConcept(path, result);
  return result;
}
/** Authorship and verification are independent; never synthesize evidence. */
export function verificationEntries(concept: Concept): Json[] {
  const verified = concept.metadata.verified;
  if (!verified) return [];
  return Array.isArray(verified) ? verified : [verified];
}
