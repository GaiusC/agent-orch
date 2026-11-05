import path from 'node:path';
import { bindProject } from './project-identity.mjs';
import { canonicalPath, digest, identity, json, safeId } from './lifecycle-git.mjs';

export const hasRepositoryIdentity = value => Boolean(value) && (typeof value !== 'string' || value.trim().length > 0);

export async function repositoryIdentityForProject(projectDir) {
  const repository = await identity(projectDir);
  const common = await canonicalPath(repository.common);
  return `git-common:${digest(common)}`;
}

// Older native Plans permitted an omitted contract identity. Recover provenance
// from their immutable execution identity and recorded Work ancestry, never by
// editing that contract (which would change its digest and invalidate review).
export async function resolveRepositoryProvenance({ projectDir, contract, job }) {
  if (hasRepositoryIdentity(contract?.repository_identity)) return { identity: contract.repository_identity };
  if (!projectDir || !contract?.task_id || !contract.contract_digest || !job?.workspace?.path) {
    throw new Error('REPOSITORY_IDENTITY_UNAVAILABLE: missing contract identity requires a native Plan and recorded implementation workspace');
  }
  const plan = await json(path.join(projectDir, '.agent-orchestrator', 'plans', `${safeId(contract.task_id)}.execution.json`));
  if (!plan?.project_id || !plan.coordinator_common) {
    throw new Error('REPOSITORY_IDENTITY_UNAVAILABLE: the original native Plan has no verifiable repository binding; preserve the evidence');
  }
  const repository = await identity(projectDir);
  const common = await canonicalPath(repository.common);
  const binding = await bindProject(projectDir, { create: false, checkFresh: false });
  const source = job.workspace.source_inventory;
  if (binding.status !== 'bound' || binding.project_id !== plan.project_id
      || await canonicalPath(plan.coordinator_common) !== common
      || plan.task_id !== contract.task_id || plan.contract_id !== contract.contract_id
      || plan.contract_digest !== contract.contract_digest
      || job.task_id !== contract.task_id || job.contract_id !== contract.contract_id
      || job.contract_digest !== contract.contract_digest
      || !job.project_dir || await canonicalPath(job.project_dir) !== await canonicalPath(repository.root)
      || !source?.common || !source.root || await canonicalPath(source.common) !== common
      || await canonicalPath(source.root) !== await canonicalPath(repository.root)) {
    throw new Error('REPOSITORY_IDENTITY_MISMATCH: native Plan, project binding and recorded implementation ancestry disagree');
  }
  const workspace = await identity(job.workspace.path);
  if (await canonicalPath(workspace.common) !== common || await canonicalPath(workspace.root) !== await canonicalPath(job.workspace.path)) {
    throw new Error('REPOSITORY_IDENTITY_MISMATCH: implementation workspace belongs to a different repository');
  }
  return {
    identity: `git-common:${digest(common)}`,
    provenance: {
      version: 1, source: 'verified_native_plan', project_id: binding.project_id,
      coordinator_common: common, task_id: contract.task_id, contract_id: contract.contract_id,
      contract_digest: contract.contract_digest, implementation_job_id: job.id,
    },
  };
}
