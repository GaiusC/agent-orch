import fs from "node:fs/promises";
import path from "node:path";
import { getContractId, getContractVersion, getContractDigest } from "./contracts.mjs";
import { newId, nowIso, pathExists, readJson, writeJsonAtomic } from "./utils.mjs";

// -- Acceptance status constants --

export const ACCEPTANCE_STATUS = Object.freeze({
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  UNAVAILABLE: "unavailable",
});

// -- Full acceptance artifact schema validation --

const ACCEPTED_REQUIRED_FIELDS = [
  "acceptance_id",
  "task_id",
  "job_id",
  "contract_id",
  "contract_version",
  "contract_digest",
  "patch_digest",
  "test_evidence_ids",
  "reviewer_evidence_ids",
  "repository_identity",
  "workspace_identity",
  "accepter_host",
  "accepter_provider",
  "accepter_model",
  "accepter_session_id",
  "status",
  "summary",
  "conditions",
  "unresolved_risks",
  "created_at",
];

/**
 * Returns an array of validation error strings for an acceptance artifact.
 * An empty array means the artifact is valid.
 *
 * Acceptance semantics:
 *  - status "accepted"  → provider/model/session MUST be non-null
 *  - status "rejected"  → provider/model/session may be null (decision was made, not executed)
 *  - status "unavailable" → provider/model/session may be null (no accepter ran)
 */
export function validateAcceptanceArtifactSchema(artifact) {
  const errors = [];

  if (!artifact || typeof artifact !== "object") return ["Acceptance artifact must be a non-null object"];

  for (const field of ACCEPTED_REQUIRED_FIELDS) {
    const val = artifact[field];
    if (val === undefined || val === null || (typeof val === "string" && !String(val).trim())) {
      errors.push(`Missing or empty required field: ${field}`);
    }
  }

  // contract_version must be a positive integer
  const version = Number(artifact.contract_version);
  if (!Number.isInteger(version) || version < 1) {
    errors.push("contract_version must be a positive integer");
  }

  // status must be one of the valid values
  const validStatuses = Object.values(ACCEPTANCE_STATUS);
  if (!validStatuses.includes(artifact.status)) {
    errors.push(`status must be one of: ${validStatuses.join(", ")}`);
  }

  // For "accepted" status, accepter provenance must be populated
  if (artifact.status === ACCEPTANCE_STATUS.ACCEPTED) {
    if (!artifact.accepter_provider) errors.push("accepter_provider is required for accepted status");
    if (!artifact.accepter_model) errors.push("accepter_model is required for accepted status");
    if (!artifact.accepter_session_id) errors.push("accepter_session_id is required for accepted status");
  }

  // test_evidence_ids and reviewer_evidence_ids must be arrays
  if (artifact.test_evidence_ids !== undefined && !Array.isArray(artifact.test_evidence_ids)) {
    errors.push("test_evidence_ids must be an array");
  }
  if (artifact.reviewer_evidence_ids !== undefined && !Array.isArray(artifact.reviewer_evidence_ids)) {
    errors.push("reviewer_evidence_ids must be an array");
  }

  // conditions and unresolved_risks must be arrays
  if (artifact.conditions !== undefined && !Array.isArray(artifact.conditions)) {
    errors.push("conditions must be an array");
  }
  if (artifact.unresolved_risks !== undefined && !Array.isArray(artifact.unresolved_risks)) {
    errors.push("unresolved_risks must be an array");
  }

  return errors;
}

/**
 * Assert that an acceptance artifact passes schema validation.  Throws on
 * the first validation error, or a summary if multiple.
 */
export function assertAcceptanceArtifactValid(artifact) {
  const errors = validateAcceptanceArtifactSchema(artifact);
  if (errors.length > 0) {
    throw new Error(`Acceptance artifact validation failed:\n  ${errors.join("\n  ")}`);
  }
}

/**
 * Validate an acceptance artifact against the current patch and contract.
 * Checks:
 *  - Artifact exists and parses as JSON
 *  - Schema validation passes
 *  - contract_id / version / digest match the current contract
 *  - patch_digest matches the current evidence patch digest
 *  - status is "accepted"
 *  - artifact is not stale (patch_digest matches current)
 */
export async function validateAcceptanceForCurrentPatch({ artifactPath, contract, currentPatchDigest }) {
  let artifact;
  try {
    artifact = await readJson(artifactPath);
  } catch (err) {
    throw new Error(`Cannot read acceptance artifact at ${artifactPath}: ${err.message}`);
  }

  // Schema validation
  assertAcceptanceArtifactValid(artifact);

  // Status must be accepted for apply
  if (artifact.status !== ACCEPTANCE_STATUS.ACCEPTED) {
    throw new Error(`Acceptance artifact has status "${artifact.status}"; only "accepted" may proceed to apply.`);
  }

  // Contract provenance must match
  if (artifact.contract_id !== getContractId(contract)) {
    throw new Error(`Acceptance artifact contract_id mismatch: artifact="${artifact.contract_id}" != current="${getContractId(contract)}". Re-accept after contract update.`);
  }
  if (artifact.contract_version !== getContractVersion(contract)) {
    throw new Error(`Acceptance artifact contract_version mismatch: artifact="${artifact.contract_version}" != current="${getContractVersion(contract)}". Re-accept after contract update.`);
  }
  if (artifact.contract_digest !== getContractDigest(contract)) {
    throw new Error(`Acceptance artifact contract_digest mismatch. Re-accept after contract update.`);
  }

  // Patch digest must match the current evidence
  if (currentPatchDigest && artifact.patch_digest !== currentPatchDigest) {
    throw new Error(`Acceptance artifact patch_digest mismatch: artifact="${artifact.patch_digest}" != current="${currentPatchDigest}". Re-accept after implementation update.`);
  }

  return artifact;
}

/**
 * Persist a full-provenance acceptance artifact to disk and update the job.
 *
 * @param {object} options
 * @param {string} options.jobDir - directory to write into (this.store.jobDir(job.id))
 * @param {object} options.job - the job being accepted
 * @param {object} options.contract - the current Planner contract
 * @param {object} options.evidence - the execution evidence JSON
 * @param {string} options.patchDigest - patch digest
 * @param {object|null} options.verification - AGY verify evidence (optional)
 * @param {string} options.decision - "accepted" or "rejected"
 * @param {string} options.accepterHost - host provider ("codex", "cc_desktop", etc.)
 * @param {string} options.accepterProvider - provider name
 * @param {string} options.accepterModel - model used for acceptance
 * @param {string} options.accepterSessionId - session ID of the accepter
 * @param {string} options.summary - human-readable acceptance summary
 * @param {string[]} options.conditions - conditions attached to acceptance
 * @param {string[]} options.unresolvedRisks - risks not mitigated
 * @param {function} options.updateJob - async function to update the job record
 * @returns {Promise<object>} the persisted artifact
 */
export async function saveAcceptance({
  jobDir,
  job,
  contract,
  evidence,
  patchDigest,
  verification = null,
  decision = "accepted",
  accepterHost = "unknown",
  accepterProvider = null,
  accepterModel = null,
  accepterSessionId = null,
  summary = "",
  conditions = [],
  unresolvedRisks = [],
  updateJob = null,
}) {
  const status = decision === "rejected" ? ACCEPTANCE_STATUS.REJECTED : ACCEPTANCE_STATUS.ACCEPTED;

  // Gather test evidence IDs from the implementation evidence
  const testEvidenceIds = [];
  if (evidence.verification?.results) {
    for (const r of evidence.verification.results) {
      if (r.evidence_id) testEvidenceIds.push(r.evidence_id);
    }
  }

  // Gather reviewer evidence IDs
  const reviewerEvidenceIds = [];
  if (verification?.id) reviewerEvidenceIds.push(verification.id);
  if (verification?.evidence_path) reviewerEvidenceIds.push(verification.evidence_path);

  // Build workspace identity from the execution workspace
  const workspaceIdentity = evidence.workspace
    ? { mode: evidence.workspace.mode || "isolated", path: evidence.workspace.path || null }
    : null;

  const artifact = {
    acceptance_id: newId("accept"),
    task_id: job.task_id,
    job_id: job.id,
    contract_id: getContractId(contract),
    contract_version: getContractVersion(contract),
    contract_digest: getContractDigest(contract),
    patch_digest: patchDigest,
    test_evidence_ids: testEvidenceIds,
    reviewer_evidence_ids: reviewerEvidenceIds,
    repository_identity: contract?.repository_identity || null,
    workspace_identity: workspaceIdentity,
    accepter_host: accepterHost,
    accepter_provider: accepterProvider,
    accepter_model: accepterModel,
    accepter_session_id: accepterSessionId,
    status,
    summary: summary || `Accepted by ${accepterHost}`,
    conditions: Array.isArray(conditions) ? conditions : [],
    unresolved_risks: Array.isArray(unresolvedRisks) ? unresolvedRisks : [],
    created_at: nowIso(),
  };

  // Validate BEFORE persisting — fail closed.
  assertAcceptanceArtifactValid(artifact);

  const artifactPath = path.join(jobDir, "acceptance.json");
  await writeJsonAtomic(artifactPath, artifact);

  if (updateJob) {
    await updateJob({
      acceptance_artifact_path: artifactPath,
      acceptance_status: artifact.status,
      acceptance_patch_digest: patchDigest,
    });
  }

  return artifact;
}

/**
 * Read an acceptance artifact from disk.
 * Returns null if the file does not exist or cannot be parsed.
 */
export async function loadAcceptance(artifactPath) {
  if (!artifactPath) return null;
  try {
    return await readJson(artifactPath);
  } catch {
    return null;
  }
}

/**
 * Mark a job's acceptance as invalidated/stale by clearing the artifact
 * references on the job record and writing a sentinel artifact if desired.
 * This is called when a continuation produces a new patch digest.
 */
export async function invalidateAcceptance({ store, projectDir, taskId, currentPatchDigest }) {
  if (!currentPatchDigest) return;
  const allJobs = await store.listJobs();
  for (const j of allJobs) {
    if (j.project_dir !== projectDir || j.task_id !== taskId) continue;
    if (!j.id) continue;

    // Only invalidate jobs whose acceptance patch digest differs from current.
    const staleAcceptance = j.acceptance_artifact_path && j.acceptance_patch_digest && j.acceptance_patch_digest !== currentPatchDigest;
    const staleReview = j.reviewer_job_id || j.agy_verify_job_id;

    if (staleAcceptance || staleReview) {
      const updates = {};
      if (staleAcceptance) {
        updates.acceptance_artifact_path = null;
        updates.acceptance_status = null;
        updates.acceptance_patch_digest = null;
      }
      if (staleReview) {
        updates.agy_verify_job_id = null;
        updates.agy_verify_evidence_path = null;
        updates.reviewer_job_id = null;
        updates.reviewer_evidence_path = null;
      }
      await store.updateJob(j.id, updates).catch(() => {});
    }
  }
}
