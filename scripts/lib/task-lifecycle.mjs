import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { canonicalPath, git, identity, inventory, json, save as saveAtomic, safeId, repositoryLock } from './lifecycle-git.mjs';
import { bindProject } from './project-identity.mjs';
import { withFileLock } from './notifications.mjs';
import { processExists } from './process.mjs';
import { loadPlannerContract } from './contracts.mjs';
import { matchesPathPattern } from './utils.mjs';
import { carryVerifiedBaseline } from './environment-baseline.mjs';

const stamp = () => new Date().toISOString();
const save=(file,value)=>saveAtomic(file,value,{durable:true});
const alive = job => job.process_pid && !job.process_exited_at && processExists(job.process_pid);
export const taskFile = (project, task) => path.join(project, '.agent-orchestrator', 'tasks', `${safeId(task)}.json`);
export async function taskRecord(project, task) { return json(taskFile(project, task)); }
export async function taskLock(project, task, action) { return withFileLock(taskFile(project, task) + '.lock', action); }
export async function branchRef(project, name) {
  if (typeof name !== 'string' || name.startsWith('-') || !name || name.startsWith('refs/')) throw new Error('BRANCH_NAME_REQUIRED: use a short branch name');
  await git(project, ['check-ref-format', '--branch', name]);
  return `refs/heads/${name}`;
}
export async function branchRecommendation(project, taskId = null) {
  const repo = await identity(project);
  const config = await json(path.join(repo.root, '.agent-orchestrator/config.json'), {});
  const current = (await git(project, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })) || null;
  const remote = await git(project, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFailure: true });
  const recorded = taskId ? await taskRecord(project, taskId) : null;
  const target = recorded?.branch?.target_branch || config.git_lifecycle?.target_branch || remote?.replace(/^refs\/remotes\/origin\//, '') || current;
  const head = await git(project, ['rev-parse', '--verify', target ? `refs/heads/${target}` : 'HEAD'], { allowFailure: true });
  const proposed = `codex/${(taskId || 'task-id').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 90)}`;
  return { task_id: taskId, current_branch: current, target_branch: target, target_commit: head,
    task_branch: recorded?.branch?.task_branch || proposed, mode: recorded?.branch ? 'reuse' : 'create',
    requires_selection: !recorded?.branch, reason: recorded?.branch ? 'Continue the recorded delivery branch' : 'Independent delivery gets a task branch; inspect history before approving reuse',
    choices: ['use_recommended', 'edit_recommended', 'audit_only'], commit_policy: config.git_lifecycle?.commit_policy || 'ask',
    merge_policy: config.git_lifecycle?.merge_policy || 'ask', cleanup_policy: 'safe_auto',
    capacity: { workers: config.git_lifecycle?.max_worker_worktrees ?? 3, total: config.git_lifecycle?.max_worktrees ?? 5 } };
}

export class TaskLifecycle {
  constructor(orchestrator) { this.orchestrator = orchestrator; this.store = orchestrator.store; }
  async record(project, task) { return taskRecord(project, task); }
  async ensure(project, task, plan, { legacy = true, locked = false } = {}) {
    if (!locked) return taskLock(project, task, () => this.ensure(project, task, plan, {legacy,locked:true}));
    const present = await this.record(project, task);
    const binding = await bindProject(project,{checkFresh:false});
    if (present) {
      if(present.project_id!==binding.project_id || await canonicalPath(present.coordinator_common)!==await canonicalPath(binding.coordinator_common)
        || present.task_id!==task || present.contract_digest!==plan?.contract_digest
        || (plan?.coordinator_common && await canonicalPath(plan.coordinator_common)!==await canonicalPath(binding.coordinator_common))) throw new Error('TASK_PROJECT_IDENTITY_MISMATCH: copied task authority cannot transfer execution to another repository');
      return present;
    }
    if (!plan?.session_id || (plan.project_id && (plan.project_id !== binding.project_id || await canonicalPath(plan.coordinator_common) !== await canonicalPath(binding.coordinator_common)))) throw new Error('TASK_PLAN_IDENTITY_REQUIRED');
    const oldJobs = (await this.store.listJobs()).filter(j => j.project_dir === path.resolve(project) && j.task_id === task && j.contract_digest===plan.contract_digest);
    const value = { version: 1, task_id: task, project_id: binding.project_id, coordinator_common: await canonicalPath(binding.coordinator_common),
      owner_session_id: plan.session_id, epoch: 1, owner_identity: { provider: plan.provider, model: plan.model, invocation: plan.invocation, session_id: plan.session_id },
      contract_id: plan.contract_id, contract_digest: plan.contract_digest, branch: null, legacy, legacy_origin:legacy,
      delivery_status: 'uncommitted', integration_status: 'not_prepared', workspace_status: 'not_allocated',
      authorized_job_ids: oldJobs.map(j => j.id), history: [{ kind: legacy ? 'legacy_adopted' : 'created', session_id: plan.session_id, epoch: 1, at: stamp() }], created_at: stamp() };
    await save(taskFile(project, task), value); return value;
  }
  async assertOwner(project, task, actor, epoch) {
    const value = await this.record(project, task);
    if (!value) return null;
    if (!actor || value.owner_session_id !== actor || (epoch != null && value.epoch !== epoch)) throw new Error(`TASK_OWNER_FENCED: expected current owner epoch=${value.epoch}; inspect task state or claim an authorized handoff`);
    if (value.successor_task_id) throw new Error('TASK_BRANCH_SUPERSEDED: delivery branch belongs to the recorded successor task');
    return value;
  }
  async mutate(project, task, actor, epoch, action) {
    return taskLock(project, task, async () => action(await this.assertOwner(project, task, actor, epoch)));
  }
  async assertNoFinalization(project,task) {
    if((await this.store.listJobs()).some(j=>j.project_dir===path.resolve(project) && j.task_id===task && j.type==='task_finalize' && ['queued','running'].includes(j.status))) throw new Error('TASK_FINALIZATION_BUSY: settle the persisted finalizer before starting another mutation');
  }
  async assertJob(job) {
    const record = await this.record(job.project_dir, job.task_id);
    if (!record) return;
    if(record.successor_task_id) throw new Error('TASK_BRANCH_SUPERSEDED');
    const fence = job.coordinator_fence;
    if (record.authorized_job_ids.includes(job.id)) return;
    if (!fence || fence.session_id !== record.owner_session_id || fence.epoch !== record.epoch) throw new Error('TASK_JOB_FENCED: provider job was not authorized by the current coordinator');
    if (!record.legacy && !record.branch) throw new Error('TASK_BRANCH_SELECTION_REQUIRED: approve the audit branch recommendation before Work');
  }
  async noteWorkspace(job) {
    return taskLock(job.project_dir,job.task_id,async()=>{
      const task=await this.record(job.project_dir,job.task_id);if(!task) return;
      task.workspace_status='retained';task.updated_at=stamp();await save(taskFile(job.project_dir,job.task_id),task);
    });
  }
  async environmentOwners(project, action) {
    if(action.kind==='cleanup') {
      const job=await this.store.getJob(action.job_id),task=job?.task_id?await this.record(project,job.task_id):null;
      return task?[task]:[];
    }
    if(!['commit','wip'].includes(action.kind)) return [];
    const result=[];
    for(const file of await fs.readdir(path.join(project,'.agent-orchestrator/tasks')).catch(()=>[])) {
      if(!file.endsWith('.json')) continue;
      const task=await json(path.join(project,'.agent-orchestrator/tasks',file));
      if(!task || (task.delivery_status==='merged' && task.workspace_status==='cleaned')) continue;
      const contract=await loadPlannerContract(project,safeId(task.task_id));
      if((action.paths || []).some(file=>contract.executor_subtasks.some(s=>s.writable_paths.some(p=>p==='.' || p==='**' || matchesPathPattern(file,p))))) result.push(task);
    }
    return result;
  }
  async prepareBase(job) {
    return taskLock(job.project_dir,job.task_id,()=>repositoryLock(job.project_dir,async()=>{
      await this.assertJob(job);const task=await this.record(job.project_dir,job.task_id);
      if(!task?.branch || task.branch.mode!=='task') return null;
      const b=task.branch;
      if(task.delivery_status!=='uncommitted') return b.expected_tip;
      const config=await json(path.join(job.project_dir,'.agent-orchestrator/config.json'),{});
      if(config.git_lifecycle?.allow_verified_baseline_advance===false) return b.expected_tip;
      const jobs=(await this.store.listJobs()).filter(j=>j.task_id===job.task_id && j.project_dir===job.project_dir && j.workspace);
      if(jobs.length) return b.expected_tip;
      const source=await inventory(job.project_dir);
      let ready=await json(path.join(job.project_dir,'.agent-orchestrator/environment/readiness.json'));
      if(ready?.fingerprint!==source.fingerprint && await carryVerifiedBaseline(job.project_dir,source)) ready=await json(path.join(job.project_dir,'.agent-orchestrator/environment/readiness.json'));
      const target=await git(job.project_dir,['rev-parse',b.target_ref]);
      if(!ready || ready.baseline!=='head' || ready.fingerprint!==source.fingerprint || ready.head!==target || target===b.expected_tip) return b.expected_tip;
      if((await git(job.project_dir,['worktree','list','--porcelain','-z'])).split('\0').includes('branch '+b.task_ref)) throw new Error('TASK_BRANCH_CHECKED_OUT');
      const repo=await identity(job.project_dir),file=path.join(repo.common,'agent-orch/task-branches.json'),registry=await json(file,{});
      if(registry[b.task_ref]?.owner_task_id!==job.task_id || await git(job.project_dir,['rev-parse',b.task_ref])!==b.expected_tip) throw new Error('TASK_BRANCH_CHANGED');
      const before=b.expected_tip;await git(job.project_dir,['update-ref',b.task_ref,target,before]);
      b.base_commit=target;b.expected_tip=target;b.target_at_binding=target;
      registry[b.task_ref].expected_tip=target;await save(file,registry);
      task.history.push({kind:'queued_baseline_advanced',before,after:target,audit_id:ready.audit_id,at:stamp()});
      await save(taskFile(job.project_dir,job.task_id),task);return target;
    }));
  }
  async handoff(project, task, args, actor, plan) {
    return taskLock(project, task, async () => {
      let value = await this.ensure(project, task, plan, {locked:true});
      if (args.mode === 'inspect') {
        const jobs=(await this.store.listJobs()).filter(j=>j.project_dir===path.resolve(project) && j.task_id===task);
        const active=jobs.filter(j=>alive(j) || ['queued','running'].includes(j.status));
        return {task_id:task,owner_session_id:value.owner_session_id,epoch:value.epoch,identity:value.owner_identity,
          branch:value.branch,delivery_status:value.delivery_status,integration_status:value.integration_status,
          workspace_status:value.workspace_status,pending_handoff:value.pending_handoff,active_job_count:active.length,
          active_jobs:active.slice(0,8).map(j=>({id:j.id,status:j.status,phase:j.phase})),evidence_path:taskFile(project,task)};
      }
      if (args.expected_epoch !== value.epoch) throw new Error('TASK_HANDOFF_STALE: inspect the current execution epoch');
      if (args.mode === 'prepare') {
        await this.assertOwner(project, task, actor, args.expected_epoch);
        if (!args.reason) throw new Error('Handoff requires a concrete reason');
        if (value.pending_handoff) return value.pending_handoff;
        value.pending_handoff = { handoff_id: crypto.randomUUID(), from_session_id: actor, to_session_id: args.to_session_id || null,
          epoch: value.epoch, contract_digest: value.contract_digest, reason: args.reason, prepared_at: stamp() };
        await save(taskFile(project, task), value); return value.pending_handoff;
      }
      if (!['claim', 'recover'].includes(args.mode) || args.confirm !== true || !actor || !args.reason) throw new Error('TASK_HANDOFF_APPROVAL_REQUIRED: claim/recovery needs actual user authorization and reason');
      if (args.mode === 'claim') {
        const h = value.pending_handoff;
        if (!h || h.handoff_id !== args.handoff_id || h.epoch !== value.epoch || h.contract_digest !== value.contract_digest || (h.to_session_id && h.to_session_id !== actor)) throw new Error('TASK_HANDOFF_MISMATCH');
      } else if (args.from_session_id !== value.owner_session_id) throw new Error('TASK_HANDOFF_MISMATCH: recovery must name the previous owner');
      if (actor === value.owner_session_id) throw new Error('Handoff requires a different coordinator session');
      const jobs = (await this.store.listJobs()).filter(j => j.project_dir === path.resolve(project) && j.task_id === task);
      if (value.legacy_origin && jobs.some(j => j.coordination_protocol!==1 && j.supervisor_pid && j.supervisor_pid !== process.pid && processExists(j.supervisor_pid))) throw new Error('LEGACY_RUNTIME_ACTIVE: reconnect the old Plan chat to the updated runtime before transferring authority');
      if (jobs.some(j => j.type === 'task_finalize' && (alive(j) || ['queued', 'running'].includes(j.status)))) throw new Error('TASK_HANDOFF_BUSY: wait for the in-flight finalization to settle');
      const next = args.actor_identity;
      if (!next?.model || next.provider !== value.owner_identity.provider || next.invocation !== value.owner_identity.invocation) throw new Error('TASK_HANDOFF_IDENTITY_REQUIRED: provider/invocation changes require a new independent Plan');
      if (next.model !== value.owner_identity.model && args.allow_model_change !== true) throw new Error('TASK_HANDOFF_MODEL_APPROVAL_REQUIRED');
      const entry = { kind: args.mode === 'claim' ? 'handoff_claimed' : 'handoff_recovered', previous_session_id: value.owner_session_id,
        session_id: actor, previous_epoch: value.epoch, epoch: value.epoch + 1, identity: next, reason: args.reason, at: stamp() };
      value = { ...value, owner_session_id: actor, epoch: entry.epoch, owner_identity: { ...next, session_id: actor },
        authorized_job_ids: [...new Set([...value.authorized_job_ids, ...jobs.map(j => j.id)])], pending_handoff: null, history: [...value.history, entry], updated_at: stamp() };
      await save(taskFile(project, task), value);
      return { task_id: task, owner_session_id: actor, epoch: value.epoch, adopted_job_count: value.authorized_job_ids.length, adopted_jobs_preview:value.authorized_job_ids.slice(0,8),
        identity: value.owner_identity, evidence_path: taskFile(project, task), note: 'Existing workers keep their baseline and provider session; prior coordinator mutations are fenced' };
    });
  }
  async bindBranch(project, task, choice, actor, { repositoryLocked = false } = {}) {
    if (choice.confirm !== true) throw new Error('BRANCH_APPROVAL_REQUIRED');
    const record = await this.assertOwner(project, task, actor);
    if (!record) throw new Error('TASK_PLAN_IDENTITY_REQUIRED');
    if (record.branch) {
      if ((choice.task_branch && choice.task_branch!==record.branch.task_branch) || (choice.target_branch && choice.target_branch!==record.branch.target_branch)) throw new Error('TASK_BRANCH_IMMUTABLE: use a new reviewed Plan to change branch binding');
      return record.branch;
    }
    const execute = async () => {
      const repo = await identity(project), recommendation = await branchRecommendation(project, task);
      const targetName = choice.target_branch || recommendation.target_branch;
      const target = await branchRef(project, targetName);
      const targetTip = await git(project, ['rev-parse', '--verify', `${target}^{commit}`]);
      const name = choice.mode === 'current' ? (await git(project, ['symbolic-ref', '--short', 'HEAD'])) : choice.task_branch || recommendation.task_branch;
      const ref = await branchRef(project, name);
      const registryFile = path.join(repo.common, 'agent-orch/task-branches.json');
      const registry = await json(registryFile, {});
      const prior = registry[ref];
      let tip = await git(project, ['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
      let created = false;
      if(tip && choice.mode!=='current' && choice.mode!=='reuse') throw new Error('BRANCH_EXISTS: explicitly approve reuse');
      let predecessor=null;
      if (prior && prior.owner_task_id !== task) {
        if (choice.reuse_from_task_id !== prior.owner_task_id) throw new Error('BRANCH_OWNERSHIP_REQUIRED: name the recorded predecessor explicitly');
        predecessor = await this.record(project, prior.owner_task_id);
        const jobs = (await this.store.listJobs()).filter(j => j.project_dir === path.resolve(project) && j.task_id === prior.owner_task_id);
        if (!predecessor || !['committed', 'merged'].includes(predecessor.delivery_status) || jobs.some(j => alive(j) || ['queued', 'running'].includes(j.status) || (j.workspace && !j.cleaned_at))) throw new Error('BRANCH_BUSY: predecessor still owns unfinished work');
        const contract=await loadPlannerContract(project,prior.owner_task_id);
        if(contract.executor_subtasks.some(sub=>!jobs.some(j=>j.subtask_id===sub.subtask_id && j.contract_digest===contract.contract_digest && (j.task_commit_id || j.commit_id) && j.cleaned_at))) throw new Error('BRANCH_HAS_PENDING_SUBTASKS: complete or explicitly revise the predecessor Plan before transferring its branch');
      }
      if (!tip) {
        if (!name.startsWith('codex/') || choice.mode === 'reuse') throw new Error('BRANCH_CREATE_REQUIRED: new managed branches use codex/');
        await git(project, ['update-ref', ref, targetTip, '0'.repeat(targetTip.length)]); tip = targetTip; created = true;
      } else if (choice.mode !== 'current' && choice.mode !== 'reuse') throw new Error('BRANCH_EXISTS: explicitly approve reuse, never infer ownership from the name');
      const binding = { task_branch: name, task_ref: ref, target_branch: targetName, target_ref: target, base_commit: tip,
        expected_tip: tip, target_at_binding: targetTip, managed: created || prior?.managed === true,
        history_verified: created || ref === target || Boolean(prior?.managed && prior.expected_tip === tip), mode: ref === target ? 'current' : 'task', bound_at: stamp() };
      registry[ref] = { owner_task_id: task, managed: binding.managed, expected_tip: tip };
      await save(registryFile, registry);
      if(predecessor) {predecessor.successor_task_id=task;await save(taskFile(project,predecessor.task_id),predecessor);}
      record.branch = binding; record.legacy = false; record.history.push({ kind: 'branch_bound', branch: name, actor, at: stamp() });
      await save(taskFile(project, task), record); return binding;
    };
    if(repositoryLocked) return execute();
    const run=()=>repositoryLock(project,execute);
    return choice.reuse_from_task_id && choice.reuse_from_task_id!==task ? taskLock(project,choice.reuse_from_task_id,run):run();
  }
}
