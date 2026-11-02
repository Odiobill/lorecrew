import {expect,it} from 'vitest';
import {groupSkillTarget,withGroupMembership} from '../../web/features/group-membership.js';
import type {AgentDefinition} from '../../src/agents/types.js';
it('membership_preserves_unrelated_groups_and_fields',()=>{
 const agent:AgentDefinition={id:'ada',name:'Ada',personality:'Precise',responsibilities:['Review'],groups:['one','two'],model:{provider:'p',modelId:'m',thinkingLevel:'high'},revision:'r1'};
 expect(withGroupMembership(agent,'three',true)).toEqual({...agent,groups:['one','two','three']});
 expect(withGroupMembership(agent,'one',false)).toEqual({...agent,groups:['two']});
 expect(withGroupMembership(agent,'two',true)).toBe(agent);expect(withGroupMembership(agent,'missing',false)).toBe(agent);expect(agent.groups).toEqual(['one','two']);
});
it('group scope matches parsed target identity rather than a prefix or arbitrary substring',()=>{
 expect(groupSkillTarget('group:team/guide')).toBe('team');expect(groupSkillTarget('group:team-other/guide')).toBe('team-other');expect(groupSkillTarget('agent:team/guide')).toBeUndefined();expect(groupSkillTarget('global/group:team')).toBeUndefined();expect(groupSkillTarget('group:team')).toBeUndefined();
});
