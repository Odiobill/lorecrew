import type { RedactionPolicy } from './types.js';
/** Best effort only. Hold the entire export when a detector matches; reasons never
 * contain source text, matched values, or credential-bearing paths. */
export function redact(text:string,policy:RedactionPolicy):{text:string;held:boolean;reasons:string[]} {
  let held=false;
  for(const literal of policy.literals??[])if(literal && text.includes(literal)){held=true;text=text.split(literal).join('[REDACTED]');}
  const patterns=[
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    /\bBearer\s+[^\s"'<>]+/gi,
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
    /\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|authorization)\s*["']?\s*[:=]\s*["']?[^\s"',;}]{8,}/gi,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  ];
  for(const pattern of patterns)text=text.replace(pattern,()=>{held=true;return '[REDACTED]';});
  return {text,held,reasons:held?['possible_secret']:[]};
}
