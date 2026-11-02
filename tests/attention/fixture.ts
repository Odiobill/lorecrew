import {gitProject} from '../helpers/git-project.js';
import { cp,readFile,writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFleet } from '../helpers/git-fleet.js';
import { initFleet,openOwnership } from '../../src/projects/ownership.js';
import { openWorkloadOwnership } from '../../src/projects/workload-grants.js';
import { openVault } from '../../src/vault/write.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { scriptedProvider } from '../helpers/scripted-provider.js';
import { openSchedules } from '../../src/schedules/service.js';
import { openInbox } from '../../src/attention/service.js';
import { bindProject } from '../../src/projects/bindings.js';
import type { Occurrence,Schedule } from '../../src/schedules/types.js';
export async function reportFixture(){
 const fleet=await gitFleet(),{ctx,git}=fleet.a;await initFleet(ctx,git,fleet.remote);await cp('tests/fixtures/vault',ctx.vaultDir,{recursive:true});const path=join(ctx.vaultDir,'agents/ada.md');await writeFile(path,(await readFile(path,'utf8')).replace('local-openai','scripted').replace('coding-model','test-model'));
 const provider=scriptedProvider(),vault=openVault(ctx),ownership=openOwnership(ctx,git,fleet.remote),workloads=openWorkloadOwnership(ctx,git,fleet.remote),options={ctx,vault,ownership,workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models:provider.models,workloadOwnership:workloads};
 let runtime=await openRuntime(options),schedules=openSchedules({ctx,vault,runtime,ownership,workloads});
 return {...fleet,ctx,vault,ownership,workloads,...provider,get runtime(){return runtime;},get inbox(){return openInbox({ctx,vault,runtime});},async schedule(project=false){if(project){const dir=join(fleet.root,'project');await gitProject(dir);await bindProject(ctx,{projectId:'project',path:dir});await ownership.claim({id:'project',repositoryKey:'fork:fixture-project',title:'Project'},'claim');}const value:Schedule={id:'daily',revision:'r1',ownerId:ctx.instanceId,agentId:'agent-ada',...project?{projectId:'project'}:{},cron:'0 0 * * *',timeZone:'UTC',instructions:'Check and report only meaningful results.',enabled:true,overlap:'skip',missed:'coalesce',effectiveFrom:'2026-10-30T00:00:00Z'};await schedules.save(value);await schedules.tick('2026-10-30T00:00:00Z');return (await ctx.store.list<Occurrence>('schedule-occurrence'))[0]!;},async tick(utc:string){return schedules.tick(utc);},async workload(){const grant=await workloads.claim('fixture','claim');return runtime.createSession({agentId:'agent-ada',requestId:'workload',background:true,workload:{workloadId:'fixture',generation:grant.generation}});},async reopen(){await schedules.close();await runtime.close();runtime=await openRuntime(options);schedules=openSchedules({ctx,vault,runtime,ownership,workloads});},async close(){await schedules.close();await runtime.close();await fleet.cleanup();}};
}
