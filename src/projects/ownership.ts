import {trackedRepositoryGit} from '../repositories/git.js';
import {inputHash} from '../repositories/inspect.js';
import {validateHandoffReference} from './handoff-manifest.js';
import { assertAuthorityDomain,assertAuthorityScope,authorityScope,type AuthorityScope } from './authority-domain.js';
import type { AuthorityBinding } from '../repositories/types.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { AppError } from '../contracts/base.js';
import type { GitClient } from '../git/client.js';
import { ASSIGNMENT_REF, FETCHED_ASSIGNMENT_REF } from '../git/refs.js';
import type { InstanceContext } from '../instance/open.js';
import { canonicalRepositoryKey, registerProject } from './registry.js';
import type { ProjectBinding } from '../workspaces/types.js';
import type { Assignment, HandoffState, Ownership, ProjectAdmission, ProjectRegistration, TransferRequest } from './types.js';

export interface Control { version: 1|2;vaultId?:string;domainId?:string;epoch?:number; projects: ProjectRegistration[]; assignments: Assignment[]; workloads?: import('./workload-grants.js').WorkloadGrant[] }
interface Snapshot { head: string; control: Control }
interface Grant { authority?:AuthorityScope;remote: string; assignment: Assignment }
const revocationId = (projectId: string, generation: number) => JSON.stringify([projectId, generation]);
const sameTransfer = (a: TransferRequest, b: TransferRequest) => a.projectId === b.projectId && a.expectedGeneration === b.expectedGeneration && a.targetInstanceId === b.targetInstanceId && a.transitionId === b.transitionId;
const emptyControl = (): Control => ({ version: 1, projects: [], assignments: [] });

async function checked(git: GitClient, cwd: string, args: string[]): Promise<string> {
  const result = await git.run(cwd, ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args]);
  if (result.exitCode !== 0) throw new AppError('GIT_FAILED', 'Git operation failed; check transport and remote permissions');
  return result.stdout.trim();
}
export async function resolveRemote(ctx: InstanceContext, git: GitClient, remote: string): Promise<string> {
  if (!remote || remote.startsWith('-') || /[\r\n\0]/.test(remote) || remote.startsWith('ext::')) throw new AppError('INVALID_REMOTE', 'An assignment remote is required');
  const named = await git.run(ctx.vaultDir, ['remote', 'get-url', remote]);
  const endpoint = named.exitCode === 0 ? named.stdout.trim() : remote;
  // Both fetch and push use this one endpoint, even if origin has a separate pushurl.
  const result = !isAbsolute(endpoint) && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(endpoint) && !/^[^/]+@[^/:]+:/.test(endpoint) ? resolve(ctx.vaultDir, endpoint) : endpoint;
  if (result.startsWith('-') || result.startsWith('ext::') || /[\r\n\0]/.test(result)) throw new AppError('INVALID_REMOTE', 'Invalid assignment remote');
  const binding = await ctx.store.read<{ remote: string }>('fleet', 'assignments');
  if (binding && binding.remote !== result) throw new AppError('FLEET_MISMATCH', 'This instance is bound to a different assignment remote');
  return result;
}
function parseControl(text: string): Control {
  const invalid = () => new AppError('INVALID_ASSIGNMENTS', 'Assignment branch has invalid control records');
  let value: Control;
  try { value = JSON.parse(text) as Control; } catch { throw invalid(); }
  if (!value || ![1,2].includes(value.version) || !Array.isArray(value.projects) || !Array.isArray(value.assignments)) throw invalid();
  if(value.version===2&&(typeof value.vaultId!=='string'||typeof value.domainId!=='string'||!Number.isSafeInteger(value.epoch)||value.epoch!<1))throw invalid();
  const projects: ProjectRegistration[] = [];
  try {
    for (const project of value.projects) {
      if (projects.some(p => p.id === project.id) || canonicalRepositoryKey(project.repositoryKey) !== project.repositoryKey) throw invalid();
      registerProject(projects, project);
    }
    if(value.workloads!==undefined){
      if(!Array.isArray(value.workloads))throw invalid();
      const ids=new Set<string>();
      for(const grant of value.workloads){
        if(!grant || typeof grant.workloadId!=='string'||!grant.workloadId.trim()||ids.has(grant.workloadId)||typeof grant.ownerId!=='string'||!grant.ownerId.trim()||!Number.isSafeInteger(grant.generation)||grant.generation<1||typeof grant.transitionId!=='string'||!grant.transitionId.trim())throw invalid();
        ids.add(grant.workloadId);
      }
    }
    const seen = new Set<string>();
    for (const assignment of value.assignments) {
      if (!assignment || !projects.some(p => p.id === assignment.projectId && p.repositoryKey === assignment.repositoryKey) || seen.has(assignment.projectId) || typeof assignment.ownerId !== 'string' || !assignment.ownerId || !Number.isSafeInteger(assignment.generation) || assignment.generation < 1 || typeof assignment.transitionId !== 'string' || !assignment.transitionId) throw invalid();
      if(assignment.checkpoint!==undefined)validateHandoffReference(assignment.checkpoint);seen.add(assignment.projectId);
    }
  } catch { throw invalid(); }
  return value;
}
export async function fetchControl(git: GitClient, cwd: string, remote: string,ctx?:InstanceContext): Promise<Snapshot | undefined> {
  if(ctx)git=trackedRepositoryGit(ctx,git);
  const advertised = await git.run(cwd, ['-c','core.hooksPath=/dev/null','ls-remote', '--exit-code', '--heads', remote, ASSIGNMENT_REF]);
  if (advertised.exitCode === 2) {if(ctx&&await ctx.store.read('authority-control-head',remote))throw new AppError('AUTHORITY_RETIRED','Previously confirmed assignment control was deleted');return undefined;}
  if (advertised.exitCode !== 0) throw new AppError('ASSIGNMENT_UNCONFIRMED', 'Cannot confirm the remote assignment state');
  await checked(git, cwd, ['fetch', '--no-tags', '--no-write-fetch-head', remote, `+${ASSIGNMENT_REF}:${FETCHED_ASSIGNMENT_REF}`]);
  const head = await checked(git, cwd, ['rev-parse', FETCHED_ASSIGNMENT_REF]);
  const control = parseControl(await checked(git, cwd, ['show', `${head}:control.json`]));
  if(ctx){await validateControlDomain(ctx,control);const binding=await ctx.store.read<AuthorityBinding>('authority-binding','current');if(binding){const previous=await ctx.store.read<{head:string;domainId:string;epoch:number}>('authority-control-head',remote);if(previous&&(previous.domainId!==binding.domainId||previous.epoch!==binding.epoch||(await git.run(cwd,['merge-base','--is-ancestor',previous.head,head])).exitCode!==0))throw new AppError('AUTHORITY_RETIRED','Assignment authority no longer descends from its confirmed lineage');await ctx.store.transact(tx=>tx.put('authority-control-head',remote,{head,domainId:binding.domainId,epoch:binding.epoch}));}}
  return { head, control };
}
export async function candidate(git: GitClient, cwd: string, control: Control, parent?: string): Promise<string> {
  const path = join(cwd, 'control.json'); await writeFile(path, JSON.stringify(control) + '\n', { mode: 0o600 });
  const blob = await checked(git, cwd, ['hash-object', '-w', path]);
  await checked(git, cwd, ['read-tree', '--empty']);
  await checked(git, cwd, ['update-index', '--add', '--cacheinfo', `100644,${blob},control.json`]);
  const tree = await checked(git, cwd, ['write-tree']);
  return checked(git, cwd, ['-c', 'user.name=Lorecrew', '-c', 'user.email=lorecrew@localhost', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Update Lorecrew assignments']);
}
export async function inControlRepo<T>(ctx: InstanceContext, git: GitClient, fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(ctx.stateDir, 'staging', 'assignments-'));
  try { await checked(git, cwd, ['init', '--quiet','--template=']); return await fn(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}
async function saveBinding(ctx: InstanceContext, remote: string) {
  await ctx.store.transact(tx => {
    const previous = tx.get<{ remote: string }>('fleet', 'assignments');
    if (previous && previous.remote !== remote) throw new AppError('FLEET_MISMATCH', 'Instance already has an assignment remote');
    tx.put('fleet', 'assignments', { remote });
  });
}
async function initialControl(ctx:InstanceContext):Promise<Control>{const binding=await ctx.store.read<AuthorityBinding>('authority-binding','current');return binding?{version:2,vaultId:binding.vaultId,domainId:binding.domainId,epoch:binding.epoch,projects:[],assignments:[]}:emptyControl();}
export async function validateControlDomain(ctx:InstanceContext,control:Control){const binding=await ctx.store.read<AuthorityBinding>('authority-binding','current');if(binding&&(control.version!==2||control.vaultId!==binding.vaultId||control.domainId!==binding.domainId||control.epoch!==binding.epoch))throw new AppError('AUTHORITY_NOT_LOCAL','Confirmed assignment control belongs to another domain or epoch');}
async function grantScope(ctx:InstanceContext):Promise<{authority?:AuthorityScope}>{const binding=await ctx.store.read<AuthorityBinding>('authority-binding','current');return binding?{authority:authorityScope(await assertAuthorityDomain(ctx))}:{};}
/** Bootstrap only. Existing control branches are read and never reset. */
export async function initFleet(ctx: InstanceContext, git: GitClient, remote: string): Promise<void> {
  const endpoint = await resolveRemote(ctx, git, remote);
  await inControlRepo(ctx, git, async cwd => {
    let state = await fetchControl(git, cwd, endpoint,ctx);
    if (!state) {
      const commit = await candidate(git, cwd, await initialControl(ctx));
      // Any outcome, including a lost success acknowledgment, is resolved by a new fetch.
      await git.run(cwd, ['-c','core.hooksPath=/dev/null','push', endpoint, `${commit}:${ASSIGNMENT_REF}`]).catch(() => undefined);
      state = await fetchControl(git, cwd, endpoint,ctx);
      if (!state) throw new AppError('ASSIGNMENT_UNCONFIRMED', 'Fleet initialization could not be confirmed');
    }
    await validateControlDomain(ctx,state.control);await saveBinding(ctx, endpoint);
  });
}
export function openOwnership(ctx: InstanceContext, git: GitClient, remote: string): Ownership {
  git=trackedRepositoryGit(ctx,git);
  return {
    async claim(input, requestId) {
      if (typeof requestId !== 'string' || !requestId.trim()) throw new AppError('INVALID_REQUEST', 'A stable claim request ID is required');
      const scope=await grantScope(ctx);const project = registerProject([], input);
      const transitionId = createHash('sha256').update(JSON.stringify([ctx.instanceId, project.id, project.repositoryKey, requestId])).digest('hex');
      const endpoint = await resolveRemote(ctx, git, remote);
      return inControlRepo(ctx, git, async cwd => {
        let state = await fetchControl(git, cwd, endpoint,ctx);
        if (!state) throw new AppError('FLEET_NOT_INITIALIZED', 'Run lorecrew fleet init for the designated assignment remote first');
        await validateControlDomain(ctx,state.control);for (let attempt = 0; attempt < 16; attempt++) {
          registerProject(state.control.projects, project);
          const existing = state.control.assignments.find(a => a.projectId === project.id);
          if (existing) {
            if (existing.ownerId !== ctx.instanceId || existing.transitionId !== transitionId) throw new AppError('PROJECT_OWNED', 'Project already has an owner; initial claims cannot transfer ownership');
            await ctx.store.transact(tx => {
              const binding = tx.get<{ remote: string }>('fleet', 'assignments');
              if (binding && binding.remote !== endpoint) throw new AppError('FLEET_MISMATCH', 'Instance already has an assignment remote');
              tx.put('fleet', 'assignments', { remote: endpoint });
              const previous = tx.get<Grant>('assignment-grants', project.id);
              tx.put<Grant>('assignment-grants', project.id, { ...scope,remote: endpoint, assignment: existing });
              if (previous?.assignment.transitionId !== existing.transitionId) tx.emit('project.claimed', { ...existing });
            });
            return existing;
          }
          const assignment: Assignment = { projectId: project.id, repositoryKey: project.repositoryKey, ownerId: ctx.instanceId, generation: 1, transitionId };
          state.control.assignments.push(assignment);
          const previousHead = state.head;
          const commit = await candidate(git, cwd, state.control, previousHead);
          await git.run(cwd, ['-c','core.hooksPath=/dev/null','push', endpoint, `${commit}:${ASSIGNMENT_REF}`]).catch(() => undefined);
          const confirmed = await fetchControl(git, cwd, endpoint,ctx);
          if (!confirmed) throw new AppError('ASSIGNMENT_UNCONFIRMED', 'Assignment branch disappeared during claim');
          // A rejected push may leave another project's assignment to recompute against.
          if (confirmed.head === previousHead) throw new AppError('ASSIGNMENT_UNCONFIRMED', 'Claim was not committed remotely');
          state = confirmed;
        }
        throw new AppError('ASSIGNMENT_CONTENTION', 'Assignment branch kept changing; retry with the same request ID');
      });
    },
    async assertOwner(projectId, generation) {
      if(await ctx.store.read('authority-binding','current')){await assertAuthorityDomain(ctx);const scope=(await ctx.store.read<Grant>('assignment-grants',projectId))?.authority;await ctx.store.transact(tx=>assertAuthorityScope(tx,scope));}
      if (await ctx.store.read('assignment-revocations', revocationId(projectId, generation))) throw new AppError('OWNER_REVOKED', 'This project generation was durably revoked');
      const admission = await ctx.store.read<ProjectAdmission>('project-admission', projectId);
      if (admission?.closed && admission.generation === generation) throw new AppError('ADMISSION_CLOSED', 'Project handoff has closed local admission');
      const grant = await ctx.store.read<Grant>('assignment-grants', projectId);
      if (!grant || grant.assignment.ownerId !== ctx.instanceId || grant.assignment.generation !== generation) throw new AppError('NOT_OWNER', 'No acknowledged ownership grant for this project generation');
      const endpoint = await resolveRemote(ctx, git, remote);
      if (grant.remote !== endpoint) throw new AppError('NOT_OWNER', 'Ownership grant belongs to a different assignment remote');
    },
    async closeAdmission(request) {
      if (!Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 1 || request.expectedGeneration >= Number.MAX_SAFE_INTEGER || typeof request.targetInstanceId !== 'string' || !request.targetInstanceId.trim() || request.targetInstanceId === ctx.instanceId || typeof request.transitionId !== 'string' || !request.transitionId.trim()) throw new AppError('INVALID_TRANSFER', 'Transfer requires a valid expected generation, another target instance, and a stable transition ID');
      const endpoint = await resolveRemote(ctx, git, remote);
      return ctx.store.transact(tx => {
        const pending = tx.get<HandoffState>('project-handoff', request.projectId);
        if (pending && sameTransfer(pending, request)) return pending;
        const grant = tx.get<Grant>('assignment-grants', request.projectId);
        if (!grant || grant.assignment.ownerId !== ctx.instanceId || grant.remote !== endpoint) throw new AppError('NOT_OWNER', 'Only the confirmed owner can hand off a project');
        if (grant.assignment.generation !== request.expectedGeneration) throw new AppError('STALE_GENERATION', 'Transfer expected generation differs from the local grant');
        // A freshly accepted later grant supersedes an old transition whose receipt was lost.
        if (pending && pending.expectedGeneration >= request.expectedGeneration) throw new AppError('HANDOFF_CONFLICT', 'Resume the existing handoff with the same request and target');
        const next: HandoffState = { ...request, phase: tx.get('assignment-revocations', revocationId(request.projectId, request.expectedGeneration)) ? 'revoked' : 'closed' };
        tx.put('project-admission', request.projectId, { generation: request.expectedGeneration, closed: true });
        tx.put('project-handoff', request.projectId, next);
        tx.emit('project.handoff-closed', { ...request, phase: next.phase });
        return next;
      });
    },
    inspectHandoff(projectId) { return ctx.store.read<HandoffState>('project-handoff', projectId); },
    async proveQuiescence(request, probe) {
      const ensureClosed = (pending: HandoffState | undefined, admission: ProjectAdmission | undefined) => {
        if (!pending || !sameTransfer(pending, request) || !admission?.closed || admission.generation !== request.expectedGeneration) throw new AppError('HANDOFF_CONFLICT', 'Quiescence proof requires the matching durably closed transition');
        return pending;
      };
      const pending = ensureClosed(await ctx.store.read<HandoffState>('project-handoff', request.projectId), await ctx.store.read<ProjectAdmission>('project-admission', request.projectId));
      if (pending.quiescenceProven) return;
      const result = await probe.stopAndProve(request.projectId);
      if (!result.quiescent) throw new AppError('NOT_QUIESCENT', result.reason ?? 'Project work is not proven terminal and quiescent');
      await ctx.store.transact(tx => {
        const current = ensureClosed(tx.get<HandoffState>('project-handoff', request.projectId), tx.get<ProjectAdmission>('project-admission', request.projectId));
        if (current.quiescenceProven) return;
        tx.put('project-handoff', request.projectId, { ...current, quiescenceProven: true });
        tx.emit('project.quiescent', { ...request });
      });
    },
    async revokeLocal(projectId, generation) {
      await ctx.store.transact(tx => {
        const id = revocationId(projectId, generation);
        if (tx.get('assignment-revocations', id)){const pending=tx.get<HandoffState>('project-handoff',projectId);if(pending?.expectedGeneration===generation)tx.delete('project-checkpoint-permit',pending.transitionId);return;}
        const grant = tx.get<Grant>('assignment-grants', projectId);
        if (!grant || grant.assignment.ownerId !== ctx.instanceId || grant.assignment.generation !== generation) throw new AppError('NOT_OWNER', 'Only a locally confirmed generation can be revoked');
        tx.put('project-admission', projectId, { generation, closed: true });
        tx.put('assignment-revocations', id, { assignment: grant.assignment });
        const pending = tx.get<HandoffState>('project-handoff', projectId);
        if (pending?.expectedGeneration === generation){tx.delete('project-checkpoint-permit',pending.transitionId);tx.put('project-handoff', projectId, { ...pending, phase: 'revoked' });}
        tx.emit('project.revoked', { projectId, generation });
      });
    },
    async publishTransfer(request) {
      const endpoint = await resolveRemote(ctx, git, remote);
      const revoked = await ctx.store.read<{ assignment: Assignment }>('assignment-revocations', revocationId(request.projectId, request.expectedGeneration));
      if (!revoked) throw new AppError('OWNER_NOT_REVOKED', 'Durably revoke the old generation before publishing a transfer');
      const pending = await ctx.store.read<HandoffState>('project-handoff', request.projectId);
      if (!pending || !sameTransfer(pending, request) || pending.phase === 'closed') throw new AppError('HANDOFF_CONFLICT', 'Transfer does not match the durable revoked handoff');
      if (!pending.quiescenceProven) throw new AppError('NOT_QUIESCENT', 'Transfer lacks a durable quiescence proof for this transition');
      if(await ctx.store.read('authority-binding','current')){const proof=await ctx.store.read<{reference:unknown;projectPublication:unknown;vaultPublication:unknown}>('checkpoint-handoff-transfer-proof',request.transitionId),project=await ctx.store.read<{inputHash:string;last?:{confirmed:boolean}}>('repository-verification','handoff-project-availability:'+request.transitionId),vault=await ctx.store.read<{inputHash:string;last?:{confirmed:boolean}}>('repository-verification','handoff-manifest-availability:'+request.transitionId);if(!pending.checkpoint||inputHash(pending.checkpoint)!==inputHash(request.checkpoint??null)||inputHash(proof?.reference??null)!==inputHash(pending.checkpoint)||!project?.last?.confirmed||!vault?.last?.confirmed||project.inputHash!==inputHash(proof?.projectPublication)||vault.inputHash!==inputHash(proof?.vaultPublication))throw new AppError('CHECKPOINT_REQUIRED','Publish and freshly verify exact project/context checkpoints before ownership transfer');}
      return inControlRepo(ctx, git, async cwd => {
        let state = await fetchControl(git, cwd, endpoint,ctx);
        if (!state) throw new AppError('ASSIGNMENT_UNCONFIRMED', 'Assignment branch is unavailable');
        for (let attempt = 0; attempt < 16; attempt++) {
          const current = state.control.assignments.find(a => a.projectId === request.projectId);
          if (current?.generation === request.expectedGeneration + 1 && current.ownerId === request.targetInstanceId && current.transitionId === request.transitionId && current.repositoryKey === revoked.assignment.repositoryKey) {
            if(inputHash(current.checkpoint??null)!==inputHash(pending.checkpoint??null))throw new AppError('TRANSFER_CONFLICT','Confirmed transfer references another immutable checkpoint');await ctx.store.transact(tx => {
              const saved = tx.get<HandoffState>('project-handoff', request.projectId);
              if (!saved || !sameTransfer(saved, request)) throw new AppError('HANDOFF_CONFLICT', 'Local handoff changed during publication');
              tx.put('project-handoff', request.projectId, { ...saved, phase: 'published', assignment: current });
              if (saved.phase !== 'published') tx.emit('project.transferred', { ...current });
            });
            return current;
          }
          if (!current || current.ownerId !== ctx.instanceId || current.generation !== request.expectedGeneration || current.repositoryKey !== revoked.assignment.repositoryKey || current.transitionId !== revoked.assignment.transitionId) throw new AppError('TRANSFER_CONFLICT', 'Remote assignment no longer matches the revoked local generation');
          const next: Assignment = { ...current, ownerId: request.targetInstanceId, generation: request.expectedGeneration + 1, transitionId: request.transitionId,...pending.checkpoint?{checkpoint:pending.checkpoint}:{} };
          state.control.assignments = state.control.assignments.map(a => a.projectId === request.projectId ? next : a);
          const previousHead = state.head;
          const commit = await candidate(git, cwd, state.control, previousHead);
          await git.run(cwd, ['-c','core.hooksPath=/dev/null','push', endpoint, `${commit}:${ASSIGNMENT_REF}`]).catch(() => undefined);
          const confirmed = await fetchControl(git, cwd, endpoint,ctx);
          if (!confirmed || confirmed.head === previousHead) throw new AppError('ASSIGNMENT_UNCONFIRMED', 'Transfer publication is unconfirmed; the former owner remains revoked');
          state = confirmed;
        }
        throw new AppError('ASSIGNMENT_CONTENTION', 'Assignment branch kept changing; retry the same handoff request');
      });
    },
    async acceptGrant(projectId) {
      const scope=await grantScope(ctx);
      if (!await ctx.store.read<ProjectBinding>('project-binding', projectId)) throw new AppError('PROJECT_NOT_BOUND', 'Bind the project to a local workspace directory before accepting authority');
      const endpoint = await resolveRemote(ctx, git, remote);
      return inControlRepo(ctx, git, async cwd => {
        const state = await fetchControl(git, cwd, endpoint,ctx);if(state)await validateControlDomain(ctx,state.control);
        const assignment = state?.control.assignments.find(a => a.projectId === projectId);
        if (!assignment || assignment.ownerId !== ctx.instanceId) throw new AppError('NOT_OWNER', 'Remote assignment does not grant this instance authority');
        if(assignment.checkpoint){const preflight=await ctx.store.read<{reference:unknown;manifest:{targetInstanceId:string;sourceGeneration:number;domainId:string;epoch:number};binding:ProjectBinding}>('checkpoint-handoff-preflight',assignment.checkpoint.manifestId),binding=await ctx.store.read<ProjectBinding>('project-binding',projectId);if(!preflight||inputHash(preflight.reference)!==inputHash(assignment.checkpoint)||preflight.manifest.targetInstanceId!==ctx.instanceId||preflight.manifest.sourceGeneration+1!==assignment.generation||preflight.manifest.domainId!==scope.authority?.domainId||preflight.manifest.epoch!==scope.authority?.epoch||preflight.binding.path!==binding?.path||preflight.binding.commonDir!==binding?.commonDir||inputHash(preflight.binding.rootIdentity??null)!==inputHash(binding?.rootIdentity??null))throw new AppError('HANDOFF_PREFLIGHT_REQUIRED','This exact target must preflight immutable context and its real local project before accepting');}
        await ctx.store.transact(tx => {
          if (!tx.get<ProjectBinding>('project-binding', projectId)) throw new AppError('PROJECT_NOT_BOUND', 'Project binding changed during acceptance');
          if (tx.get('assignment-revocations', revocationId(projectId, assignment.generation))) throw new AppError('OWNER_REVOKED', 'A revoked generation cannot be accepted again');
          const admission = tx.get<ProjectAdmission>('project-admission', projectId);
          if (admission?.closed && admission.generation >= assignment.generation) throw new AppError('ADMISSION_CLOSED', 'Pending handoff cannot be reopened by accepting its old grant');
          const binding = tx.get<{ remote: string }>('fleet', 'assignments');
          if (binding && binding.remote !== endpoint) throw new AppError('FLEET_MISMATCH', 'Instance already has an assignment remote');
          const previous = tx.get<Grant>('assignment-grants', projectId);
          tx.put('fleet', 'assignments', { remote: endpoint });
          tx.put('assignment-grants', projectId, { ...scope,remote: endpoint, assignment });
          if (admission && admission.generation < assignment.generation) {
            tx.put('project-admission', projectId, { generation: assignment.generation, closed: false });
            tx.delete('process-fence', projectId);
          }
          if (previous?.assignment.transitionId !== assignment.transitionId) tx.emit('project.grant-accepted', { ...assignment });
        });
        return assignment;
      });
    },
  };
}
