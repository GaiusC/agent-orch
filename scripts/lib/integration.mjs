import path from 'node:path';
import { git, inventory, json, save, digest, repositoryLock, scopedTree, removeIndex, safeId } from './lifecycle-git.mjs';
import { reserveWorkspace } from './workspace-pool.mjs';
import { assertProject } from './config.mjs';
import { loadPlannerSubtask, loadPlannerContract, getContractDigest } from './contracts.mjs';
import { validateAcceptanceForCurrentPatch } from './acceptance.mjs';
import { captureChanges } from './workspace.mjs';
import { runVerification } from './verify.mjs';
import crypto from 'node:crypto';
import { prepareProgressChannel, reportProgress, withFileLock } from './notifications.mjs';
import { recordGitOperation } from './git-events.mjs';
import { validateTaskDelivery } from './branch-delivery.mjs';

export async function startIntegration(orchestrator, args) {
  return repositoryLock(path.resolve(args.project_dir), () => startIntegrationUnlocked(orchestrator, args));
}

async function startIntegrationUnlocked(orchestrator, args) {
  const project = path.resolve(args.project_dir);
  const config = await assertProject(project);
  let job;
  if (args.job_id) {
    job = await orchestrator.store.getJob(safeId(args.job_id));
    if (!job || job.project_dir !== project || !job.integration_job_ids || job.status !== 'failed' || job.acceptance_status === 'accepted' || orchestrator.promises.has(job.id)) throw new Error('Only a failed integration can resume in its existing workspace');
    if (getContractDigest(await loadPlannerContract(project, job.task_id)) !== job.contract_digest) throw new Error('Integration Plan changed; create a new integration task');
    await orchestrator.store.updateJob(job.id, { status: 'queued', phase: 'queued', error: null });
  } else {
    if(args.target_job_id) args={...args,job_ids:[args.target_job_id]};
    if ((await orchestrator.store.listJobs()).some(j => j.project_dir === project && j.integration_job_ids && ['queued', 'running'].includes(j.status))) throw new Error('An integration is already active in this project');
    if (!Array.isArray(args.job_ids) || args.job_ids.length < (args.target_job_id?1:2) || args.job_ids.length > 8 || new Set(args.job_ids).size !== args.job_ids.length) throw new Error('Integration requires 2-8 unique job ids, or one committed target_job_id');
    const { contract, subtask } = await loadPlannerSubtask(project, args.task_id, args.subtask_id);
    if (args.job_ids.some(id => !safeId(id))) throw new Error('Invalid integration source');
    job = await orchestrator.store.createJob({ id: `integrate-${crypto.randomUUID()}`, type: 'stage_work', provider: 'integration',
      status: 'queued', phase: 'queued', project_dir: project, task_id: args.task_id, subtask_id: args.subtask_id,
      contract_id: contract.contract_id, contract_digest: getContractDigest(contract), integration_job_ids: args.job_ids,
      coordinator_fence:args.coordinator_fence || null, integration_target_job_id:args.target_job_id || null,
      writable_paths: subtask.writable_paths, forbidden_paths: subtask.forbidden_paths,
      acceptance_commands: subtask.required_tests, requires_agy_review: true, review_waiver: false,
      integration_position: 0, goal: subtask.objective });
  }
  await orchestrator.taskLifecycle.assertJob(job);
  orchestrator.launch(job, signal => executeIntegration(orchestrator, job, config, signal));
  return orchestrator.publicJob(job);
}

async function executeIntegration(orchestrator, job, config, signal) {
  const store = orchestrator.store, directory = store.jobDir(job.id);
  const operation = (kind,fact={}) => recordGitOperation({projectDir:job.project_dir,jobDir:directory,store,job,kind,...fact});
  let current = await store.getJob(job.id);
  const inputs = [];
  for (const id of job.integration_job_ids) {
    const source = await store.getJob(id);
    if (!source || source.project_dir !== job.project_dir || source.status !== 'completed' || source.integration_job_ids || source.acceptance_status !== 'accepted') throw new Error('Integration sources must be accepted implementation jobs of this project');
    const evidence = await json(source.evidence_path);
    if (!evidence?.changes || evidence.changes.forbidden_changes?.length || evidence.changes.unauthorized_changes?.length || (evidence.verification?.configured !== false && !evidence.verification?.passed)) throw new Error('Integration source evidence is incomplete');
    if(source.task_commit_id) {
      const proof=await validateTaskDelivery(orchestrator,source);
      inputs.push({id,commit:proof.commit_id,reference:proof.ref,patch_digest:proof.patch_digest});
      await operation('integration.input',{key:id,source_job_id:id,commit_id:proof.commit_id,ref:proof.ref,patch_digest:proof.patch_digest,recovered:true});
      continue;
    }
    await validateAcceptanceForCurrentPatch({ projectDir: source.project_dir, job: source, artifactPath: source.acceptance_artifact_path, contract: await loadPlannerContract(job.project_dir, source.task_id), currentPatchDigest: evidence.changes.patch_digest });
    const before = await inventory(source.workspace.path);
    const patch = await git(source.workspace.path, ['diff', '--binary', '--no-ext-diff'], { binary: true });
    if (digest(patch) !== evidence.changes.patch_digest || await git(source.workspace.path, ['diff', '--cached', '--name-only']) || await git(source.workspace.path, ['ls-files', '--others', '--exclude-standard'])) throw new Error('Integration input changed after acceptance');
    const staged = await scopedTree(source.workspace.path, evidence.changes.changed_files, path.join(directory, 'inputs', source.id));
    try {
      const previous = current.integration_inputs?.find(input => input.id === id);
      const reference = `refs/agent-orch/results/${source.id}`;
      const recordedCommit = await git(job.project_dir,['rev-parse','--verify',reference+'^{commit}'],{allowFailure:true});
      const saved = previous?.commit || recordedCommit || await git(source.workspace.path, ['commit-tree', staged.tree, '-p', before.head, '-m', `Agent Orch integration input ${source.id}`]);
      if (await git(source.workspace.path, ['rev-parse', `${saved}^{tree}`]) !== staged.tree) throw new Error('Integration source tree differs from the saved input');
      await git(job.project_dir, ['update-ref', reference, saved]);
      inputs.push({ id, commit: saved, reference, patch_digest: evidence.changes.patch_digest });
      await operation('integration.input',{key:id,source_job_id:id,commit_id:saved,after_head:saved,before_head:before.head,ref:reference,workspace:source.workspace.path,patch_digest:evidence.changes.patch_digest,recovered:Boolean(previous || recordedCommit)});
    } finally { await removeIndex(staged.index); }
  }
  if (!current.workspace) {
    const task=await orchestrator.taskLifecycle.record(job.project_dir,job.task_id);
    const workspace = await reserveWorkspace({ projectDir: job.project_dir, jobDir: directory, config, signal, kind: 'integration', baseCommit:task?.branch?.mode==='task'?task.branch.expected_tip:null,
      resolveBase:task?.branch?.mode==='task'?()=>orchestrator.taskLifecycle.prepareBase(job):null,onWait: async () => {
      await store.updateJob(job.id, { status: 'running', phase: 'waiting_for_workspace' });
      const channel = await prepareProgressChannel(directory, { projectDir: job.project_dir, role: 'worker' });
      await reportProgress(channel, { checkpoint: 'blocked', message: 'Integration is waiting for an approved workspace/storage slot. Existing workspaces are preserved.' });
    } });
    current = await store.updateJob(job.id, { workspace, integration_inputs: inputs, phase: 'integrating', status: 'running' });
    await orchestrator.taskLifecycle.noteWorkspace(job);
  }
  await withFileLock(path.join(directory,'integration.lock'), async () => {
    current = await store.getJob(job.id);
    const workspace = current.workspace.path;
    for (let n = current.integration_position || 0; n < inputs.length; n++) {
      if (signal.aborted) throw new Error('Integration cancelled');
      const beforeHead = await git(workspace,['rev-parse','HEAD']);
      const mergeHead = await git(workspace, ['rev-parse', '--verify', 'MERGE_HEAD'], { allowFailure: true });
      if (mergeHead) {
        if (mergeHead !== inputs[n].commit) throw new Error('Integration MERGE_HEAD changed unexpectedly');
        if (await git(workspace, ['ls-files', '--unmerged'])) {
          await operation('integration.conflict',{key:crypto.randomUUID(),status:'failed',workspace,source_job_id:inputs[n].id,before_head:beforeHead,input_commit:inputs[n].commit});
          throw new Error('INTEGRATION_CONFLICT: resolve the existing integration worktree, stage resolutions, then resume this job');
        }
        await git(workspace, ['commit', '-m', `Integrate ${inputs[n].id}`]);
      } else {
        const merged = await git(workspace, ['merge', '--no-ff', '--no-commit', inputs[n].commit], { allowFailure: true });
        if (merged === null) {
          await operation('integration.conflict',{key:crypto.randomUUID(),status:'failed',workspace,source_job_id:inputs[n].id,before_head:beforeHead,input_commit:inputs[n].commit});
          throw new Error('INTEGRATION_CONFLICT: inspect preserved integration workspace; source workspaces are unchanged');
        }
        if (await git(workspace, ['rev-parse', '--verify', 'MERGE_HEAD'], { allowFailure: true })) await git(workspace, ['commit', '-m', `Integrate ${inputs[n].id}`]);
      }
      const afterHead = await git(workspace,['rev-parse','HEAD']);
      await operation('integration.merged',{key:inputs[n].id,workspace,source_job_id:inputs[n].id,before_head:beforeHead,after_head:afterHead,input_commit:inputs[n].commit,resolved_conflict:Boolean(mergeHead),recovered:afterHead===beforeHead});
      await store.updateJob(job.id, { integration_position: n + 1 });
    }
    let combined = await git(workspace, ['rev-parse', 'HEAD']);
    if (combined === current.workspace.base_commit) {
      const files = (await inventory(workspace)).changes.flatMap(change => [change.path, change.from].filter(Boolean));
      const staged = await scopedTree(workspace, [...new Set(files)], path.join(directory, 'repair'));
      try { combined = await git(workspace, ['commit-tree', staged.tree, '-p', current.workspace.base_commit, '-m', `Integration repair ${job.id}`]); }
      finally { await removeIndex(staged.index); }
    }
    await git(job.project_dir, ['update-ref', `refs/agent-orch/integrations/${job.id}`, combined]);
    await operation('integration.checkpoint',{key:combined,workspace,commit_id:combined,after_head:combined,before_head:current.workspace.base_commit,ref:`refs/agent-orch/integrations/${job.id}`});
    // Keep the reviewed deliverable as a patch against the integration base.
    // This reset is confined to the plugin-owned integration index and HEAD.
    await git(workspace, ['reset', '--mixed', current.workspace.base_commit]);
    const changes = await captureChanges({ workspace, jobDir: directory, writable: job.writable_paths, forbidden: [...config.scope.forbidden, ...job.forbidden_paths] });
    if (changes.forbidden_changes.length || changes.unauthorized_changes.length) throw new Error('Integration exceeds its Planner scope');
    const verification = await runVerification({ commands: job.acceptance_commands, workspace, jobDir: directory, config, signal });
    const after = await captureChanges({ workspace, jobDir: directory, writable: job.writable_paths, forbidden: [...config.scope.forbidden, ...job.forbidden_paths] });
    if (after.patch_digest !== changes.patch_digest) throw new Error('Integration verification changed deliverable files');
    const evidence = { status: verification.passed ? 'completed' : 'failed', provider: 'integration', job_id: job.id,
      integration_inputs: inputs, integration_checkpoint: combined, changes, verification, workspace: current.workspace };
    const evidencePath = path.join(directory, 'evidence.json'); await save(evidencePath, evidence);
    await store.updateJob(job.id, { evidence_path: evidencePath, patch_path: changes.patch_path });
    if (!verification.passed) throw new Error('Integration verification failed; preserve workspace for repair and resume');
    await store.updateJob(job.id, { status: 'completed', phase: 'ready_for_acceptance', evidence_path: evidencePath,
      patch_path: changes.patch_path, integration_checkpoint: combined, finished_at: new Date().toISOString(), session_id: `integration-${job.id}` });
  });
}
