import {expect,it} from 'vitest';
it.each([['My New Skill','my-new-skill'],['Résumé Review','resume-review'],['../../escape','escape'],['💡','imported-skill']])('suggests a portable identifier for explicit confirmation: %s',async(input,want)=>{const {suggestSkillIdentifier}=await import('../../web/features/skill-identifiers.js');expect(suggestSkillIdentifier(input)).toBe(want);});
it.each([
 ['SKILL.md','./references/../references/index.md?view=1#top','references/index.md'],
 ['references/nested.md','../templates/example%20one.txt#example','templates/example one.txt'],
 ['SKILL.md','../../outside.md',undefined],
 ['SKILL.md','%252e%252e/outside',undefined],
 ['SKILL.md','#local-anchor',undefined],
])('R3 original aliases normalize once without escaping: %s -> %s',async(from,target,want)=>{const {importedRelativePath}=await import('../../web/features/skill-links.js');expect(importedRelativePath(from!,target!)).toBe(want);});
