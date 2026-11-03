import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const root=new URL('../dashboard/scripts/',import.meta.url);
const html=fs.readFileSync(new URL('workspace.html',root),'utf8');
const source=fs.readFileSync(new URL('workspace.js',root),'utf8').replace(/^import[^\n]+\n/gm,'');
const translations=fs.readFileSync(new URL('i18n.js',root),'utf8').replace(/^export /gm,'');
const graph=fs.readFileSync(new URL('graph.js',root),'utf8').replace(/^export /gm,'');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(){
  const jobs=Array.from({length:60},(_,i)=>({id:'work-'+i,type:'stage_work',role:'work',task_id:'task',subtask_id:'build',created_at:'2026-01-01T00:00:00Z',status:i===0?'failed':'completed',delivery:{state:'unlinked'}}));
  const events=jobs.map((j,i)=>({id:'job:'+j.id,kind:'work',job_id:j.id,task_id:'task',unit_id:'build',title:'Build '+i,status:j.status,start:`2026-01-01T00:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}Z`,end:`2026-01-01T01:00:00Z`}));
  return {project_dir:'C:/project',counts:{plans:1,jobs:60},git:{repository:'C:/project',status:{branch:'main',files:[]}},generated_at:'2026-01-01T01:00:00Z',warnings:[],plans:[{id:'p',title:'Example plan',type:'formal',created_at:'2026-01-01T00:00:00Z',state:'awaiting_review',description:'',job_count:60,task_count:1,failure_count:1,tasks:[{id:'task',subtasks:[{id:'build'}]}],stages:[],events,jobs,delivery:{state:'unlinked',commits:[]},graph:{nodes:[{id:'task/build',label:'build',role:'work',task_id:'task',title:'Build'},{id:'task/review',label:'review',role:'review',task_id:'task',title:'Review'}],edges:[{source:'task/build',target:'task/review',kind:'review-target'}]}}]};
}
const gitFixture={status:{head:'a'.repeat(40),branch:'main',staged:0,unstaged:2,untracked:1,conflicts:0,files:[{xy:'.M',path:'x.txt'}]},refs:[{name:'refs/heads/main',label:'main',hash:'a'.repeat(40),kind:'branch'}],commits:[{hash:'a'.repeat(40),parents:['b'.repeat(40)],subject:'Commit A',date:'2026-01-01T00:00:00Z',author:'Test'},{hash:'b'.repeat(40),parents:[],subject:'Commit B',date:'2025-01-01T00:00:00Z',author:'Test'}],has_more:false};
async function setup({data=fixture(),gitResponse=null,url="http://127.0.0.1:43189/?project=C%3A%2Fproject",prefs=null,projects=[],language=null,report='Worker report',projectsResponse=null}={}){
  const dom=new JSDOM(html,{url,runScripts:'outside-only'}),w=dom.window,calls=[],timers=[];
  if(language)w.localStorage.setItem('agentOrchWorkspaceLanguage',language);
  if(prefs)w.localStorage.setItem('agentOrchAuditProjectPreferences',JSON.stringify(prefs));
  w.AbortSignal=globalThis.AbortSignal;w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  w.setInterval=(...args)=>{timers.push(args);return 0;};
  w.fetch=async(input)=>{
    const url=new URL(input,w.location.href);calls.push(url);
    let value;
    if(url.pathname==='/api/projects'){if(projectsResponse)return projectsResponse();value={projects};}
    else if(url.pathname==='/api/project-info')value={path:url.searchParams.get('project'),display_name:'Custom',plan_counts:{p:{}},git_branch:'main'};
    else if(url.pathname==='/api/workspace')value=data;
    else if(url.pathname==='/api/git/history'){if(gitResponse)return gitResponse();value=gitFixture;}
    else if(url.pathname.startsWith('/api/git/commit/'))value={text:'Commit patch'};
    else if(url.pathname.startsWith('/api/run/'))value={job:{id:'work-0',provider:'codex_worker',status:'failed'},work_report:report,transcript_events:[{kind:'assistant_text',text:'Exact output'}],patch:'diff --git a/x b/x'};
    else value={};
    return {ok:true,json:async()=>structuredClone(value)};
  };
  w.eval(translations+'\n'+graph+'\n'+source);await flush();await flush();
  return {dom,w,calls,timers,close:()=>dom.window.close()};
}

test('workspace keeps all 60 records, removes old controls and never starts timers',async()=>{
  const app=await setup();try{
    assert.equal(app.w.document.querySelectorAll('.record-row').length,60);
    assert.match(app.w.document.querySelector('#historySummary').textContent,/60/);
    assert.equal(app.w.document.querySelector('#searchInput'),null);
    assert.equal(app.w.document.querySelector('#processColumn'),null);
    assert.equal(app.w.document.querySelector('iframe'),null);
    assert.equal(app.timers.length,0);assert.equal(app.calls.length,1);
    app.w.document.dispatchEvent(new app.w.Event('visibilitychange'));await flush();assert.equal(app.calls.length,1);
    app.w.document.querySelector('#refreshButton').click();await flush();assert.equal(app.calls.length,2);
    assert(app.calls.every(u=>u.searchParams.get('project')==='C:/project'));
  }finally{app.close();}
});

test('real SVG dependency arrows and timeline nodes expose record details',async()=>{
  const app=await setup();try{
    const doc=app.w.document;
    assert.equal(doc.querySelectorAll('.execution-chart [role=button]').length,60);
    [...doc.querySelectorAll('.chart-tabs button')].find(b=>b.textContent==='依赖关系').click();
    assert(doc.querySelector('.dependency-chart path[marker-end]'));
    assert.equal(doc.querySelectorAll('.dependency-chart [role=button]').length,2);
    doc.querySelector('.record-row').click();await flush();await flush();
    assert(doc.querySelector('#detailDialog').open);assert.match(doc.querySelector('#detailBody').textContent,/Worker report/);assert.match(doc.querySelector('#detailBody').textContent,/Exact output/);
  }finally{app.close();}
});

test('Git history is in the sidebar, with dashed worktree and bidirectional delivery links',async()=>{
  const data=fixture();data.plans[0].delivery={state:'committed',commits:[{commit_id:'a'.repeat(40),state:'committed'}]};
  const app=await setup({data});try{
    const doc=app.w.document;doc.querySelector('#gitTab').click();await flush();await flush();
    assert.equal(doc.querySelectorAll('.git-row').length,3);assert(doc.querySelector('.git-worktree'));
    assert(doc.querySelector('.git-history circle[stroke-dasharray]'));assert(doc.querySelector('.git-history path[stroke-dasharray]'));
    doc.querySelector('.git-row[data-hash="'+('a'.repeat(40))+'"]').click();await flush();
    assert.match(doc.querySelector('#main').textContent,/Commit A/);assert.match(doc.querySelector('#main').textContent,/Commit patch/);
    assert.equal(doc.querySelectorAll('.link-plan').length,1);doc.querySelector('.link-plan').click();
    assert.equal(doc.querySelector('#plansTab').getAttribute('aria-selected'),'true');
  }finally{app.close();}
});

test('late Git response cannot overwrite the plan sidebar after changing tabs',async()=>{
  let resolveGit;const pending=new Promise(resolve=>{resolveGit=resolve;});
  const app=await setup({gitResponse:()=>pending});try{
    const doc=app.w.document;doc.querySelector('#gitTab').click();doc.querySelector('#plansTab').click();
    resolveGit({ok:true,json:async()=>structuredClone(gitFixture)});await flush();await flush();
    assert.equal(doc.querySelector('#plansTab').getAttribute('aria-selected'),'true');assert.equal(doc.querySelectorAll('.plan-row').length,1);assert.equal(doc.querySelectorAll('.git-row').length,0);
  }finally{app.close();}
});

test('untrusted plan names and commit text stay inert',async()=>{
  const data=fixture();data.plans[0].title='<img src=x onerror=alert(1)>';
  const app=await setup({data});try{
    assert.equal(app.w.document.querySelector('img'),null);assert(app.w.document.querySelector('#main').textContent.includes('<img'));
  }finally{app.close();}
});

test('a non-Git project keeps plan navigation and shows an explicit Git error',async()=>{
  const app=await setup({gitResponse:()=>{throw new Error('Not a Git worktree');}});try{
    const doc=app.w.document;doc.querySelector('#gitTab').click();await flush();await flush();
    assert.match(doc.querySelector('#main').textContent,/Git 历史暂不可读/);
    assert.match(doc.querySelector('#notice').textContent,/Not a Git worktree/);
    doc.querySelector('#plansTab').click();assert.equal(doc.querySelectorAll('.plan-row').length,1);
  }finally{app.close();}
});

test('root restores the project homepage and legacy custom/hidden preferences without loading a workspace',async()=>{
  const app=await setup({url:'http://127.0.0.1:43189/',prefs:{customPaths:['C:/custom'],hiddenPaths:['C:/hidden']},projects:[{path:'C:/hidden',display_name:'Hidden'},{path:'C:/visible',display_name:'Visible',active_jobs:2,plan_counts:{p:{}},git_branch:'main'}]});
  try{const doc=app.w.document;
    assert.equal(doc.querySelector('#projectHome').hidden,false);assert.equal(doc.querySelector('#layout').hidden,true);
    assert.equal(doc.querySelectorAll('.project-card').length,2);assert(!doc.querySelector('#homeProjectList').textContent.includes('Hidden'));
    assert(!app.calls.some(u=>u.pathname==='/api/workspace'));assert.equal(app.timers.length,0);
    [...doc.querySelectorAll('.project-card')].find(c=>c.textContent.includes('Custom')).querySelector('.hide-project').click();await flush();await flush();
    assert.equal(doc.querySelectorAll('.project-card').length,1);
    doc.querySelector('#restoreProjects').click();await flush();await flush();assert.equal(doc.querySelectorAll('.project-card').length,3);
    assert.deepEqual(JSON.parse(app.w.localStorage.getItem('agentOrchAuditProjectPreferences')).customPaths,['C:/custom']);
  }finally{app.close();}
});

test('Git operations share the execution timeline, open evidence, and link back through commit history',async()=>{
  const data=fixture(),sha='a'.repeat(40),event={id:'git-1',kind:'git',git_kind:'integration.checkpoint',job_id:'work-0',task_id:'task',unit_id:'Git · 隔离工作区',title:'保存集成检查点',status:'completed',start:'2026-01-01T00:10:00Z',end:'2026-01-01T00:10:00Z',commit_id:sha,operation:{before_head:'b'.repeat(40),after_head:sha,source_file:'receipt.json',workspace:'C:/isolated',provenance:'operation-receipt'}};
  data.plans[0].git_activity=[event];data.plans[0].events.push(event);data.commit_links={[sha]:[{plan_id:'p',relation:'integration.checkpoint',label:'集成检查点'}]};
  const app=await setup({data});try{const doc=app.w.document;
    assert(doc.querySelector('.execution-chart .git-band'));assert(doc.querySelector('.execution-chart [data-relation=execution-git]'));assert.equal(doc.querySelectorAll('.git-record').length,1);
    doc.querySelector('.git-record').click();assert.match(doc.querySelector('#detailBody').textContent,/receipt.json/);
    [...doc.querySelectorAll('#detailBody button')].find(b=>b.textContent==='查看 Git 对象').click();await flush();await flush();
    assert.equal(doc.querySelectorAll('.link-plan').length,1);assert.match(doc.querySelector('#main').textContent,/不表示已交付/);assert(doc.querySelector('.git-plan-label'));
  }finally{app.close();}
});

test('language toggle persists across pages and translates the project homepage without another read',async()=>{
  const options={url:'http://127.0.0.1:43189/',projects:[{path:'C:/project',display_name:'项目',total_plans:1}]};
  const app=await setup(options);try{
    const doc=app.w.document,reads=app.calls.length;doc.querySelector('#languageButton').click();await flush();
    assert.equal(doc.documentElement.lang,'en');assert.equal(doc.querySelector('.home-heading h1').textContent,'Projects');
    assert.equal(doc.querySelector('.project-card-name').textContent,'项目');assert.match(doc.querySelector('.project-card-meta').textContent,/Plans: 1/);
    assert.equal(doc.querySelector('#languageButton').textContent,'中文');assert.equal(app.calls.length,reads);
    assert.equal(app.w.localStorage.getItem('agentOrchWorkspaceLanguage'),'en');
    const reopened=await setup({...options,language:'en'});try{assert.equal(reopened.w.document.querySelector('.home-heading h1').textContent,'Projects');}finally{reopened.close();}
    doc.querySelector('#languageButton').click();await flush();assert.equal(doc.querySelector('.home-heading h1').textContent,'项目');assert.equal(app.calls.length,reads);
  }finally{app.close();}
});

test('changing language during project discovery keeps loading instead of reporting an empty catalog',async()=>{
  let complete;const pending=new Promise(resolve=>{complete=resolve;});
  const app=await setup({url:'http://127.0.0.1:43189/',projectsResponse:()=>pending});
  try{const doc=app.w.document,reads=app.calls.length;doc.querySelector('#languageButton').click();await flush();
    assert.match(doc.querySelector('#homeProjectList').textContent,/Loading known projects/);assert.equal(doc.querySelector('#refreshButton').disabled,true);assert.equal(app.calls.length,reads);
    complete({ok:true,json:async()=>({projects:[{path:'C:/pending',display_name:'Pending project'}]})});await flush();await flush();
    assert.equal(doc.querySelectorAll('.project-card').length,1);assert.match(doc.querySelector('.project-card-meta').textContent,/Plans:/);assert.equal(app.calls.length,reads);
  }finally{app.close();}
});

test('switching language preserves the selected plan and open job evidence without translating user content',async()=>{
  const data=fixture();data.plans[0].title='计划';const app=await setup({data,report:'计划 原始审查证据'});try{
    const doc=app.w.document;doc.querySelector('.record-row').click();await flush();await flush();
    const reads=app.calls.length;doc.querySelector('#detailLanguageButton').click();await flush();
    assert.equal(doc.querySelector('#main h1').textContent,'计划');assert.equal(doc.querySelector('.plan-row').getAttribute('aria-pressed'),'true');
    assert.equal(doc.querySelector('.chart-tabs button').textContent,'Timeline');assert.match(doc.querySelector('#detailBody').textContent,/Failed/);
    assert.match(doc.querySelector('#detailBody').textContent,/计划 原始审查证据/);assert.match(doc.querySelector('#detailBody').textContent,/Workspace/);
    assert.equal(doc.querySelector('#detailDialog').open,true);assert.equal(app.calls.length,reads);
    doc.querySelector('#detailLanguageButton').click();await flush();assert.match(doc.querySelector('#detailBody').textContent,/执行异常/);assert.equal(app.calls.length,reads);
  }finally{app.close();}
});

test('Git history and operation details translate while retaining commit selection and the cached diff',async()=>{
  const data=fixture(),sha='a'.repeat(40),event={id:'git-lang',kind:'git',git_kind:'integration.checkpoint',job_id:'work-0',title:'保存集成检查点',status:'completed',commit_id:sha,operation:{source_file:'receipt.json',workspace:'C:/owned'}};
  data.plans[0].git_activity=[event];data.plans[0].events.push(event);
  const app=await setup({data});try{const doc=app.w.document;
    doc.querySelector('.git-record').click();const reads=app.calls.length;doc.querySelector('#detailLanguageButton').click();await flush();
    assert.equal(doc.querySelector('#detailTitle').textContent,'Save integration checkpoint');assert.equal(app.calls.length,reads);
    [...doc.querySelectorAll('#detailBody button')].find(b=>b.textContent==='View Git object').click();await flush();await flush();
    assert.equal(doc.querySelector('#main h1').textContent,'Commit A');assert.match(doc.querySelector('#main').textContent,/Commit patch/);
    const gitReads=app.calls.length;doc.querySelector('#languageButton').click();await flush();
    assert.equal(doc.querySelector('#gitTab').getAttribute('aria-selected'),'true');assert.equal(doc.querySelector('#main h1').textContent,'Commit A');
    assert.match(doc.querySelector('#main').textContent,/Commit patch/);assert.equal(app.calls.length,gitReads);
  }finally{app.close();}
});
