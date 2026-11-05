import path from 'node:path';
import fs from 'node:fs/promises';
import { git, identity, inventory, digest, json, save as saveAtomic, safeId, scopedTree, removeIndex, repositoryLock, canonicalPath } from './lifecycle-git.mjs';
import { withFileLock } from './notifications.mjs';
import { taskFile, taskRecord, taskLock } from './task-lifecycle.mjs';
import { loadPlannerContract } from './contracts.mjs';
import { validateAcceptanceForCurrentPatch } from './acceptance.mjs';
import { runVerification } from './verify.mjs';
import { assertProject } from './config.mjs';
import { carryVerifiedBaseline } from './environment-baseline.mjs';

const now = () => new Date().toISOString();
const save=(file,value)=>saveAtomic(file,value,{durable:true});
const proofFile = (store, job) => path.join(store.jobDir(job.id), 'task-delivery.json');
export async function validateTaskDelivery(orchestrator, job) {
  const proof = await json(proofFile(orchestrator.store,job));
  const repo = await identity(job.project_dir);
  const contract = await loadPlannerContract(job.project_dir,job.task_id);
  if (!proof || proof.ref!==`refs/agent-orch/deliveries/${safeId(job.id)}` || proof.job_id !== job.id || proof.task_id !== job.task_id || proof.commit_id !== job.task_commit_id
      || proof.contract_digest !== contract.contract_digest || await canonicalPath(proof.repository_common) !== await canonicalPath(repo.common)
      || await git(job.project_dir,['rev-parse','--verify',proof.ref+'^{commit}']) !== proof.commit_id
      || await git(job.project_dir,['rev-parse',proof.commit_id+'^{tree}']) !== proof.tree_id
      || digest(await fs.readFile(job.acceptance_artifact_path)) !== proof.acceptance_sha256
      || digest(await fs.readFile(job.evidence_path)) !== proof.evidence_sha256
      || digest(await fs.readFile(job.patch_path)) !== proof.patch_digest) throw new Error('TASK_DELIVERY_PROOF_MISMATCH: preserve the directory and inspect immutable evidence/refs');
  return proof;
}
async function checkedOut(project, ref) {
  const raw = await git(project,['worktree','list','--porcelain','-z']);
  const result=[];let current;
  for (const line of raw.split('\0')) {
    if (line.startsWith('worktree ')) current=line.slice(9);
    if (line===`branch ${ref}`) result.push(current);
  }
  return result;
}
async function updateTask(orchestrator, job, patch) {
  const value = await taskRecord(job.project_dir,job.task_id);
  Object.assign(value,patch,{updated_at:now()}); await save(taskFile(job.project_dir,job.task_id),value);return value;
}

// The caller holds a task mutation lease (or an active background finalizer).
// Long verification uses only the job delivery lock, never the repository lock.
export async function finalizeTaskBranch(lifecycle, jobId, args) {
  const orchestrator=lifecycle.orchestrator,store=orchestrator.store;
  return withFileLock(path.join(store.jobDir(jobId),'task-delivery.lock'),async()=>{
    let job=await store.getJob(jobId);
    const fence=args.coordinator_fence;
    const check=()=>orchestrator.taskLifecycle.assertOwner(job.project_dir,job.task_id,fence?.session_id,fence?.epoch);
    let task=await check();
    const policy=await lifecycle.policy(job.project_dir);
    if (!job.task_commit_id && (policy.commit_policy==='manual' || (policy.commit_policy!=='auto' && args.confirm_commit!==true))) throw new Error('Local task-branch commit needs approval under project policy');
    const directory=path.join(store.jobDir(jobId),'branch-finalization');
    const evidence=await json(job.evidence_path);
    const priorProof=await json(proofFile(store,job));
    if (!job.task_commit_id && priorProof) {
      await validateTaskDelivery(orchestrator,{...job,task_commit_id:priorProof.commit_id});
      await repositoryLock(job.project_dir,async()=>{
        task=await check();
        if(await git(job.project_dir,['rev-parse',task.branch.task_ref])!==priorProof.commit_id) throw new Error('TASK_BRANCH_CHANGED');
        const file=path.join(priorProof.repository_common,'agent-orch/task-branches.json'),registry=await json(file,{});
        if(registry[task.branch.task_ref]?.owner_task_id!==job.task_id) throw new Error('TASK_BRANCH_OWNER_CHANGED');
        registry[task.branch.task_ref].expected_tip=priorProof.commit_id;await save(file,registry);
        task.branch.expected_tip=priorProof.commit_id;await updateTask(orchestrator,job,{branch:task.branch,delivery_status:'committed',integration_status:'pending_merge'});
      });
      job=await store.updateJob(job.id,{task_commit_id:priorProof.commit_id,delivery_status:'committed',integration_status:'pending_merge',phase:'committed_pending_merge'});
    }
    if (!job.task_commit_id) {
      if (job.acceptance_status!=='accepted' || !evidence?.changes?.changed_files?.length) throw new Error('Accepted patch evidence is required');
      await validateAcceptanceForCurrentPatch({projectDir:job.project_dir,job,artifactPath:job.acceptance_artifact_path,contract:await loadPlannerContract(job.project_dir,job.task_id),currentPatchDigest:evidence.changes.patch_digest});
      const intent=await json(path.join(directory,'commit-intent.json'));
      let head=await git(job.workspace.path,['rev-parse','HEAD']);
      let recovered=false;
      if (intent?.status==='rejected_tree') throw new Error('COMMIT_TREE_CHANGED: fresh review is required');
      if (intent && head!==job.workspace.base_commit && await git(job.workspace.path,['rev-parse','HEAD^{tree}'])===intent.tree
          && await git(job.workspace.path,['rev-parse','HEAD^'])===intent.parent) {
        const current=await inventory(job.workspace.path);
        if (![intent.index_digest,intent.final_index_digest].includes(current.index_digest) || JSON.stringify(current.files)!==JSON.stringify(intent.working_files)) throw new Error('TASK_COMMIT_RECOVERY_CHANGED');
        await git(job.workspace.path,['reset','--quiet','HEAD','--pathspec-from-file=-','--pathspec-file-nul'],{input:intent.files.join('\0')+'\0'}); recovered=true;
      }
      if (!recovered && digest(await git(job.workspace.path,['diff','--binary','--no-ext-diff'],{binary:true}))!==evidence.changes.patch_digest) throw new Error('ACCEPTED_WORKTREE_CHANGED');
      if (task.branch.expected_tip!==job.workspace.base_commit) throw new Error('TASK_BRANCH_ADVANCED: integrate parallel results before publishing another candidate');
      const config=await assertProject(job.project_dir);
      if (!recovered) {
        const before=await inventory(job.workspace.path);
        const verification=await runVerification({commands:job.acceptance_commands || [],workspace:job.workspace.path,jobDir:directory,config,signal:args.signal});
        if ((verification.configured && !verification.passed) || (await inventory(job.workspace.path)).fingerprint!==before.fingerprint) throw new Error('Final verification failed or changed deliverable files');
      }
      await check();
      if (args.signal?.aborted) throw new Error('Finalization cancelled before task commit');
      let commit=head;
      if (!recovered && job.integration_checkpoint) {
        const candidate=await scopedTree(job.workspace.path,evidence.changes.changed_files,directory,job.workspace.base_commit);
        try { if (await git(job.project_dir,['rev-parse',job.integration_checkpoint+'^{tree}'])!==candidate.tree) throw new Error('INTEGRATION_CANDIDATE_CHANGED'); }
        finally {await removeIndex(candidate.index);}
        commit=job.integration_checkpoint;
      } else if (!recovered) commit=(await lifecycle.commitExact(job.workspace.path,evidence.changes.changed_files,args.commit_message || `feat: complete ${job.task_id}`,directory,{allowDetached:true})).commit;
      const ref=`refs/agent-orch/deliveries/${safeId(job.id)}`;
      const proof={version:1,job_id:job.id,task_id:job.task_id,repository_common:(await identity(job.project_dir)).common,contract_digest:job.contract_digest,
        commit_id:commit,tree_id:await git(job.project_dir,['rev-parse',commit+'^{tree}']),base_commit:job.workspace.base_commit,ref,
        patch_digest:evidence.changes.patch_digest,acceptance_sha256:digest(await fs.readFile(job.acceptance_artifact_path)),evidence_sha256:digest(await fs.readFile(job.evidence_path)),created_at:now()};
      await repositoryLock(job.project_dir,async()=>{
        task=await check();
        if(![proof.base_commit,commit].includes(task.branch.expected_tip)) throw new Error('TASK_BRANCH_ADVANCED: preserve the committed candidate and integrate parallel results before publishing');
        const registryFile=path.join(proof.repository_common,'agent-orch/task-branches.json'),registry=await json(registryFile,{});
        if (registry[task.branch.task_ref]?.owner_task_id!==job.task_id) throw new Error('TASK_BRANCH_OWNER_CHANGED');
        const existing=await git(job.project_dir,['rev-parse','--verify',ref],{allowFailure:true});
        if (existing && existing!==commit) throw new Error('TASK_DELIVERY_REF_CHANGED');
        await git(job.project_dir,['update-ref',ref,commit,existing || '0'.repeat(commit.length)]);
        const tip=await git(job.project_dir,['rev-parse',task.branch.task_ref]);
        if ((await checkedOut(job.project_dir,task.branch.task_ref)).length) throw new Error('TASK_BRANCH_CHECKED_OUT: preserve candidate; do not update another worktree through its ref');
        if (![task.branch.expected_tip,commit].includes(tip)) throw new Error('TASK_BRANCH_CHANGED: expected branch tip differs');
        if (tip!==commit) await git(job.project_dir,['update-ref',task.branch.task_ref,commit,task.branch.expected_tip]);
        await save(proofFile(store,job),proof);
        registry[task.branch.task_ref].expected_tip=commit;await save(registryFile,registry);
        task.branch.expected_tip=commit;
        await updateTask(orchestrator,job,{branch:task.branch,delivery_status:'committed',integration_status:'pending_merge'});
        job=await store.updateJob(job.id,{task_commit_id:commit,task_branch:task.branch.task_branch,target_branch:task.branch.target_branch,delivery_status:'committed',integration_status:'pending_merge',phase:'committed_pending_merge',closeout_phase:'committed_pending_merge'});
      });
      await lifecycle.operation(job,'task_branch.committed',{commit_id:commit,after_head:commit,before_head:proof.base_commit,ref,workspace:job.workspace.path,patch_digest:proof.patch_digest});
    }
    const proof=await validateTaskDelivery(orchestrator,job);
    task=await check();
    if (args.signal?.aborted) return {status:'committed_pending_merge',task_commit_id:proof.commit_id,commit_id:null,cleanup:false,remaining_paths:[]};
    let merge={status:job.integration_status==='merged'?'merged':'pending_merge',reason:'Merge needs confirmation'};
    if (args.merge!==false && (policy.merge_policy==='auto' || args.confirm_merge===true)) merge=await mergeTaskBranch(lifecycle,job,args,check);
    let cleanup={removed:Boolean(job.cleaned_at)};
    if (args.cleanup!==false && !job.cleaned_at) {
      await check();
      try {cleanup=await orchestrator.cleanup(job.id);}
      catch(error) {cleanup={removed:false,deferred:true,error:error.message};await store.updateJob(job.id,{workspace_status:'cleanup_deferred',closeout_error:error.message});}
    }
    job=await store.getJob(job.id);
    let branch_cleanup;
    if (args.delete_branch===true || (policy.delete_task_branches===true && job.integration_status==='merged')) {
      try {await deleteManagedBranch(lifecycle,job,check);branch_cleanup={status:'deleted'};}
      catch(error) {branch_cleanup={status:'deferred',reason:error.message};}
    }
    const residual=(await inventory(job.project_dir)).changes.map(c=>c.path);
    const result={status:job.integration_status==='merged'?(job.cleaned_at?'closed':'merged_pending_cleanup'):'committed_pending_merge',
      task_commit_id:proof.commit_id,commit_id:job.commit_id || null,delivery_status:'committed',integration_status:job.integration_status || merge.status,
      workspace_status:job.cleaned_at?'cleaned':cleanup.deferred?'cleanup_deferred':'retained',cleanup:Boolean(job.cleaned_at),merge,branch_cleanup,
      remaining_path_count:residual.length,remaining_paths:residual.slice(0,8),remaining_paths_truncated:residual.length>8};
    await save(path.join(directory,'receipt.json'),result);
    await store.updateJob(job.id,{closeout_phase:result.status,closeout_receipt:path.join(directory,'receipt.json'),workspace_status:result.workspace_status});
    await updateTask(orchestrator,job,{workspace_status:result.workspace_status});
    return result;
  });
}

async function mergeTaskBranch(lifecycle,job,args,check) {
  const o=lifecycle.orchestrator;
  const inputs=await Promise.all((job.integration_job_ids || []).map(id=>o.store.getJob(id)));
  const sourceTasks=[...new Set(inputs.map(j=>j?.task_id).filter(id=>id && id!==job.task_id))].sort();
  const merge=()=>repositoryLock(job.project_dir,async()=>{
    const task=await check(),branch=task.branch;
    const proof=await validateTaskDelivery(o,job);
    const target=await git(job.project_dir,['rev-parse',branch.target_ref]);
    if (!branch.history_verified) return {status:'integration_required',reason:'Reused branch history needs a fresh combined review',target_commit:target};
    const already=await git(job.project_dir,['merge-base','--is-ancestor',proof.commit_id,target],{allowFailure:true})!==null;
    if (!already && await git(job.project_dir,['merge-base','--is-ancestor',target,proof.commit_id],{allowFailure:true})===null) return {status:'integration_required',reason:'Target advanced; use stage-integrate target_job_id with a new integration Plan',target_commit:target};
    const directories=await checkedOut(job.project_dir,branch.target_ref);
    const intentFile=path.join(o.store.jobDir(job.id),'branch-finalization/merge-intent.json');
    if (!already) {
      if (directories.length && (directories.length!==1 || await canonicalPath(directories[0])!==await canonicalPath(job.project_dir))) return {status:'pending_merge',reason:'Target is checked out by another workspace'};
      if (directories.length) {
        const state=await inventory(job.project_dir);
        if (state.changes.length || Object.values(state.operations).some(Boolean)) return {status:'pending_merge',reason:'Target working directory has preserved modifications or a Git operation'};
        const incoming=(await git(job.project_dir,['diff','--name-only','-z',target,proof.commit_id])).split('\0').filter(Boolean);
        const others=(await git(job.project_dir,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
        const ignored=(await git(job.project_dir,['ls-files','--others','--ignored','--exclude-standard','-z'])).split('\0').filter(Boolean);
        if (incoming.some(f=>[...others,...ignored].some(p=>f===p || f.startsWith(p+'/') || p.startsWith(f+'/')))) return {status:'pending_merge',reason:'Incoming files collide with untracked or ignored content'};
        await save(intentFile,{target_ref:branch.target_ref,before:target,after:proof.commit_id,checked_out:true,at:now()});
        await check();
        if (await git(job.project_dir,['rev-parse',branch.target_ref])!==target) throw new Error('TARGET_REF_CHANGED');
        await git(job.project_dir,['merge','--ff-only','--no-overwrite-ignore',proof.commit_id]);
      } else {
        await save(intentFile,{target_ref:branch.target_ref,before:target,after:proof.commit_id,checked_out:false,at:now()});
        await check();await git(job.project_dir,['update-ref',branch.target_ref,proof.commit_id,target]);
      }
    }
    const mergedHead=already?target:proof.commit_id;
    await o.store.updateJob(job.id,{commit_id:mergedHead,integration_status:'merged',merged_at:now(),applied_at:now()});
    await updateTask(o,job,{delivery_status:'merged',integration_status:'merged',target_commit:mergedHead});
    const intent=await json(intentFile);
    await lifecycle.operation(job,'delivery.committed',{commit_id:mergedHead,before_head:already && intent?.after===target?intent.before:target,after_head:mergedHead,ref:branch.target_ref,workspace:job.project_dir,recovered:already,
      after_files_digest:digest((await inventory(job.project_dir)).files)});
    await carryVerifiedBaseline(job.project_dir,await inventory(job.project_dir),{allowAdvance:(await lifecycle.policy(job.project_dir)).allow_verified_baseline_advance!==false});
    for (const id of job.integration_job_ids || []) {
      const input=await o.store.getJob(id);
      await o.store.updateJob(id,{commit_id:mergedHead,integration_status:'merged',integrated_into_job_id:job.id,integrated_at:now(),
        ...(input.cleaned_at?{phase:'applied_and_cleaned',closeout_phase:'closed'}:{})});
      if (args.cleanup!==false && !input.cleaned_at) {
        try {await lifecycle.cleanup(id);}
        catch(error) {await o.store.updateJob(id,{workspace_status:'cleanup_deferred',closeout_error:error.message});}
      }
      if(await taskRecord(input.project_dir,input.task_id)) await updateTask(o,input,{delivery_status:'merged',integration_status:'merged',target_commit:mergedHead,
        workspace_status:(await o.store.getJob(id)).cleaned_at?'cleaned':'cleanup_deferred'});
    }
    return {status:'merged',target_commit:mergedHead,recovered:already};
  });
  const lock=index=>index===sourceTasks.length?merge():taskLock(job.project_dir,sourceTasks[index],()=>lock(index+1));
  return lock(0);
}

async function deleteManagedBranch(lifecycle,job,check) {
  return repositoryLock(job.project_dir,async()=>{
    const task=await check(),b=task.branch;
    if (!b.managed || b.task_ref===b.target_ref || job.integration_status!=='merged') throw new Error('BRANCH_DELETE_NOT_AUTHORIZED: retain user branches and pending results');
    if ((await checkedOut(job.project_dir,b.task_ref)).length) throw new Error('BRANCH_CHECKED_OUT');
    const tip=await git(job.project_dir,['rev-parse','--verify',b.task_ref],{allowFailure:true});
    if (!tip) return;
    if (tip!==b.expected_tip || await git(job.project_dir,['merge-base','--is-ancestor',tip,b.target_ref],{allowFailure:true})===null) throw new Error('BRANCH_CHANGED: retain external commits');
    const jobs=(await lifecycle.store.listJobs()).filter(j=>j.task_id===job.task_id && j.project_dir===job.project_dir && !(j.type==='task_finalize' && j.target_job_id===job.id));
    if (jobs.some(j=>['queued','running'].includes(j.status) || (j.workspace && !j.cleaned_at))) throw new Error('BRANCH_STILL_REFERENCED');
    const contract=await loadPlannerContract(job.project_dir,job.task_id);
    if(contract.executor_subtasks.some(sub=>!jobs.some(j=>j.subtask_id===sub.subtask_id && j.contract_digest===contract.contract_digest && j.commit_id && j.cleaned_at))) throw new Error('BRANCH_HAS_PENDING_SUBTASKS');
    await git(job.project_dir,['update-ref','-d',b.task_ref,tip]);
    b.deleted_at=now();await updateTask(lifecycle.orchestrator,job,{branch:b});
  });
}
