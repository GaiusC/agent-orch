import {layoutGraph} from './graph.js';
import {t, locale, getLanguage, setLanguage, translateStatic} from './i18n.js';

const $=id=>document.getElementById(id);
const colors=['#8baded','#bba6e5','#83bfa7','#d4b981','#ce9fb6','#80bdc9','#a5b2d0','#b4be90'];
const stateNames=new Proxy({planned:'待执行',partial:'部分已执行',binding_unknown:'关联待确认',running:'执行中',failed:'执行异常',cancelled:'已取消',awaiting_review:'待审查',awaiting_acceptance:'待验收',reviewed:'审查通过',accepted:'已验收',applied:'已应用',delivered:'已交付',completed:'已结束',queued:'等待中',unknown:'状态未记录'}, {get:(values,key)=>t(values[key])});
const roleNames=new Proxy({git:'Git',work:'执行',review:'审查',plan:'计划',accept:'验收',apply:'应用',commit:'提交',integration:'集成',execution:'执行记录',stage:'阶段'}, {get:(values,key)=>t(values[key])});
let workspace=null,gitData=null,mode='plans',selectedPlan=null,selectedHash=null,chartMode='timeline',planLimit=40,gitLimit=150,requestSequence=0,detailSequence=0,gitBusy=false;
let activeDetail=null,catalogSnapshot=null,homeFeedbackKey='';
const commitContent=new Map(),jobContent=new Map();
const ns='http://www.w3.org/2000/svg';
const element=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const svg=(tag,attrs={})=>{const n=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,v));return n;};
function time(value){if(!value)return null;const t=new Date(value).getTime();return Number.isFinite(t)?t:null;}
function date(value,clock=false){const stamp=time(value);return stamp===null?t('时间未记录'):new Date(stamp).toLocaleString(locale(),clock?{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}:{year:'numeric',month:'2-digit',day:'2-digit'});}
function duration(start,end){const a=time(start),b=time(end);if(a===null||b===null||b<a)return t('时长未记录');const sec=(b-a)/1000;return sec<60?t("{p0} 秒", {p0:(Math.max(1,Math.round(sec)))}):sec<3600?t("{p0} 分钟", {p0:(Math.round(sec/60))}):t("{p0} 小时", {p0:((sec/3600).toFixed(1))});}
function status(value,label){return element('span',`status ${value||'unknown'}`,label||stateNames[value]||value||t('状态未记录'));}
function button(text,action,cls=''){const n=element('button',cls,text);n.type='button';n.addEventListener('click',action);return n;}
function api(route,params={}){const url=new URL(route,location.origin),context=new URLSearchParams(location.search);for(const key of ['project','thread'])if(context.has(key))url.searchParams.set(key,context.get(key));for(const [k,v]of Object.entries(params))url.searchParams.set(k,v);return url.pathname+url.search;}
async function request(route,params={}){const res=await fetch(api(route,params),{signal:AbortSignal.timeout(45000)});const data=await res.json();if(!res.ok||data.error)throw new Error(t(data.error)||`HTTP ${res.status}`);return data;}
function notice(message){$('notice').hidden=!message;$('notice').textContent=message||'';}
function currentPlan(){return workspace?.plans.find(p=>p.id===selectedPlan);}
function planTitle(plan){return (plan.type==='unassigned'?t(plan.title):plan.title).replace(/[-_]20\d{6}(?:[-T]\d{6}Z?)?$/i,'').replace(/[-_]+/g,' ');}
function eventTitle(event){return event.kind==='git'||(!event.id.startsWith('job:')&&['plan','accept','apply','commit'].includes(event.kind))?t(event.title||''):event.title;}
function selectedJob(id){return workspace?.plans.flatMap(p=>p.jobs).find(j=>j.id===id);}
function mainContent(){const main=$('main');main.replaceChildren(button(t('← 返回历史'),()=>{$('layout').classList.remove('show-detail');},'mobile-back'));return main;}
function heading(main,eyebrow,title,state){main.append(element('div','breadcrumb',eyebrow));const row=element('div','main-heading');row.append(element('h1','',title));if(state)row.append(status(state));main.append(row);}
function reveal(){ $('layout').classList.add('show-detail');$('main').scrollTop=0; }
function snapshotTime(value){$('snapshotTime').textContent=t("快照 {p0}", {p0:(new Date(value||Date.now()).toLocaleTimeString(locale(),{hour12:false}))});}

function renderWorkspaceHeader(){
  if(!workspace)return;const root=workspace.git.repository||workspace.project_dir;
  $('projectButton').textContent=root.replaceAll('\\','/').split('/').filter(Boolean).pop()+'  ⌄';$('projectButton').title=workspace.project_dir;
  const status=workspace.git.status||{};$('branchSummary').textContent=status.branch?t('⑂ {p0}  ·  {p1} 个工作区改动',{p0:status.branch,p1:status.files?.length||0}):t('非 Git 工作区');
  document.title=`${$('projectButton').textContent.replace('  ⌄','')} · Agent Orch Auditor`;
}
async function refresh(){
  const own=++requestSequence;$('refreshButton').disabled=true;notice('');
  try{
    const next=await request('/api/workspace');if(own!==requestSequence)return;
    workspace=next;
    if(!workspace.plans.some(p=>p.id===selectedPlan))selectedPlan=workspace.plans[0]?.id||null;
    renderWorkspaceHeader();snapshotTime(next.generated_at);
    const unreadable=next.warnings.filter(w=>!w.message.includes('没有唯一计划归属'));
    if(unreadable.length)notice(t("{p0} 条记录暂不可读；可在计划的原始信息中检查。", {p0:(unreadable.length)}));
    if(mode==='git'){await loadGit();}else{renderPlans();renderPlan();}
  }catch(error){if(own===requestSequence)notice(`${error.message}${workspace?t(' · 保留上次快照，请手动重试。'):''}`);}
  finally{if(own===requestSequence)$('refreshButton').disabled=false;}
}

function setMode(next){
  mode=next;$('plansTab').setAttribute('aria-selected',String(next==='plans'));$('gitTab').setAttribute('aria-selected',String(next==='git'));$('gitControls').hidden=next!=='git';
  if(next==='git'){if(gitData){renderGit();renderCommit();snapshotTime(gitData.generated_at);}else loadGit();}else{renderPlans();renderPlan();if(workspace)snapshotTime(workspace.generated_at);}
}

function renderPlans(){
  if(!workspace)return;
  $('historySummary').textContent=t("{p0} 项计划 · {p1} 条执行记录", {p0:(workspace.counts.plans), p1:(workspace.counts.jobs)});
  const list=$('historyList'),frag=document.createDocumentFragment();list.className='history-list';let group='';
  for(const p of workspace.plans.slice(0,planLimit)){
    const day=date(p.created_at);if(day!==group){frag.append(element('div','date-group',day));group=day;}
    const row=button('',()=>{selectedPlan=p.id;chartMode='timeline';renderPlans();renderPlan();reveal();},`plan-row${p.id===selectedPlan?' selected':''}`);row.title=p.title;
    row.setAttribute('aria-pressed',String(p.id===selectedPlan));row.dataset.planId=p.id;
    row.append(element('span',`plan-node ${p.state}`));const content=element('span','');content.append(element('span','plan-title',planTitle(p)));
    const meta=element('span','plan-meta');meta.append(status(p.state),element('span','',t("{p0} 任务 · {p1} 记录", {p0:(p.task_count), p1:(p.job_count)})));content.append(meta);const gitSummary=planGitSummary(p);if(gitSummary)content.append(element('span','plan-git-summary',gitSummary));row.append(content);frag.append(row);
    if(p.id===selectedPlan&&p.tasks.length>1){const children=element('div','subtask-nav');for(const task of p.tasks){children.append(button(task.id,()=>{renderPlan();reveal();$('main').querySelector('[data-section="records"]')?.scrollIntoView({block:'start'});}));}frag.append(children);}
  }
  if(workspace.plans.length>planLimit)frag.append(button(t('加载更早的计划'),()=>{planLimit+=40;renderPlans();},'load-more'));
  if(!workspace.plans.length)frag.append(element('div','empty',workspace.orchestrator_dir?t('还没有登记计划或执行记录。'):t('此项目没有 Agent Orch 记录。可以切换到 Git 历史查看仓库。')));
  list.replaceChildren(frag);
}

function planGitSummary(plan){
  const ops=plan.git_activity||[],commits=plan.delivery.commits.length;
  const blocked=ops.some(e=>e.git_kind==='workspace.cleanup_blocked')&&!ops.some(e=>e.git_kind==='workspace.cleaned'&&time(e.start)>Math.max(...ops.filter(e=>e.git_kind==='workspace.cleanup_blocked').map(e=>time(e.start)||0)));
  return [commits?t("{p0} 个交付提交", {p0:(commits)}):'',blocked?t('清理受阻'):plan.delivery.commits.some(d=>d.cleanup_pending)?t('待清理'):'',ops.length&&!commits?t("{p0} 条 Git 记录", {p0:(ops.length)}):''].filter(Boolean).join(' · ');
}
function commitRelations(hash){
  const explicit=workspace?.commit_links?.[hash];
  return explicit||workspace?.plans.filter(p=>p.delivery.commits.some(d=>d.commit_id===hash)).map(p=>({plan_id:p.id,label:t('交付提交'),relation:'delivery'}))||[];
}
function deliveryText(delivery){const s=delivery?.state;return s==='committed'?t('已提交'):s==='other_branch'?t('提交在其他分支'):s==='partial'?t('部分提交已关联'):s==='missing'?t('提交对象缺失'):s==='invalid'?t('提交标识无效'):s==='unverifiable'?t('提交尚无法核实'):t('提交未关联');}
function addDelivery(target,plan){
  const item=element('div','delivery');item.append(element('span','',deliveryText(plan.delivery)));
  for(const d of plan.delivery.commits){item.append(button(d.commit_id.slice(0,7),()=>selectCommit(d.commit_id),'text-button'));if(d.cleanup_pending)item.append(element('span','warning-text',t('待清理')));}
  target.append(item);
}
function section(title,meta=''){const header=element('div','section-heading'),left=element('div','');left.append(element('h2','',title));if(meta)left.append(element('span','section-meta',meta));header.append(left);return header;}
function factList(values){const dl=element('dl','facts');for(const [key,value]of values){dl.append(element('dt','',key),element('dd','',value===undefined||value===null||value===''?t('未记录'):String(value)));}return dl;}
function disclosure(title,text){const d=element('details','');d.append(element('summary','',title),element('pre','',typeof text==='string'?text:JSON.stringify(text,null,2)));return d;}

function renderPlan(){
  const main=mainContent(),p=currentPlan();
  if(!p){heading(main,'WORKSPACE',t('选择一项计划'));main.append(element('p','description',t('计划历史保留执行、审查和交付的完整记录。')));return;}
  heading(main,(p.type==='unassigned'?t('历史记录 / '):t('计划 / '))+date(p.created_at),planTitle(p),p.state);
  if(p.description&&!p.description.startsWith('Formal plan for task '))main.append(element('p','description',p.description));
  const summary=element('div','summary-strip');for(const [n,label]of [[p.task_count,t('任务')],[p.job_count,t('执行记录')],[p.failure_count,t('历史失败')]]){const item=element('span','');item.append(element('strong','',String(n)),document.createTextNode(label));summary.append(item);}addDelivery(summary,p);main.append(summary);
  const sh=section(t('计划执行图'),t('基于已记录的发生时间'));const tabs=element('div','chart-tabs');for(const [id,label]of [['timeline',t('执行过程')],['dependencies',t('依赖关系')]])tabs.append(button(label,()=>{chartMode=id;renderPlan();},id===chartMode?'active':''));sh.append(tabs);main.append(sh);
  const container=element('div','chart-container');container.append(chartMode==='timeline'?timeline(p):dependencyGraph(p));main.append(container);
  const note=element('div','chart-note');
  if(chartMode==='timeline'){note.append(element('span','', t('横轴：实际时间 · 泳道：执行单元')),element('span','', t('虚线：执行关联 · 点击节点查看记录')));}
  else{const deps=p.graph.edges.filter(e=>e.kind==='dependency').length;note.append(element('span','',t("{p0} 条执行依赖 · 实线箭头", {p0:(deps)})),element('span','',t('虚线箭头：审查对象')));if(!deps)note.append(element('span','',t('未登记执行依赖，不推断先后约束。')));}
  main.append(note);
  const recordsHeader=section(t('执行与阶段记录'),t("{p0} 条 · 按发生时间排列", {p0:(p.events.length)}));recordsHeader.dataset.section='records';main.append(recordsHeader);
  const records=element('div','record-list');
  for(const event of p.events){
    const job=event.job_id&&selectedJob(event.job_id);const row=button('',()=>openEvent(event),'record-row');row.dataset.eventId=event.id;if(event.kind==='git')row.classList.add('git-record');
    row.append(element('span','record-icon',({git:'⑂',work:'↗',review:'◇',plan:'○',accept:'✓',apply:'↳',commit:'●',integration:'⑂'})[event.kind]||'·'));
    const text=element('div','');text.append(element('div','record-title',`${roleNames[event.kind]||event.kind} · ${eventTitle(event)||t('未命名记录')}`));
    const meta=element('div','record-meta');meta.append(element('span','',date(event.start,true)));if(event.provider)meta.append(element('span','',event.provider));if(event.kind==='git'){if(job)meta.append(element('span','',job.subtask_id||job.review_id||job.id));if(event.operation?.related_job_ids?.length)meta.append(element('span','',t("{p0} 次执行共用", {p0:(event.operation.related_job_ids.length+1)})));if(event.commit_id)meta.append(element('span','git-fact-summary',event.commit_id.slice(0,8)));meta.append(element('span','',event.operation?.provenance==='legacy-fields'?t('历史证据'):t('操作回执')));if(event.operation?.recovered)meta.append(element('span','',t('恢复记录')));}
    if(event.continued_from)meta.append(element('span','',t('续跑自 ')+event.continued_from));if(job?.contract_current===false)meta.append(element('span','',t('历史 Contract 版本')));if(job?.review?.verdict)meta.append(element('span','',t("结论 {p0}{p1}", {p0:(job.review.verdict), p1:(job.review.binding_current?t(' · 当前补丁绑定匹配'):t(' · 当前补丁绑定未确认'))})));
    text.append(meta);const end=element('div','record-end');end.append(status(event.status),element('span','',event.kind==='git'?(event.start?t('Git 操作'):t('时间未记录')):duration(event.start,event.end)));row.append(text,end);records.append(row);
  }
  if(!p.events.length)records.append(element('p','empty',t('计划已登记，还没有执行记录。')));main.append(records);
  const deliverySection=section(t('交付关联'));main.append(deliverySection);const delivery=element('div','subtle-note');addDelivery(delivery,p);
  if(!p.delivery.commits.length)delivery.append(element('p','',t('没有可靠的提交映射。此状态不代表代码一定没有提交。')));
  for(const d of p.delivery.commits)delivery.append(element('p','',`${d.commit_id} · ${deliveryText(d)}${d.cleanup_pending?t(' · 清理记录待完成'):''}`));main.append(delivery);
  const raw=element('details','');raw.append(element('summary','',t('计划与 Contract 原始信息')));raw.append(factList([['Plan ID',p.id],[t('类型'),p.type],[t('时间来源'),p.time_source],[t('目录'),workspace.project_dir],[t('来源'),p.source_file]]));
  for(const task of p.tasks)raw.append(disclosure(`${task.id} · Contract ${task.contract_version||'?'}`,task));
  if(p.stages.length)raw.append(disclosure(t("StageRun 原始记录 · {p0} 条", {p0:(p.stages.length)}),p.stages));
  const warnings=workspace.warnings.filter(w=>p.tasks.some(t=>t.source_file===w.file)||p.stages.some(s=>s.source_file===w.file));if(warnings.length)raw.append(disclosure(t('待确认记录'),warnings));main.append(raw);
}

function bindNode(node,fn){node.setAttribute('role','button');node.setAttribute('tabindex','0');node.addEventListener('click',fn);node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fn();}});}
function eventColor(event){return event.status==='failed'?'var(--red)':event.status==='running'?'var(--accent)':event.status==='queued'?'var(--amber)':event.status==='completed'?(event.kind==='git'?'var(--purple)':'var(--green)'):'var(--quiet)';}
function timeline(plan){
  const valid=plan.events.filter(e=>time(e.start)!==null);if(!valid.length)return element('div','empty',t('没有可定位的事件时间；原始记录保留在下方。'));
  const lanes=[],laneKey=e=>e.kind==='git'?e.unit_id:`${e.task_id||''}/${e.kind}/${e.unit_id}`;for(const e of [...valid.filter(e=>e.kind!=='git'),...valid.filter(e=>e.kind==='git')])if(!lanes.includes(laneKey(e)))lanes.push(laneKey(e));
  const styles=getComputedStyle($('main')),width=Math.max(360,$('main').clientWidth-(parseFloat(styles.paddingLeft)||0)-(parseFloat(styles.paddingRight)||0)),left=Math.min(170,width*.31),right=18,top=54,row=58,height=top+lanes.length*row+25,ticks=width-left-right<360?2:4;
  const start=Math.min(...valid.map(e=>time(e.start))),rawEnd=Math.max(...valid.map(e=>time(e.end)??time(e.start))),end=Math.max(start+60000,rawEnd);
  const x=t=>left+(t-start)/(end-start)*(width-left-right),y=e=>top+lanes.indexOf(laneKey(e))*row+24;
  const chart=svg('svg',{viewBox:`0 0 ${width} ${height}`,class:'execution-chart',role:'img','aria-label':t('计划执行时间轴，点击事件可查看详情')});
  for(let i=0;i<=ticks;i++){const t=start+(end-start)*i/ticks,px=x(t);chart.append(svg('line',{x1:px,x2:px,y1:39,y2:height-12,stroke:'var(--grid)'}));const label=svg('text',{x:px,y:22,'text-anchor':i===0?'start':i===ticks?'end':'middle',class:'axis'});label.textContent=end-start<=300000?new Date(t).toLocaleTimeString(locale(),{hour12:false}):date(new Date(t).toISOString(),true);chart.append(label);}
  lanes.forEach((key,i)=>{const event=valid.find(e=>laneKey(e)===key);if(event.kind==='git')chart.append(svg('rect',{x:0,y:top+i*row,width,height:row,class:'git-band'}));const label=svg('text',{x:14,y:top+i*row+28,class:'lane-label'+(event.kind==='git'?' git-lane-label':'')});label.textContent=(event.kind==='git'?t(event.unit_id):`${roleNames[event.kind]||event.kind} · ${event.unit_id||''}`).slice(0,Math.floor((left-24)/7));const title=svg('title');title.textContent=`${event.task_id||''} / ${event.unit_id||''}`;label.append(title);chart.append(label,svg('line',{x1:left,x2:width-right,y1:top+(i+1)*row,y2:top+(i+1)*row,stroke:'var(--grid)'}));});
  // Explicit continuation only; proximity in time never creates an execution edge.
  for(const event of valid){if(!event.continued_from)continue;const previous=valid.find(e=>e.job_id===event.continued_from&&e.kind==='work');if(previous){const x1=x(time(previous.end)??time(previous.start)),x2=x(time(event.start));chart.append(svg('path',{d:`M${x1} ${y(previous)} C${x1+12} ${y(previous)+18} ${x2-12} ${y(event)+18} ${x2} ${y(event)}`,fill:'none',stroke:'var(--quiet)','stroke-dasharray':'3 3'}));}}
  for(const event of valid.filter(e=>e.kind==='git')){
    const owner=valid.find(e=>e.job_id===event.job_id&&['work','integration'].includes(e.kind));
    if(!owner)continue;const a=x(time(owner.end)??time(owner.start)),b=x(time(event.start));
    chart.append(svg('path',{d:`M${a} ${y(owner)} C${a+12} ${y(owner)+20} ${b-12} ${y(event)-20} ${b} ${y(event)}`,fill:'none',stroke:'var(--purple)','stroke-opacity':'.5','stroke-dasharray':'2 4','data-relation':'execution-git'}));
  }
  for(const event of valid){const group=svg('g',{'aria-label':`${eventTitle(event)}，${stateNames[event.status]||event.status}，${date(event.start,true)}`});const a=x(time(event.start)),b=x(time(event.end)??time(event.start)),cy=y(event),color=eventColor(event);
    if(b>a+9)group.append(svg('rect',{x:a,y:cy-6,width:b-a,height:12,rx:3,fill:color,'fill-opacity':'.35',stroke:color}));
    group.append(svg('circle',{cx:a,cy,r:4,fill:color,stroke:'var(--graph-bg)','stroke-width':2}));
    const title=svg('title');title.textContent=`${eventTitle(event)}\n${date(event.start,true)} · ${stateNames[event.status]||event.status}\n${duration(event.start,event.end)}`;group.append(title);bindNode(group,()=>openEvent(event));chart.append(group);
  }
  return chart;
}

function dependencyGraph(plan){
  const {nodes,edges}=plan.graph;if(!nodes.length)return element('div','empty',t('没有登记 Contract 子任务或依赖。'));
  const levels=new Map(),remaining=new Set(nodes.map(n=>n.id));let step=0;
  while(remaining.size&&step<nodes.length){const ready=[...remaining].filter(id=>edges.filter(e=>e.target===id).every(e=>levels.has(e.source)));if(!ready.length)break;for(const id of ready){levels.set(id,step);remaining.delete(id);}step++;}
  const cyclic=remaining.size>0;for(const id of remaining)levels.set(id,step);
  const columns=new Map();nodes.forEach(n=>{const col=levels.get(n.id);if(!columns.has(col))columns.set(col,[]);columns.get(col).push(n);});
  const width=Math.max(720,(Math.max(...levels.values())+1)*255+40),height=Math.max(150,...[...columns.values()].map(c=>c.length*85+60));
  const chart=svg('svg',{viewBox:`0 0 ${width} ${height}`,class:'dependency-chart',role:'img','aria-label':cyclic?t('任务依赖图，包含未解析的环或端点'):t('任务依赖与审查对象图')});
  const defs=svg('defs'),marker=svg('marker',{id:'dependency-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});marker.append(svg('path',{d:'M0 0 L10 5 L0 10 Z',fill:'var(--quiet)'}));defs.append(marker);chart.append(defs);
  const pos=new Map();for(const [col,entries]of columns)entries.forEach((n,i)=>pos.set(n.id,{x:25+col*255,y:35+i*85}));
  for(const edge of edges){const a=pos.get(edge.source),b=pos.get(edge.target);if(!a||!b)continue;chart.append(svg('path',{d:`M${a.x+200} ${a.y+24} C${a.x+228} ${a.y+24} ${b.x-28} ${b.y+24} ${b.x} ${b.y+24}`,fill:'none',stroke:'var(--quiet)','stroke-width':1.2,'marker-end':'url(#dependency-arrow)',...(edge.kind==='review-target'?{'stroke-dasharray':'4 4'}:{})}));}
  for(const node of nodes){const p=pos.get(node.id),g=svg('g',{'aria-label':node.role==='unresolved'?t(node.title):node.title});g.append(svg('rect',{x:p.x,y:p.y,width:200,height:48,rx:5,fill:'var(--surface)',stroke:node.role==='unresolved'?'var(--amber)':'var(--line)'}));const label=svg('text',{x:p.x+12,y:p.y+20});label.textContent=node.label.slice(0,27);const role=svg('text',{x:p.x+12,y:p.y+37});role.textContent=node.role==='review'?t('审查对象'):node.role==='unresolved'?t('端点未登记'):t('执行子任务');const title=svg('title');title.textContent=node.role==='unresolved'?t(node.title):node.title;g.append(label,role,title);bindNode(g,()=>{const event=plan.events.find(e=>e.task_id===node.task_id&&e.unit_id===node.label);if(event)openEvent(event);else openObject(node.label,node);});chart.append(g);}
  if(cyclic){const label=svg('text',{x:20,y:height-10,fill:'var(--amber)'});label.textContent=t('存在依赖环或未解析关系；保留原始端点，不推断顺序。');chart.append(label);}return chart;
}

async function loadGit(){
  if(gitBusy)return;gitBusy=true;$('historySummary').textContent=t('读取 Git 历史…');
  try{gitData=await request('/api/git/history',{ref:$('branchFilter').value,limit:gitLimit,internal:$('internalRefs').checked?'1':'0'});if(mode==='git'){renderGit();renderCommit();snapshotTime(gitData.generated_at);}}
  catch(error){notice(t(error.message));if(!gitData&&mode==='git'){$('historyList').replaceChildren(element('div','empty',t('此目录的 Git 历史暂不可读。')));const main=mainContent();heading(main,'GIT HISTORY',t('Git 历史暂不可读'));main.append(element('p','description',error.message));}}
  finally{gitBusy=false;}
}
function renderGit(){
  if(!gitData)return;
  $('historySummary').textContent=t("{p0}{p1} 条提交 · 提交时间倒序", {p0:(gitData.commits.length), p1:(gitData.has_more?'+':'')});
  const filter=$('branchFilter'),selected=filter.value;filter.replaceChildren(new Option(t('全部分支'),''));
  for(const ref of gitData.refs.filter(r=>r.kind!=='tag'))filter.append(new Option(ref.label,ref.name));filter.value=selected;
  const head=gitData.status.head,nodes=[{hash:'WORKTREE',parents:head&&head!=='(initial)'?[head]:[],virtual:true},...gitData.commits];
  const graph=layoutGraph(nodes,{refs:gitData.refs,head}),rowHeight=92,step=15,offset=13,width=Math.max(40,graph.maxLanes*step+20),x=n=>offset+n*step,y=n=>n*rowHeight+rowHeight/2;
  const chart=svg('svg',{width,height:rowHeight*nodes.length,viewBox:`0 0 ${width} ${rowHeight*nodes.length}`,'aria-hidden':'true'});
  for(const e of graph.edges){const a=x(e.fromColumn),b=x(e.toColumn),ya=y(e.from),yb=e.to===nodes.length?nodes.length*rowHeight:y(e.to),sign=yb>=ya?1:-1;let d;
    if(e.railColumn!==null){const rail=x(e.railColumn);d=`M${a} ${ya} C${rail} ${ya} ${rail} ${ya+sign*15} ${rail} ${ya+sign*22} L${rail} ${yb-sign*22} C${rail} ${yb-sign*15} ${rail} ${yb} ${b} ${yb}`;}
    else d=a===b?`M${a} ${ya} V${yb}`:`M${a} ${ya} V${yb-sign*35} C${a} ${yb-sign*10} ${b} ${yb-sign*18} ${b} ${yb}`;
    chart.append(svg('path',{d,stroke:colors[e.color],...(e.dashed?{'stroke-dasharray':'4 4'}:{})}));
  }
  graph.rows.forEach((r,i)=>chart.append(svg('circle',{cx:x(r.column),cy:y(i),r:r.virtual?5.5:4,fill:r.virtual?'var(--sidebar)':colors[r.color],stroke:colors[r.color],...(r.virtual?{'stroke-dasharray':'3 2'}:{})})));
  const history=element('div','git-history');history.style.setProperty('--graph-width',width+'px');history.append(chart);
  for(const c of nodes){const row=button('',()=>{selectedHash=c.hash;renderGit();renderCommit();reveal();},`git-row${c.virtual?' git-worktree':''}${selectedHash===c.hash?' selected':''}`);row.dataset.hash=c.hash;row.append(element('span',''));const content=element('span','');
    if(c.virtual){content.append(element('span','git-subject',t('未提交的改动')));content.append(element('span','git-meta',t("未暂存 {p0} · 未跟踪 {p1} · 已暂存 {p2}", {p0:(gitData.status.unstaged), p1:(gitData.status.untracked), p2:(gitData.status.staged)})));}
    else{const refs=gitData.refs.filter(r=>r.hash===c.hash);if(refs.length){const badge=element('span','git-ref',refs.map(r=>r.kind==='internal'?t('内部 · ')+r.label.replace('refs/agent-orch/',''):r.label).join(' · '));badge.title=badge.textContent;content.append(badge);}content.append(element('span','git-subject',c.subject));content.append(element('span','git-meta',c.hash.slice(0,7)+' · '+date(c.date,true)));const relations=commitRelations(c.hash),planIds=[...new Set(relations.map(r=>r.plan_id))];if(planIds.length){const labels=planIds.map(id=>planTitle(workspace.plans.find(p=>p.id===id)||{title:id}));const badge=element('span','git-plan-label',labels.length>1?t("{p0} +{p1} 项计划", {p0:(labels[0]), p1:(labels.length-1)}):labels[0]);badge.title=relations.map(r=>`${r.plan_id} · ${t(r.label)}`).join('\n');content.append(badge);}row.title=`${c.subject}\n${c.hash}\n${c.author}`;}
    row.append(content);history.append(row);
  }
  const list=$('historyList');list.className='history-list';list.replaceChildren(history);if(gitData.has_more&&gitLimit<2000)list.append(button(t('加载更早提交'),()=>{gitLimit+=150;loadGit();},'load-more'));
}

async function selectCommit(hash){selectedHash=hash;setMode('git');reveal();if(!gitData)await loadGit();renderCommit();}
async function renderCommit({cached=false}={}){
  if(mode!=='git')return;const main=mainContent();
  if(!gitData){heading(main,'GIT HISTORY',t('选择一个提交'));return;}
  if(!selectedHash||selectedHash==='WORKTREE'){
    heading(main,'GIT / '+gitData.status.branch,t('工作区改动'));const s=gitData.status;
    const summary=element('div','summary-strip');for(const [key,label]of [['unstaged',t('未暂存')],['untracked',t('未跟踪')],['staged',t('已暂存')],['conflicts',t('冲突')]])summary.append(element('span','',`${s[key]} ${label}`));main.append(summary,element('p','subtle-note',t('虚线节点连接当前 HEAD；工作区节点不属于提交历史。')));
    const files=element('div','record-list');for(const f of s.files){const row=element('div','record-row');row.append(element('span','record-icon',f.xy),element('span','record-title',f.original?`${f.original} → ${f.path}`:f.path));files.append(row);}if(!s.files.length)files.append(element('div','empty',t('工作区干净。')));main.append(files);return;
  }
  const c=gitData.commits.find(c=>c.hash===selectedHash);heading(main,t('GIT / 提交'),c?.subject||selectedHash.slice(0,12));
  if(c)main.append(factList([['SHA',c.hash],[t('作者'),c.author],[t('提交时间'),c.date],[t('作者时间'),c.author_date],[t('父提交'),c.parents.join('\n')]]));
  const relations=commitRelations(selectedHash),linked=[...new Set(relations.map(r=>r.plan_id))].map(id=>workspace?.plans.find(p=>p.id===id)).filter(Boolean);
  main.append(section(t('关联计划'),t("{p0} 项 · 基于操作回执与明确关联", {p0:(linked.length)})));
  if(!linked.length)main.append(element('p','subtle-note',t('没有找到可靠的 Plan 关联。')));
  for(const p of linked){main.append(button(planTitle(p)+' · '+[...new Set(relations.filter(r=>r.plan_id===p.id).map(r=>t(r.label)))].join(' / '),()=>{selectedPlan=p.id;setMode('plans');reveal();},'link-plan'));
    for(const event of (p.git_activity||[]).filter(e=>e.commit_id===selectedHash))main.append(button(`${date(event.start,true)} · ${eventTitle(event)}`,()=>openEvent(event),'text-button'));
  }
  if(relations.length&&!relations.some(r=>r.relation==='delivery'||r.relation==='delivery.committed'))main.append(element('p','subtle-note',t('此对象关联基线或内部检查点；不表示已交付到目标分支。')));
  const box=element('pre','',t('读取提交内容…'));box.dataset.commitContent=selectedHash;main.append(section(t('提交说明与改动')),box);const ownHash=selectedHash;
  try{const detail=commitContent.get(ownHash)||(!cached?await request('/api/git/commit/'+ownHash):null);if(!detail)return;commitContent.set(ownHash,detail);if(selectedHash===ownHash&&mode==='git'){const target=$('main').querySelector('[data-commit-content]');if(target)target.textContent=detail.text;if(detail.truncated)$('main').append(element('p','subtle-note',t('改动超过展示上限，已截取前 256 KiB。')));}}
  catch(error){if(selectedHash===ownHash&&mode==='git'){const target=$('main').querySelector('[data-commit-content]');if(target)target.textContent=t(error.message);}}

}

function openObject(title,value){activeDetail={kind:'object',title,value};detailSequence++;$('detailKind').textContent=t('原始记录');$('detailTitle').textContent=title;$('detailBody').replaceChildren(element('pre','',JSON.stringify(value,null,2)));if(!$('detailDialog').open)$('detailDialog').showModal();}
function openEvent(event){if(event.kind==='git'){openGitEvent(event);return;}if(event.id.startsWith('job:')&&event.job_id){openJob(event.job_id);return;}openObject(`${roleNames[event.kind]||event.kind} · ${eventTitle(event)||''}`,event);activeDetail={kind:'event',event};if(event.job_id)$('detailBody').prepend(button(t('查看关联执行'),()=>openJob(event.job_id),'text-button'));}
function openGitEvent(event){
  activeDetail={kind:'git',event};detailSequence++;const op=event.operation||{};$('detailKind').textContent=t('Git 操作');$('detailTitle').textContent=eventTitle(event);
  const body=$('detailBody');body.replaceChildren(status(event.status),factList([[t('发生时间'),event.start||t('时间未记录')],[t('记录时间'),op.recorded_at],[t('工作区'),op.workspace],[t('前序 HEAD'),op.before_head],[t('结果 HEAD'),op.after_head],[t('提交'),op.commit_id],[t('引用'),op.ref],[t('所属执行'),event.job_id],[t('共用执行'),(op.related_job_ids||[]).join(', ')],[t('来源执行'),op.source_job_id],[t('补丁摘要'),op.patch_digest],[t('证据'),op.source_file],[t('来源'),op.provenance==='legacy-fields'?t('历史字段 / 回执'):t('结构化操作记录')]]));
  if(op.error)body.append(element('p','warning-text',op.error));const actions=element('div','operation-actions');
  if(event.commit_id)actions.append(button(t('查看 Git 对象'),()=>{$('detailDialog').close();selectCommit(event.commit_id);},'text-button'));
  if(event.job_id&&selectedJob(event.job_id))actions.append(button(t('查看关联执行'),()=>openJob(event.job_id),'text-button'));
  body.append(actions);if(op.files?.length)body.append(disclosure(t('涉及文件'),op.files));body.append(disclosure(t('操作原始证据'),op));
  if(!$('detailDialog').open)$('detailDialog').showModal();
}
function markdown(text){const node=element('div','markdown');if(window.marked&&window.DOMPurify){node.innerHTML=DOMPurify.sanitize(marked.parse(String(text)),{FORBID_TAGS:['img','iframe','form','input','style','svg','math'],FORBID_ATTR:['style']});node.querySelectorAll('a').forEach(a=>{if(!/^(https?:|mailto:|#)/i.test(a.getAttribute('href')||''))a.removeAttribute('href');a.rel='noopener noreferrer';a.target='_blank';});}else node.append(element('pre','',String(text)));return node;}
async function openJob(id,{cached=false}={}){
  activeDetail={kind:'job',id};
  const seq=++detailSequence,j=selectedJob(id);$('detailKind').textContent=roleNames[j?.role]||t('执行记录');$('detailTitle').textContent=j?.subtask_id||j?.review_id||id;$('detailBody').replaceChildren(element('p','subtle-note',t('读取执行证据…')));if(!$('detailDialog').open)$('detailDialog').showModal();
  try{const data=cached?jobContent.get(id):await request('/api/run/'+encodeURIComponent(id));if(seq!==detailSequence||!data)return;jobContent.set(id,data);const job=data.job||{},body=$('detailBody');body.replaceChildren(status(job.status),factList([['Job ID',id],['Task',job.task_id],['Subtask',job.subtask_id||job.review_id],['Provider',job.provider],[t('模型'),job.observed_model||job.model],[t('开始'),job.started_at||job.created_at],[t('结束'),job.finished_at],[t('执行阶段'),job.phase],[t('验收记录'),job.acceptance_status],[t('续跑自'),job.continued_from_job_id],[t('工作区'),job.workspace?.path]]));
    if(job.error)body.append(disclosure(t('异常原因'),job.error));const report=data.work_report||data.evidence?.result||data.evidence?.summary;
    if(report)body.append(markdown(report));
    const events=data.transcript_events||data.agy_transcript_events||[];if(events.length)body.append(disclosure(t("对话与工具记录 · {p0} 条", {p0:(events.length)}),events.map(e=>`${e.kind||e.role||'event'}\n${e.text||JSON.stringify(e)}`).join('\n\n')));
    if(data.patch)body.append(disclosure(t('补丁'),data.patch));if(data.stdout_log||data.agy_stdout_log)body.append(disclosure(t('标准输出'),data.stdout_log||data.agy_stdout_log));if(data.stderr_log||data.agy_stderr_log)body.append(disclosure(t('诊断输出'),data.stderr_log||data.agy_stderr_log));
    body.append(disclosure('Evidence',data.evidence||{}),disclosure(t('完整 Job 元数据'),job));
  }catch(error){if(seq===detailSequence)$('detailBody').replaceChildren(element('p','warning-text',error.message));}
}

const homeMode=!new URLSearchParams(location.search).get('project')&&!new URLSearchParams(location.search).get('thread');
const projectPrefsKey='agentOrchAuditProjectPreferences';
let projectPrefs={customPaths:[],hiddenPaths:[]};
try{const saved=JSON.parse(localStorage.getItem(projectPrefsKey)||'{}');projectPrefs={customPaths:Array.isArray(saved.customPaths)?saved.customPaths.filter(p=>typeof p==='string'):[],hiddenPaths:Array.isArray(saved.hiddenPaths)?saved.hiddenPaths.filter(p=>typeof p==='string'):[]};}catch{}
const projectKey=p=>p.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase();
function saveProjectPrefs(){try{localStorage.setItem(projectPrefsKey,JSON.stringify(projectPrefs));}catch{}}
async function projectCatalog(){
  const data=await request('/api/projects'),all=new Map((data.projects||[]).map(p=>[projectKey(p.path),p]));
  for(const path of projectPrefs.customPaths){if(all.has(projectKey(path)))continue;try{const p=await request('/api/project-info',{project:path,thread:''});all.set(projectKey(p.path),p);}catch{all.set(projectKey(path),{path,display_name:path.split(/[\\/]/).pop(),unavailable:true});}}
  return catalogSnapshot=[...all.values()].filter(p=>!projectPrefs.hiddenPaths.some(path=>projectKey(path)===projectKey(p.path)));
}
async function loadProjectHome({cached=false}={}){
  $('projectHome').hidden=false;$('layout').hidden=true;$('projectButton').hidden=true;$('projectCrumb').hidden=true;$('allProjects').hidden=true;$('branchSummary').textContent=t('项目工作区');document.title=t('项目 · Agent Orch Auditor');
  const list=$('homeProjectList');list.replaceChildren(element('p','subtle-note',t('读取已知项目…')));if(cached&&catalogSnapshot===null)return;$('refreshButton').disabled=true;
  try{const items=cached?(catalogSnapshot||[]):await projectCatalog(),frag=document.createDocumentFragment();
    for(const p of items){const card=element('article','project-card'),open=button('',()=>navigateProject(p.path),'project-card-open');open.disabled=!!p.unavailable;open.append(element('span','project-card-name',p.display_name||p.path),element('span','project-card-path',p.path));
      const meta=element('span','project-card-meta');meta.append(element('span','',p.unavailable?t('目录暂不可用'):t("{p0} 项计划", {p0:(p.total_plans??Object.keys(p.plan_counts||{}).length)})),element('span','',t("{p0} 进行中", {p0:(p.active_jobs||0)})),element('span','',p.git_branch?'⑂ '+p.git_branch:p.has_orchestrator?'Agent Orch':t('本地工作区')));open.append(meta);
      const hide=button('×',()=>{projectPrefs.hiddenPaths.push(p.path);saveProjectPrefs();loadProjectHome();},'hide-project');hide.setAttribute('aria-label',t('隐藏项目 ')+(p.display_name||p.path));hide.title=t('仅从列表隐藏');card.append(open,hide);frag.append(card);
    }
    if(!items.length)frag.append(element('p','empty',t('还没有显示的项目。可以添加目录，或恢复已隐藏项目。')));list.replaceChildren(frag);
  }catch(error){list.replaceChildren(element('p','warning-text',error.message));}finally{$('refreshButton').disabled=false;}
}
$('allProjects').addEventListener('click',()=>location.assign('/'));
$('restoreProjects').addEventListener('click',()=>{projectPrefs.hiddenPaths=[];saveProjectPrefs();loadProjectHome();});
$('homeProjectForm').addEventListener('submit',async event=>{event.preventDefault();const path=$('homeProjectPath').value.trim();try{const info=await request('/api/project-info',{project:path,thread:''});projectPrefs.customPaths=[...projectPrefs.customPaths.filter(p=>projectKey(p)!==projectKey(info.path)),info.path];projectPrefs.hiddenPaths=projectPrefs.hiddenPaths.filter(p=>projectKey(p)!==projectKey(info.path));saveProjectPrefs();homeFeedbackKey='项目已添加';$('homeFeedback').textContent=t(homeFeedbackKey);$('homeProjectPath').value='';await loadProjectHome();}catch(error){$('homeFeedback').textContent=t(error.message);}});
async function projects({cached=false}={}){
  $('projectFeedback').textContent='';if(!cached)$('projectPath').value=workspace?.project_dir||'';if(!$('projectDialog').open)$('projectDialog').showModal();$('projectList').replaceChildren(element('p','subtle-note',t('读取已知项目…')));
  try{const items=cached?(catalogSnapshot||[]):await projectCatalog();const frag=document.createDocumentFragment();for(const p of items){const b=button('',()=>navigateProject(p.path));b.append(element('span','',p.display_name||p.path),element('small','',p.path));frag.append(b);}$('projectList').replaceChildren(frag);}
  catch(error){$('projectList').replaceChildren(element('p','warning-text',error.message));}
}
function navigateProject(path){const url=new URL(location.href);url.searchParams.delete('thread');url.searchParams.set('project',path);location.assign(url);}
$('plansTab').addEventListener('click',()=>{setMode('plans');$('layout').classList.remove('show-detail');});
$('gitTab').addEventListener('click',()=>{setMode('git');$('layout').classList.remove('show-detail');});
$('internalRefs').addEventListener('change',()=>{$('branchFilter').value='';selectedHash=null;loadGit();});
$('branchFilter').addEventListener('change',()=>{selectedHash=null;loadGit();});
$('refreshButton').addEventListener('click',()=>homeMode?loadProjectHome():refresh());
$('closeDetail').addEventListener('click',()=>{$('detailDialog').close();detailSequence++;});
$('projectButton').addEventListener('click',projects);$('closeProjects').addEventListener('click',()=>$('projectDialog').close());
$('projectForm').addEventListener('submit',async event=>{event.preventDefault();try{const path=$('projectPath').value.trim();await request('/api/context',{project:path,thread:''});navigateProject(path);}catch(error){$('projectFeedback').textContent=t(error.message);}});
$('themeButton').addEventListener('click',()=>{const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('agentOrchWorkspaceTheme',theme);}catch{}});
try{document.documentElement.dataset.theme=localStorage.getItem('agentOrchWorkspaceTheme')||'dark';}catch{}
translateStatic();
document.querySelectorAll('[data-language-toggle]').forEach(toggle=>toggle.addEventListener('click',()=>{
  const mainScroll=$('main').scrollTop,historyScroll=$('historyList').scrollTop;
  const expanded=[...$('main').querySelectorAll('details')].map((node,index)=>node.open?index:-1);
  setLanguage(getLanguage()==='en'?'zh-CN':'en');translateStatic();
  if(homeMode){loadProjectHome({cached:true});if(homeFeedbackKey)$('homeFeedback').textContent=t(homeFeedbackKey);}
  else if(workspace){renderWorkspaceHeader();if(mode==='git'){if(gitData){renderGit();renderCommit({cached:true});snapshotTime(gitData.generated_at);}}else{renderPlans();renderPlan();snapshotTime(workspace.generated_at);}}
  if($('projectDialog').open)projects({cached:true});
  if($('detailDialog').open&&activeDetail){const detail=activeDetail;if(detail.kind==='git')openGitEvent(detail.event);else if(detail.kind==='event')openEvent(detail.event);else if(detail.kind==='object')openObject(detail.title,detail.value);else if(jobContent.has(detail.id))openJob(detail.id,{cached:true});else{$('detailKind').textContent=roleNames[selectedJob(detail.id)?.role]||t('执行记录');$('detailBody').replaceChildren(element('p','subtle-note',t('读取执行证据…')));}}
  [...$('main').querySelectorAll('details')].forEach((node,index)=>{if(expanded.includes(index))node.open=true;});
  $('main').scrollTop=mainScroll;$('historyList').scrollTop=historyScroll;
}));
if(homeMode)loadProjectHome();else refresh();
