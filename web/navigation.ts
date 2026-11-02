export type Page = 'projects'|'results'|'inbox'|'routines'|'agents'|'groups'|'setup'|'conversations'|'tasks'|'knowledge'|'skills'|'learning'|'schedules'|'settings'|'remote-status'|'not-found';
export interface Route {page:Page;entity?:string;skillContext?:string;draft?:string}
const pages:readonly string[]=['projects','results','inbox','routines','agents','groups','setup','conversations','tasks','knowledge','skills','learning','schedules','settings','remote-status'];
export function parseRoute(hash:string):Route {
  if(!hash||hash==='#')return {page:'conversations'};
  const [pathname,search]=hash.replace(/^#/,'').split('?');
  let [page,...parts]=pathname!.split('/');
  if(page==='sync')return {page:'settings'};
  if(page==='schedules')page='routines';
  if(page==='learning'||page==='knowledge'&&parts.join('/')==='learning')return {page:'learning'};
  if(!page||!pages.includes(page))return {page:'not-found'};
  if(parts.length&&!['projects','results','agents','groups','conversations','tasks','knowledge','skills'].includes(page))return {page:'not-found'};
  try {
    const entity=decodeURIComponent(parts.join('/'));
    const skillContext=page==='skills'&&search?new URLSearchParams(search).get('context'):null;
    return {page:page as Page,...(entity?{entity}:{}),...(page==='conversations'&&search&&new URLSearchParams(search).get('draft')?{draft:new URLSearchParams(search).get('draft')!}:{}),...skillContext?{skillContext}:{}};
  } catch {return {page:'not-found'};}
}
export function routeHash(route:Route):string {
  return (route.page==='learning'?'#knowledge/learning':'#'+(route.page==='schedules'?'routines':route.page))+(route.entity?'/'+encodeURIComponent(route.entity):'')+(route.page==='skills'&&route.skillContext?'?context='+encodeURIComponent(route.skillContext):route.page==='conversations'&&route.draft?'?draft='+encodeURIComponent(route.draft):'');
}
export const pageNames:Record<Page,string>={projects:'Projects',results:'Result',inbox:'Inbox',routines:'Routines',agents:'Agents',groups:'Groups',setup:'Setup',conversations:'Conversations',tasks:'Tasks',knowledge:'Knowledge',skills:'Skills',learning:'Learning',schedules:'Routines',settings:'Settings','remote-status':'Remote status','not-found':'Page not found'};
