import { expect, it } from 'vitest';
import { parseRoute, routeHash } from '../../web/navigation.js';

it('opens conversations by default and preserves encoded entity deep links', () => {
  expect(parseRoute('')).toEqual({page:'conversations'});
  expect(parseRoute('#tasks/task%20one')).toEqual({page:'tasks',entity:'task one'});
  expect(parseRoute('#conversations/chat%2Fone')).toEqual({page:'conversations',entity:'chat/one'});
  expect(parseRoute('#knowledge/lessons%2Fcompat%20notes.md')).toEqual({page:'knowledge',entity:'lessons/compat notes.md'});
  expect(routeHash({page:'knowledge',entity:'lessons/compat notes.md'})).toBe('#knowledge/lessons%2Fcompat%20notes.md');
});

it('retains all existing operational destinations', () => {
  for(const page of ['settings','remote-status','skills'] as const) {
    expect(parseRoute('#'+page)).toEqual({page});
    expect(routeHash({page})).toBe('#'+page);
  }
});

it('makes unknown and malformed links recoverable without opening a different entity', () => {
  expect(parseRoute('#unknown')).toEqual({page:'not-found'});
  expect(parseRoute('#tasks/%E0%A4%A')).toEqual({page:'not-found'});
  expect(parseRoute('#settings/secret')).toEqual({page:'not-found'});
});
it('skill routes serialize canonical paths and explicit filter/context state',()=>{const route={page:'skills' as const,entity:'skills/guide.md',skillContext:'{"scope":"group","sessionId":"chosen"}'};const hash='#skills/skills%2Fguide.md?context=%7B%22scope%22%3A%22group%22%2C%22sessionId%22%3A%22chosen%22%7D';expect(routeHash(route)).toBe(hash);expect(parseRoute(hash)).toEqual(route);});

it('canonicalizes daily-use aliases while retaining old deep links',()=>{expect(parseRoute('#schedules')).toEqual({page:'routines'});expect(parseRoute('#routines')).toEqual({page:'routines'});expect(parseRoute('#inbox')).toEqual({page:'inbox'});expect(parseRoute('#learning')).toEqual({page:'learning'});expect(parseRoute('#knowledge/learning')).toEqual({page:'learning'});expect(routeHash({page:'learning'})).toBe('#knowledge/learning');});

it('result details preserve the owning outcome identity',()=>{expect(parseRoute('#results/run%3Aocc')).toEqual({page:'results',entity:'run:occ'});});

it('routes historical sync links to vault settings and preserves explicit-send repository drafts',()=>{expect(parseRoute('#sync')).toEqual({page:'settings'});const route={page:'conversations' as const,draft:'Inspect this repository'};expect(parseRoute(routeHash(route))).toEqual(route);});
it('project_deep_links_preserve_encoded_identity',()=>{expect(parseRoute('#projects')).toEqual({page:'projects'});expect(parseRoute('#projects/project%20one')).toEqual({page:'projects',entity:'project one'});expect(routeHash({page:'projects',entity:'project/one'})).toBe('#projects/project%2Fone');expect(parseRoute('#projects/%E0%A4%A')).toEqual({page:'not-found'});});
