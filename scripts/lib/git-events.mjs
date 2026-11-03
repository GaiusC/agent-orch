import path from 'node:path';
import crypto from 'node:crypto';
import { identity, json, save } from './lifecycle-git.mjs';
import { StateStore } from './state.mjs';
import { withFileLock } from './notifications.mjs';

// Durable operation receipts are authoritative. The existing event log is a
// replayable projection; a crash between the two writes cannot lose the fact.
export async function recordGitOperation({ projectDir, jobDir, store, job = {}, kind, key = kind, ...fact }) {
  const jobId = job.id || path.basename(jobDir);
  const operationId = 'git-' + crypto.createHash('sha256').update(`${jobId}:${kind}:${key}`).digest('hex').slice(0,32);
  const file = path.join(jobDir, 'git-operations', `${operationId}.json`);
  return withFileLock(file + '.lock', async () => {
    let receipt = await json(file);
    if (!receipt) {
      const repo = await identity(projectDir);
      const recorded = new Date().toISOString();
      receipt = { version:1, operation_id:operationId, kind, job_id:jobId,
        project_dir:repo.root, repository_common_dir:repo.common,
        task_id:job.task_id || null, plan_id:job.plan_id || null,
        contract_digest:job.contract_digest || null, status:'completed',
        ...fact, occurred_at:fact.recovered ? (fact.occurred_at || null) : (fact.occurred_at || recorded),
        recorded_at:recorded, source_file:file };
      await save(file, receipt);
    }
    const target = store || new StateStore(path.join(projectDir,'.agent-orchestrator','state'), {jobsRoot:path.dirname(jobDir)});
    const existing = await target.readEvents({limit:0});
    if (!existing.some(e => e.event_id === operationId)) {
      await target.recordEvent('git.' + kind, {id:jobId,task_id:receipt.task_id,project_dir:projectDir},
        {event_id:operationId,git_operation:receipt,message:kind});
    }
    return receipt;
  });
}
