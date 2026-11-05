import path from 'node:path';
import fs from 'node:fs/promises';
import { git, json, save, digest, canonicalPath } from './lifecycle-git.mjs';

export async function semanticIndex(project) {
  return { entries: await git(project,['ls-files','--stage','-z']), flags: await git(project,['ls-files','-v','-z']) };
}
export async function preservedIndex(project, paths) {
  const names=new Set(paths),raw=await git(project,['ls-files','--stage','-z']);
  const lines=raw.split('\0').filter(line=>names.has(line.slice(line.indexOf('\t')+1)));
  return lines.length?lines.join('\0')+'\0':'';
}
export async function baselineFields(project,current) {
  return { head:current.head,branch:current.branch,files_digest:digest(current.files),semantic_index:await semanticIndex(project) };
}
export async function preservedUnchanged(project,ready,current) {
  if (!ready?.preserved_states || current.changes.some(c=>!ready.preserved.includes(c.path))) return false;
  for (const [name,state] of Object.entries(ready.preserved_states)) if (JSON.stringify(state)!==JSON.stringify(current.files[name] || null)) return false;
  return await preservedIndex(project,ready.preserved)===ready.preserved_index;
}
async function verifiedEdges(project,current) {
  const root=path.join(project,'.agent-orchestrator/runs'),edges=[];
  for (const dir of await fs.readdir(root,{withFileTypes:true}).catch(()=>[])) {
    if(!dir.isDirectory()) continue;
    const directory=path.join(root,dir.name),job=await json(path.join(directory,'job.json'));
    if(!job?.acceptance_artifact_path || job.manual_commit_recorded) continue;
    const acceptance=await json(job.acceptance_artifact_path);
    if(acceptance?.status!=='accepted' || acceptance.contract_digest!==job.contract_digest) continue;
    for (const file of await fs.readdir(path.join(directory,'git-operations')).catch(()=>[])) {
      if(!file.endsWith('.json')) continue;
      const operation=await json(path.join(directory,'git-operations',file));
      if(operation?.kind!=='delivery.committed' || operation.status!=='completed' || !operation.before_head || !operation.after_head || operation.before_head===operation.after_head) continue;
      if(await canonicalPath(operation.repository_common_dir)!==await canonicalPath(current.common)) continue;
      const proof=await json(path.join(directory,'task-delivery.json'));
      const intent=await json(path.join(directory,'finalization/commit-intent.json'));
      const expectedTree=proof?.commit_id===operation.after_head ? proof.tree_id : intent?.status==='committed' && intent.commit===operation.after_head ? intent.tree : null;
      if(!expectedTree || await git(project,['rev-parse',operation.after_head+'^{tree}'],{allowFailure:true})!==expectedTree) continue;
      if(proof && (proof.job_id!==job.id || proof.task_id!==job.task_id || proof.contract_digest!==job.contract_digest
        || proof.ref!==`refs/agent-orch/deliveries/${job.id}` || await canonicalPath(proof.repository_common)!==await canonicalPath(current.common)
        || await git(project,['rev-parse','--verify',proof.ref],{allowFailure:true})!==proof.commit_id
        || digest(await fs.readFile(job.acceptance_artifact_path))!==proof.acceptance_sha256 || acceptance.patch_digest!==proof.patch_digest
        || digest(await fs.readFile(job.evidence_path))!==proof.evidence_sha256 || digest(await fs.readFile(job.patch_path))!==proof.patch_digest)) continue;
      if(await git(project,['merge-base','--is-ancestor',operation.before_head,operation.after_head],{allowFailure:true})===null) continue;
      edges.push({before:operation.before_head,after:operation.after_head,id:operation.operation_id,
        files_digest:operation.after_files_digest || (intent?.working_files ? digest(intent.working_files):null)});
    }
  }
  return edges;
}
// Never refresh an arbitrary fingerprint. A head transition must be backed by
// exact accepted delivery receipts, disjoint preserved paths and actual content.
export async function carryVerifiedBaseline(project,current,{allowAdvance=true}={}) {
  const file=path.join(project,'.agent-orchestrator/environment/readiness.json'),ready=await json(file);
  if(!ready || !['head','snapshot'].includes(ready.baseline) || !ready.head || ready.branch!==current.branch || !await preservedUnchanged(project,ready,current)) return false;
  if(ready.head===current.head) {
    if(ready.files_digest!==digest(current.files) || JSON.stringify(ready.semantic_index)!==JSON.stringify(await semanticIndex(project))) return false;
  } else {
    if(!allowAdvance || ready.baseline!=='head') return false;
    const changed=(await git(project,['diff','--no-renames','--name-only','-z',ready.head,current.head])).split('\0').filter(Boolean);
    if(changed.some(p=>ready.preserved.includes(p))) return false;
    const semantic=await semanticIndex(project),delta=new Set(changed);
    const outside=(raw,entry)=>raw.split('\0').filter(Boolean).filter(line=>!delta.has(entry?line.slice(line.indexOf('\t')+1):line.slice(2))).join('\0');
    if(!ready.semantic_index || outside(semantic.entries,true)!==outside(ready.semantic_index.entries,true)
      || outside(semantic.flags,false)!==outside(ready.semantic_index.flags,false)) return false;
    const edges=await verifiedEdges(project,current),used=[],seen=new Set();let head=current.head;
    while(head!==ready.head) {
      if(seen.has(head)) return false;seen.add(head);
      const edge=edges.find(e=>e.after===head);
      if(!edge) return false;
      if(!used.length && edge.files_digest!==digest(current.files)) return false;
      used.push(edge.id);head=edge.before;
    }
    ready.verified_delivery_ids=[...(ready.verified_delivery_ids || []),...used.reverse()];
  }
  Object.assign(ready,await baselineFields(project,current),{previous_fingerprint:ready.fingerprint,fingerprint:current.fingerprint,carried_at:new Date().toISOString()});
  await save(file,ready);return true;
}
export async function baselineDrift(project,current) {
  const ready=await json(path.join(project,'.agent-orchestrator/environment/readiness.json'));
  const changed=current.changes.filter(c=>!ready?.preserved?.includes(c.path)).map(c=>c.path);
  const info={head_changed:ready?.head!==current.head,branch_changed:ready?.branch!==current.branch,
    unknown_path_count:changed.length,unknown_paths_preview:changed.slice(0,8),preserved_path_count:ready?.preserved?.length || 0,
    current_fingerprint:current.fingerprint,approved_fingerprint:ready?.fingerprint || null};
  const file=path.join(project,'.agent-orchestrator/environment/drift',digest(info)+'.json');await save(file,info);
  return {...info,evidence_path:file};
}
