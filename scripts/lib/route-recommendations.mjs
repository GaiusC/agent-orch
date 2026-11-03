// Recommend from the discovered catalog, never from a pinned release's model ids.
const TIERS = ['low', 'medium', 'high'];
const version = (entry, family) => {
  const text = `${entry.id} ${entry.label || ''}`;
  const prefix = family === 'sonnet' ? /claude[-\s]+sonnet[-\s]+(\d+(?:[.-]\d+)*)/i
    : family === 'gemini' ? /gemini[-\s]+(\d+(?:[.-]\d+)*)/i : /gpt[-\s]+(\d+(?:[.-]\d+)*)/i;
  return text.match(prefix)?.[1].split(/[.-]/).map(Number) || [];
};
const compare = (a, b) => {
  for (let n=0;n<Math.max(a.length,b.length);n++) if ((a[n] || 0)!==(b[n] || 0)) return (b[n] || 0)-(a[n] || 0);
  return 0;
};
const highVariant = entry => /(?:[-\s(])high(?:\)|\s|$)/i.test(`${entry.id} ${entry.label || ''}`);
const ordered = (entries, family) => entries.filter(entry=>version(entry,family).length)
  .sort((a,b)=>compare(version(a,family),version(b,family)) || a.id.localeCompare(b.id));

export function recommendRoutes(catalog, {hostModel=null, reviewFailures=2}={}) {
  const warnings=[...(catalog.warnings || [])], missing=[];
  const codex=catalog.providers.codex || [], agy=catalog.providers.agy || [];
  if (catalog.availability?.codex===false) missing.push('Codex CLI executable');
  const familyTie=entry=>/(?:^|[-\s])sol(?:\s|$)/i.test(`${entry.id} ${entry.label || ''}`)?0
    : /(?:^|[-\s])terra(?:\s|$)/i.test(`${entry.id} ${entry.label || ''}`)?1:2;
  const candidates=[...new Map(codex.map(entry=>[entry.id,entry])).values()].filter(entry=>version(entry,'codex').length)
    .sort((a,b)=>compare(version(a,'codex'),version(b,'codex')) ||
      ((a.priority ?? Infinity)-(b.priority ?? Infinity) || familyTie(a)-familyTie(b) || a.id.localeCompare(b.id)));
  const primary=candidates[0],secondary=candidates[1];
  const sonnet=ordered(agy.filter(e=>/sonnet/i.test(`${e.id} ${e.label || ''}`) && highVariant(e)), 'sonnet')[0];
  const gemini=ordered(agy.filter(e=>/gemini/i.test(`${e.id} ${e.label || ''}`) && highVariant(e)), 'gemini');
  const newest=gemini[0], previous=gemini.find(e=>compare(version(e,'gemini'),version(newest || e,'gemini'))!==0);
  for (const [name,entry] of [['current host model',hostModel],['latest Worker model',primary],['lower-ranked Worker model',secondary],['Sonnet High',sonnet],['latest Gemini High',newest],['previous Gemini High',previous]]) if (!entry) missing.push(name);
  for (const [entry,effort] of [[secondary,'medium'],[primary,'medium'],[primary,'high']]) {
    if (entry?.reasoning_efforts?.length && !entry.reasoning_efforts.includes(effort)) missing.push(`${entry.id} reasoning ${effort}`);
  }
  const work=(entry,effort)=>({provider:'codex_worker',model:entry?.id || null,reasoning_effort:effort,service_tier:null});
  const review=entry=>({provider:'agy',model:entry?.id || null});
  const selection={
    plan:{provider:'codex',model:hostModel},
    work:{default_complexity:'medium',routes:{low:[work(secondary,'medium')],medium:[work(primary,'medium')],high:[work(primary,'high')]},
      escalation:{enabled:true,review_failures_before_upgrade:reviewFailures}},
    review:{default_complexity:'medium',routes:{low:[review(previous)],medium:[review(newest),review(previous)],high:[review(sonnet),review(newest),review(previous)]},quota_fallback:true},
    accept:{inherit_from:'plan'},
  };
  warnings.push('Newest is inferred from versioned model names and advertised priority; it is not proof of release dates, price or quality. Unversioned Worker models require customization.');
  return {available:missing.length===0,selection,missing,warnings,catalog_fetched_at:catalog.fetched_at || null,
    choices:['use_recommended','edit_recommended','custom'],
    rationale:{worker:'Newest versioned generation and advertised priority for medium/high; next ranked candidate for low. Known Sol/Terra names only break ties when priority is absent. Medium/medium/high reasoning.',reviewer:'Newest Sonnet High, newest Gemini High, previous Gemini generation High; quota-only downward fallback.',plan_accept:'Exact current host identity; no external planner or accepter.'}};
}

export function validateRoutingPolicies(stages) {
  const escalation=stages.work.escalation;
  if (escalation) {
    if (typeof escalation.enabled!=='boolean' || !Number.isInteger(escalation.review_failures_before_upgrade) || escalation.review_failures_before_upgrade<1 || escalation.review_failures_before_upgrade>10) throw new Error('Invalid Worker escalation policy');
    if (escalation.enabled && TIERS.some(tier=>stages.work.routes[tier].length!==1 || stages.work.routes[tier][0].provider!=='codex_worker')) throw new Error('Complexity escalation requires exactly one Codex Worker route per tier');
  }
  if (stages.review.quota_fallback!==undefined && typeof stages.review.quota_fallback!=='boolean') throw new Error('Invalid reviewer quota fallback policy');
  if (TIERS.some(tier=>stages.review.routes[tier].length>1) && stages.review.quota_fallback!==true) throw new Error('Multiple review routes require quota_fallback=true');
}

export function workRouteChain(config, tier) {
  const stage=config.stages.work, from=TIERS.indexOf(tier==='mid'?'medium':tier);
  if (from<0) throw new Error('Invalid work complexity');
  const levels=stage.escalation?.enabled ? TIERS.slice(from) : [TIERS[from]];
  return levels.flatMap(level=>stage.routes[level].map(route=>({...route,effective_complexity:level})));
}

export function reviewUpgrade(jobs, {projectDir,taskId,subtaskId,contractDigest,baseTier,threshold}) {
  const implementations=jobs.filter(j=>j.project_dir===projectDir && j.task_id===taskId && j.subtask_id===subtaskId && j.contract_digest===contractDigest && ['stage_work','stage_work_continue'].includes(j.type))
    .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  const latest=implementations[0];
  if (!latest) return {tier:baseTier};
  const tier=latest.effective_complexity || latest.complexity || baseTier;
  // Count actual negative verdicts, not missing output, auth failures or quota.
  const reviews=jobs.filter(j=>j.project_dir===projectDir && j.task_id===taskId && j.type==='agy_review' && j.implementation_job_id && implementations.some(w=>w.id===j.implementation_job_id && (w.effective_complexity || w.complexity)===tier))
    .sort((a,b)=>String(b.finished_at || b.created_at).localeCompare(String(a.finished_at || a.created_at)));
  let failures=0;
  for (const review of reviews) {
    if (review.status==='completed') break;
    if (review.status==='failed' && /^(?:Error: )?AGY_REVIEW_REJECTED: FAIL\b/.test(review.error || '')) failures++;
  }
  if (failures<threshold) return {tier};
  const index=TIERS.indexOf(tier);
  if (index===2) throw new Error('work_complexity_exhausted: high-level review failure budget exhausted; inspect evidence before a new Plan');
  return {tier:TIERS[index+1],previous:latest,reason:'repeated_review_failures'};
}
