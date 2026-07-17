/**
 * The first Workflow UI slice — a self-contained compile + draft-preview page served
 * by the Agent Gateway. It is a PURE HTML string (one inline nonce'd script; no
 * external resources) that calls the existing `/v1/workflow-drafts/*` REST routes with
 * same-origin credentials (an HttpOnly cookie — JS never holds the token). It renders
 * ONLY the trusted server projection (no request/prompt, no raw events, no token, no
 * SQL/DB path/stack) and escapes every dynamic value via textContent.
 *
 * Scope: compile → open a durable draft → inspect status + the trusted structured
 * preview. NO graphical map, NO approval, NO start/monitoring, NO draft editing.
 */

/** Render the workflow compile/preview page. `nonce` locks the single inline script. */
export function workflowUiHtml(nonce: string): string {
  // NOTE: the page renders all dynamic (user/model) values with textContent — never
  // innerHTML — so escaping is intrinsic. The only server-injected value here is the
  // CSP nonce (a fresh random token), not user data.
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vibe · Workflows</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d10;color:#e6e9ef}
@media (prefers-color-scheme:light){body{background:#f6f7f9;color:#1a1d24}}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid #2a2f38;position:sticky;top:0;background:inherit}
header b{font-size:16px}
nav a{color:inherit;text-decoration:none;opacity:.75;cursor:pointer;padding:4px 8px;border-radius:6px}
nav a.active,nav a:hover{opacity:1;background:#232833}
main{max-width:860px;margin:0 auto;padding:16px}
label{display:block;margin:12px 0 4px;font-weight:600;font-size:13px;opacity:.85}
input,textarea,select,button{font:inherit;color:inherit;background:#151a21;border:1px solid #2a2f38;border-radius:8px;padding:9px 11px;width:100%}
@media (prefers-color-scheme:light){input,textarea,select,button{background:#fff;border-color:#d4d9e0}header{border-color:#e2e6ec}nav a.active,nav a:hover{background:#e9edf3}}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:140px}
textarea{min-height:96px;resize:vertical}
button{cursor:pointer;background:#2b6cff;border-color:#2b6cff;color:#fff;font-weight:600;margin-top:16px}
button.sec{background:transparent;border-color:#2a2f38;color:inherit}
button:disabled{opacity:.5;cursor:default}
.card{border:1px solid #2a2f38;border-radius:10px;padding:14px;margin:14px 0;background:#0f141b}
@media (prefers-color-scheme:light){.card{background:#fff;border-color:#e2e6ec}}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700}
.b-ready{background:#12351f;color:#7ee0a0}.b-warn{background:#3a2c12;color:#f0c060}.b-bad{background:#3a1717;color:#f08a8a}.b-info{background:#16283f;color:#7fb2ff}
table{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #232833;vertical-align:top}
th{opacity:.7;font-weight:600}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
.edge-loop{color:#f0c060;font-weight:700}
.muted{opacity:.65;font-size:13px}
.rationale{border-left:3px solid #f0c060;padding-left:10px}
h2{font-size:15px;margin:16px 0 6px}
/* trusted workflow map (SVG; no execution logic) */
.mapwrap{overflow-x:auto;overflow-y:hidden;border:1px solid #232833;border-radius:8px;background:#0b0f15;padding:8px}
@media (prefers-color-scheme:light){.mapwrap{background:#f9fafc;border-color:#e2e6ec}}
.wfmap{display:block;max-width:100%;height:auto}
.wfmap .nrect{fill:#151a21;stroke:#2b6cff;stroke-width:1.5}
@media (prefers-color-scheme:light){.wfmap .nrect{fill:#fff;stroke:#2b6cff}}
.wfmap .nt-title{font:700 12px system-ui,sans-serif}
.wfmap .nt-sub{font:11px ui-monospace,monospace;opacity:.75}
.wfmap text{fill:#e6e9ef}
@media (prefers-color-scheme:light){.wfmap text{fill:#1a1d24}}
.wfmap .term{stroke-width:1.5}
.wfmap .term-complete{fill:#12351f;stroke:#3ec27a}.wfmap .tt-complete{fill:#7ee0a0}
.wfmap .term-failed{fill:#3a1717;stroke:#e06666}.wfmap .tt-failed{fill:#f08a8a}
.wfmap .term-blocked{fill:#3a2c12;stroke:#e0b24d}.wfmap .tt-blocked{fill:#f0c060}
.wfmap .e-normal{stroke:#7f8a99;stroke-width:1.6;fill:none}
.wfmap .e-loop{stroke:#f0c060;stroke-width:1.8;stroke-dasharray:6 4;fill:none}
.wfmap .e-complete{stroke:#3ec27a;stroke-width:1.8;fill:none}
.wfmap .e-failed{stroke:#e06666;stroke-width:1.8;fill:none}
.wfmap .e-blocked{stroke:#e0b24d;stroke-width:1.8;fill:none}
.wfmap .looplbl{font:700 12px system-ui,sans-serif;fill:#f0c060}
.maplegend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;opacity:.85;margin:6px 2px}
.maplegend span{display:inline-flex;align-items:center;gap:5px}
.maplegend i{width:18px;height:0;border-top-width:2px;border-top-style:solid;display:inline-block}
ul{margin:6px 0;padding-left:20px}
.err{color:#f08a8a}
</style></head><body>
<header><b>Vibe · Workflows</b><nav><a id="nav-new">Create workflow</a></nav></header>
<main id="app"></main>
<script nonce="${nonce}">
"use strict";
const app=document.getElementById('app');
const navNew=document.getElementById('nav-new');
const FINAL=new Set(['ready','needs_input','impossible','policy_denied']);
const el=(t,props,...kids)=>{const n=document.createElement(t);if(props)for(const k in props){if(k==='class')n.className=props[k];else if(k==='text')n.textContent=props[k];else if(k.startsWith('on'))n.addEventListener(k.slice(2),props[k]);else n.setAttribute(k,props[k]);}for(const c of kids)if(c!=null)n.append(c);return n;};
const SVGNS='http://www.w3.org/2000/svg';
const sv=(t,props,...kids)=>{const n=document.createElementNS(SVGNS,t);if(props)for(const k in props){if(k==='text')n.textContent=props[k];else n.setAttribute(k,String(props[k]));}for(const c of kids)if(c!=null)n.append(c);return n;};
const trunc=(s,max)=>{s=String(s==null?'':s);return s.length>max?s.slice(0,max-1)+'…':s;};
// Deterministic layered layout → a trusted SVG map. Pure presentation: NO execution logic.
function buildMap(p){
  const steps=(p.steps||[]).slice(),edges=(p.edges||[]).slice();
  if(!steps.length)return null;
  const byId={};steps.forEach(s=>byId[s.id]=s);
  const level={};steps.forEach(s=>level[s.id]=0);
  const stepEdges=edges.filter(e=>!e.loop&&!e.terminal&&byId[e.from]&&byId[e.to]);
  for(let it=0;it<=steps.length;it++)for(const e of stepEdges)if(level[e.to]<level[e.from]+1)level[e.to]=level[e.from]+1;
  let maxStepLevel=0;steps.forEach(s=>{if(level[s.id]>maxStepLevel)maxStepLevel=level[s.id];});
  const termLevel=maxStepLevel+1;const terms={};
  edges.filter(e=>e.terminal).forEach(e=>{terms[e.to]=true;});
  const rows={};steps.forEach(s=>{(rows[level[s.id]]=rows[level[s.id]]||[]).push({kind:'step',id:s.id,ref:s});});
  Object.keys(terms).sort().forEach(t=>{(rows[termLevel]=rows[termLevel]||[]).push({kind:'term',id:t});});
  const NW=176,NH=58,HG=30,VG=64;const pos={};
  const levs=Object.keys(rows).map(Number).sort((a,b)=>a-b);
  let maxCols=1;levs.forEach(l=>{if(rows[l].length>maxCols)maxCols=rows[l].length;});
  const W=maxCols*(NW+HG)+HG,H=(levs.length)*(NH+VG)+VG;
  levs.forEach((l,ri)=>{const r=rows[l];const rowW=r.length*(NW+HG)-HG;const startX=Math.max(HG,(W-rowW)/2);r.forEach((nd,i)=>{pos[nd.id]={x:startX+i*(NW+HG),y:VG/2+ri*(NH+VG),nd};});});
  const s=sv('svg',{viewBox:'0 0 '+W+' '+H,class:'wfmap',width:W,height:H,role:'img','aria-label':'Workflow map (steps, edges and terminal routes)'});
  // arrowheads per edge color
  const defs=sv('defs');
  [['a-normal','#7f8a99'],['a-loop','#f0c060'],['a-complete','#3ec27a'],['a-failed','#e06666'],['a-blocked','#e0b24d']].forEach(([id,col])=>{const m=sv('marker',{id:id,markerWidth:8,markerHeight:8,refX:7,refY:3,orient:'auto'});m.append(sv('path',{d:'M0,0 L7,3 L0,6 z',fill:col}));defs.append(m);});
  s.append(defs);
  const termClass=t=>t==='$complete'?'complete':t==='$failed'?'failed':'blocked';
  // edges
  edges.forEach(e=>{const a=pos[e.from],b=pos[e.to];if(!a||!b)return;
    const ax=a.x+NW/2,ay=a.y+NH,bx=b.x+NW/2,by=b.y;
    let cls,mk;
    if(e.loop){cls='e-loop';mk='a-loop';const cx=Math.max(ax,bx)+NW*0.7;const d='M'+ax+','+ay+' C'+cx+','+ay+' '+cx+','+by+' '+bx+','+by;s.append(sv('path',{class:cls,d:d,'marker-end':'url(#'+mk+')'}));s.append(sv('text',{class:'looplbl',x:(cx+Math.max(ax,bx))/2,y:(ay+by)/2,'text-anchor':'middle',text:'⟲ loop'}));return;}
    if(e.terminal){const tc=termClass(e.to);cls='e-'+tc;mk='a-'+tc;}else{cls='e-normal';mk='a-normal';}
    const mid=(ay+by)/2;const d='M'+ax+','+ay+' C'+ax+','+mid+' '+bx+','+mid+' '+bx+','+by;
    s.append(sv('path',{class:cls,d:d,'marker-end':'url(#'+mk+')'}));
  });
  // nodes
  Object.keys(pos).forEach(id=>{const{x,y,nd}=pos[id];const g=sv('g',{transform:'translate('+x+','+y+')'});
    if(nd.kind==='term'){const tc=termClass(id);const r=sv('rect',{class:'term term-'+tc,x:NW*0.15,y:NH*0.22,rx:16,width:NW*0.7,height:NH*0.5});const t=sv('text',{class:'tt-'+tc,x:NW/2,y:NH*0.55,'text-anchor':'middle','font-weight':'700',text:id});g.append(r,t);}
    else{const s0=nd.ref;const rect=sv('rect',{class:'nrect',x:0,y:0,rx:9,width:NW,height:NH});const title=sv('title',{text:id+' — '+(s0.agent||'—')+(s0.node_id?'@'+s0.node_id:'')+(s0.role?' ('+s0.role+')':'')});
      const t1=sv('text',{class:'nt-title',x:12,y:22,text:trunc(id,22)});
      const t2=sv('text',{class:'nt-sub',x:12,y:40,text:trunc((s0.agent||'—')+(s0.node_id?'@'+s0.node_id:''),26)});
      const t3=sv('text',{class:'nt-sub',x:12,y:53,text:trunc('role: '+(s0.role||'—')+(s0.workspace?' · ws':'')+(s0.permission_mode?' · '+s0.permission_mode:''),30)});
      g.append(rect,title,t1,t2,t3);}
    s.append(g);
  });
  return s;
}
function mapLegend(){const L=el('div',{class:'maplegend'});const seg=(cls,label)=>el('span',null,el('i',{class:'',style:'border-top-color:'+cls}),document.createTextNode(label));L.append(seg('#7f8a99','normal'),seg('#f0c060','loop'),seg('#3ec27a','→ complete'),seg('#e06666','→ failed'),seg('#e0b24d','→ blocked'));return L;}
const uuid=()=>{try{return crypto.randomUUID().replace(/-/g,'').slice(0,24);}catch(e){return 'k'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);}};
function api(method,path,body){return fetch(path,{method,credentials:'same-origin',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}).then(async r=>{let j=null;try{j=await r.json();}catch(e){}return{status:r.status,body:j};});}
function go(url){history.pushState(null,'',url);route();}
window.addEventListener('popstate',route);
navNew.addEventListener('click',()=>go('/ui'));

let pollTimer=null,disposed=false,stream=null;
function stopPoll(){if(pollTimer){clearTimeout(pollTimer);pollTimer=null;}}
function closeStream(){if(stream){try{stream.close();}catch(e){}stream=null;}}
function route(){stopPoll();closeStream();disposed=false;const u=new URL(location.href);const w=u.searchParams.get('workflow');const d=u.searchParams.get('draft');if(w)workflowView(w);else if(d)draftView(d);else compileView();}

// ── compile form ──
let lastKey=null,lastFp=null;
function fpOf(o){return JSON.stringify(o);}
function compileView(){
  navNew.className='active';
  const f={};
  const mk=(k,node)=>{f[k]=node;return node;};
  const form=el('div',{class:'card'},
    el('h2',{text:'Compile a workflow'}),
    el('label',{text:'Natural-language request'}), mk('nl',el('textarea',{placeholder:'Describe the workflow to build…'})),
    el('label',{text:'Compiler agent (which model compiles)'}), mk('ca',el('input',{value:'mock',placeholder:'e.g. claude-code'})),
    el('div',{class:'row'},
      el('div',null,el('label',{text:'Preferred agents (comma-sep)'}),mk('pa',el('input',{placeholder:'claude-code, codex'}))),
      el('div',null,el('label',{text:'Excluded agents'}),mk('xa',el('input',{placeholder:'codex'}))),
      el('div',null,el('label',{text:'Preferred nodes'}),mk('pn',el('input',{placeholder:'node_x'})))
    ),
    el('div',{class:'row'},
      el('div',null,el('label',{text:'Max rounds'}),mk('mr',el('input',{type:'number',min:'1',placeholder:'e.g. 10'}))),
      el('div',null,el('label',{text:'Max tasks'}),mk('mt',el('input',{type:'number',min:'1',placeholder:'e.g. 20'}))),
      el('div',null,el('label',{text:'Max runtime (seconds)'}),mk('rt',el('input',{type:'number',min:'1',placeholder:'e.g. 1800'})))
    ),
    el('label',{class:'row',style:'align-items:center;gap:8px;font-weight:600'}, mk('vt',el('input',{type:'checkbox',style:'width:auto'})), document.createTextNode(' Require verified tests before completion')),
    el('div',{class:'muted',id:'compile-msg'})
  );
  const submit=el('button',{text:'Compile',onclick:()=>doCompile(f,submit)});
  form.append(submit);
  app.replaceChildren(form);
}
function num(v){const n=parseInt(v,10);return Number.isFinite(n)&&n>0?n:undefined;}
function list(v){return String(v||'').split(',').map(s=>s.trim()).filter(Boolean);}
function doCompile(f,btn){
  const nl=f.nl.value.trim();const ca=f.ca.value.trim();
  const msg=document.getElementById('compile-msg');msg.className='muted';msg.textContent='';
  if(!nl){msg.className='err';msg.textContent='A request is required.';return;}
  if(!ca){msg.className='err';msg.textContent='A compiler agent is required.';return;}
  const constraints={};const pa=list(f.pa.value),xa=list(f.xa.value),pn=list(f.pn.value);
  if(pa.length)constraints.preferred_agents=pa;if(xa.length)constraints.excluded_agents=xa;if(pn.length)constraints.preferred_nodes=pn;
  const mr=num(f.mr.value),mt=num(f.mt.value),rt=num(f.rt.value);
  if(mr)constraints.max_rounds=mr;if(mt)constraints.max_tasks=mt;if(rt)constraints.max_runtime_seconds=rt;
  if(f.vt.checked)constraints.require_verified_tests=true;
  const payload={nl_request:nl,compiler_agent:ca,constraints};
  // ONE idempotency key per deliberate submission; reuse ONLY for retrying the same unchanged submission.
  const fp=fpOf(payload);
  if(fp!==lastFp){lastKey=uuid();lastFp=fp;}
  payload.idempotency_key=lastKey;
  btn.disabled=true;btn.textContent='Compiling…';
  api('POST','/v1/workflow-drafts/compile',payload).then(r=>{
    btn.disabled=false;btn.textContent='Compile';
    if(r.status===401){msg.className='err';msg.textContent='Not authorized — open this page with ?token=<api token>.';return;}
    if(r.status>=400||!r.body||!r.body.draft_id){msg.className='err';msg.textContent='Compile failed: '+((r.body&&r.body.code)||('http '+r.status));return;}
    go('/ui?draft='+encodeURIComponent(r.body.draft_id));
  }).catch(()=>{btn.disabled=false;btn.textContent='Compile';msg.className='err';msg.textContent='Network error.';});
}

// ── draft view ──
function badge(status){const m={ready:'b-ready',needs_input:'b-warn',impossible:'b-bad',policy_denied:'b-bad'};return el('span',{class:'badge '+(m[status]||'b-info'),text:status});}
function draftView(id){
  navNew.className='';
  app.replaceChildren(el('div',{class:'card'},el('div',{class:'muted',text:'Loading draft '+id+'…'})));
  const load=()=>{
    if(disposed)return;
    api('GET','/v1/workflow-drafts/'+encodeURIComponent(id)).then(r=>{
      if(disposed)return;
      if(r.status===401){app.replaceChildren(el('div',{class:'card err',text:'Not authorized — open with ?token=<api token>.'}));return;}
      if(r.status===404){app.replaceChildren(el('div',{class:'card err',text:'No such draft.'}));return;}
      if(r.status>=400||!r.body){app.replaceChildren(el('div',{class:'card err',text:'Error loading draft.'}));return;}
      renderDraft(r.body);
      const cs=r.body.compiler_status;
      if(!FINAL.has(cs)&&!disposed){pollTimer=setTimeout(load,1500);} // poll while non-final; stop on final / disposal
    }).catch(()=>{if(!disposed)pollTimer=setTimeout(load,2500);});
  };
  load();
}
function kvTable(rows){const t=el('table');for(const[k,v]of rows)t.append(el('tr',null,el('th',{text:k}),el('td',{class:'mono',text:v==null?'—':String(v)})));return t;}
function renderDraft(d){
  const cs=d.compiler_status,vs=d.validation_status;
  const head=el('div',{class:'card'},
    el('div',{class:'row',style:'align-items:center;gap:10px'},badge(cs),el('span',{class:'muted',text:'validation: '+vs+' · approval: '+(d.approval_status||'unapproved')})),
    el('div',{class:'muted mono',style:'margin-top:6px',text:'draft '+d.draft_id})
  );
  const blocks=[head];
  if(cs==='needs_input'&&Array.isArray(d.questions)&&d.questions.length){const ul=el('ul');d.questions.forEach(q=>ul.append(el('li',{text:q})));blocks.push(el('div',{class:'card'},el('h2',{text:'Needs input'}),ul));}
  if(cs==='impossible'||cs==='policy_denied'||vs==='invalid'){const ul=el('ul');(d.warnings||[]).forEach(w=>ul.append(el('li',{text:w})));blocks.push(el('div',{class:'card'},el('h2',{text:cs==='policy_denied'?'Policy denied':(vs==='invalid'?'Not valid':'Cannot compile')}),(d.warnings&&d.warnings.length)?ul:el('div',{class:'muted',text:'No further detail.'})));}
  if(cs==='ready'&&vs==='valid'&&d.preview){blocks.push(previewCard(d));blocks.push(approveCard(d));}
  if(d.rationale&&Object.keys(d.rationale).length){const pre=el('div',{class:'mono'});pre.textContent=JSON.stringify(d.rationale,null,2);blocks.push(el('div',{class:'card rationale'},el('h2',{text:'Compiler rationale'}),el('div',{class:'muted',text:'Model-generated — not authoritative.'}),pre));}
  app.replaceChildren(...blocks);
}
function previewCard(d){
  const p=d.preview,ps=p.policy_summary||{};
  const c=el('div',{class:'card'},el('h2',{text:'Preview'}));
  // trusted graphical map (server preview only) — with a text/list fallback below.
  const map=buildMap(p);
  if(map){c.append(el('h2',{text:'Workflow map'}),el('div',{class:'mapwrap'},map),mapLegend(),el('div',{class:'muted',text:'A read-only view of the server preview — no execution.'}));}
  // roles
  const rt=el('table');rt.append(el('tr',null,el('th',{text:'Role'}),el('th',{text:'Agent'}),el('th',{text:'Node'})));(ps.roles||[]).forEach(r=>rt.append(el('tr',null,el('td',{text:r.role}),el('td',{text:r.agent}),el('td',{class:'mono',text:r.node_id||'local'}))));
  c.append(el('h2',{text:'Roles & assignments'}),rt);
  // steps
  const st=el('table');st.append(el('tr',null,el('th',{text:'Step'}),el('th',{text:'Agent'}),el('th',{text:'Node'}),el('th',{text:'Workspace'}),el('th',{text:'Permission'}),el('th',{text:'Pause'})));(p.steps||[]).forEach(s=>st.append(el('tr',null,el('td',{text:s.id}),el('td',{text:s.agent||'—'}),el('td',{class:'mono',text:s.node_id||'—'}),el('td',{text:s.workspace?'yes':'no'}),el('td',{text:s.permission_mode||'default'}),el('td',{text:s.pause||'—'}))));
  c.append(el('h2',{text:'Steps'}),st);
  // edges (loop distinct)
  const et=el('table');et.append(el('tr',null,el('th',{text:'From'}),el('th',{text:'Kind'}),el('th',{text:'To'})));(p.edges||[]).forEach(e=>{et.append(el('tr',null,el('td',{text:e.from}),el('td',e.loop?{class:'edge-loop',text:'loop ⟲'}:{text:e.terminal?'terminal':'normal'}),el('td',{class:e.terminal?'mono':'',text:e.to})));});
  c.append(el('h2',{text:'Edges'}),et,el('div',{class:'muted',text:'loop edges: '+(p.loop_edges||0)+' · terminal routes: '+((p.terminal_routes||[]).join(', ')||'—')}));
  // workspace/permissions/network
  c.append(el('h2',{text:'Access & permissions'}),kvTable([
    ['workspace steps',(ps.workspace_access||[]).map(w=>w.step).join(', ')||'none'],
    ['permissions',(ps.permissions||[]).map(x=>x.step+':'+x.permission_mode).join(', ')||'default'],
    ['network capable',String(!!ps.network_capable)]
  ]));
  // limits
  const L=ps.limits||{};c.append(el('h2',{text:'Limits'}),kvTable([['max_tasks',L.max_tasks],['max_runtime_seconds',L.max_runtime_seconds],['max_rounds',L.max_rounds],['max_step_attempts',L.max_step_attempts],['max_failures',L.max_failures]]));
  // policies
  c.append(el('h2',{text:'Policies'}),kvTable([
    ['completion_policy',ps.completion_policy?JSON.stringify(ps.completion_policy):'none'],
    ['requires verified tests',String(!!ps.requires_verified_tests)],
    ['stall_policy',ps.stall_policy?JSON.stringify(ps.stall_policy):'none']
  ]));
  // warnings
  if((ps.external_side_effect_warnings||[]).length){const ul=el('ul');ps.external_side_effect_warnings.forEach(w=>ul.append(el('li',{text:w})));c.append(el('h2',{text:'Warnings'}),ul);}
  if((d.warnings||[]).length){const ul=el('ul');d.warnings.forEach(w=>ul.append(el('li',{text:w})));c.append(el('h2',{text:'Compiler warnings'}),ul);}
  // hashes
  c.append(el('h2',{text:'Hashes'}),kvTable([['spec_hash',d.spec_hash],['policy_summary_hash',d.policy_summary_hash],['inventory_hash',d.inventory_hash]]));
  return c;
}
// ── approval (explicit; binds to the exact spec_hash; NEVER starts) ──
function approveCard(d){
  const ps=(d.preview&&d.preview.policy_summary)||{};
  const c=el('div',{class:'card'});
  c.append(el('h2',{text:'Approve'}));
  if(d.materialized_workflow_id){
    c.append(el('div',{class:'muted',text:'This draft is approved.'}),
      el('div',{class:'mono',style:'margin:6px 0',text:'workflow '+d.materialized_workflow_id}),
      el('button',{text:'Open workflow',onclick:()=>go('/ui?workflow='+encodeURIComponent(d.materialized_workflow_id))}));
    return c;
  }
  c.append(el('div',{class:'muted',text:'Review the exact plan below, then approve. Approval creates a ready workflow — it does NOT start it.'}));
  c.append(el('h2',{text:'Confirmation summary'}),kvTable([
    ['agents/nodes',(ps.roles||[]).map(r=>r.role+'='+r.agent+(r.node_id?'@'+r.node_id:'')).join(', ')||'—'],
    ['workspace access',(ps.workspace_access||[]).map(w=>w.step).join(', ')||'none'],
    ['permissions',(ps.permissions||[]).map(x=>x.step+':'+x.permission_mode).join(', ')||'default'],
    ['network capable',String(!!ps.network_capable)],
    ['completion policy',ps.completion_policy?JSON.stringify(ps.completion_policy):'none'],
    ['side-effect warnings',(ps.external_side_effect_warnings||[]).join(' · ')||'none'],
    ['spec_hash',d.spec_hash]
  ]));
  const msg=el('div',{class:'muted',style:'margin-top:8px'});
  const btn=el('button',{text:'Approve this exact plan'});
  btn.addEventListener('click',()=>{
    if(!confirm('Approve this exact workflow (spec_hash '+String(d.spec_hash).slice(0,12)+'…)? This creates a ready workflow but does NOT start it.'))return;
    btn.disabled=true;btn.textContent='Approving…';msg.className='muted';msg.textContent='';
    api('POST','/v1/workflow-drafts/'+encodeURIComponent(d.draft_id)+'/approve',{spec_hash:d.spec_hash}).then(r=>{
      if(r.status===200&&r.body&&r.body.workflow_id){go('/ui?workflow='+encodeURIComponent(r.body.workflow_id));return;}
      btn.disabled=false;btn.textContent='Approve this exact plan';
      if(r.status===409){msg.className='err';msg.textContent='The draft changed since it was shown — reload and review before approving.';c.append(el('button',{class:'sec',text:'Reload draft',onclick:()=>draftView(d.draft_id)}));return;}
      msg.className='err';msg.textContent='Approval failed: '+((r.body&&r.body.code)||('http '+r.status));
    }).catch(()=>{btn.disabled=false;btn.textContent='Approve this exact plan';msg.className='err';msg.textContent='Network error.';});
  });
  c.append(btn,msg);
  return c;
}

// ── runtime view: monitor a ready/running/terminal workflow ──
const WF_TERMINAL=new Set(['completed','failed','cancelled']);
function wfBadge(s){const m={running:'b-info',blocked:'b-warn',completed:'b-ready',failed:'b-bad',cancelled:'b-bad',ready:'b-info'};return el('span',{class:'badge '+(m[s]||'b-info'),text:s});}
function workflowView(id){
  navNew.className='';
  app.replaceChildren(el('div',{class:'card'},el('div',{class:'muted',text:'Loading workflow '+id+'…'})));
  const seen=new Set();const events=[];let started=false;
  const state={wf:null};
  const render=()=>{
    if(disposed)return;
    const wf=state.wf;if(!wf)return;
    const s=wf.status;
    const head=el('div',{class:'card'},
      el('div',{class:'row',style:'align-items:center;gap:10px'},wfBadge(s),el('span',{class:'muted',text:(wf.name||'')+' · round '+(wf.current_round==null?'—':wf.current_round)})),
      el('div',{class:'mono muted',style:'margin-top:6px',text:'workflow '+id}),
      kvTable([['current step',wf.current_step_id||'—'],['tasks',wf.total_tasks],['failures',wf.total_failures],['reason',wf.reason||'—']])
    );
    // controls
    const ctl=el('div',{class:'row',style:'gap:10px;margin-top:4px'});
    if(s==='ready'){const b=el('button',{text:'Start workflow'});b.addEventListener('click',()=>{b.disabled=true;b.textContent='Starting…';api('POST','/v1/workflows/'+encodeURIComponent(id)+'/start').then(()=>{load();}).catch(()=>{b.disabled=false;b.textContent='Start workflow';});});ctl.append(b);}
    if(!WF_TERMINAL.has(s)&&s!=='ready'){const cb=el('button',{class:'sec',text:'Cancel'});cb.addEventListener('click',()=>{if(!confirm('Cancel this workflow? Its current Agent Task is cancelled; already-finished work keeps its result.'))return;cb.disabled=true;cb.textContent='Cancelling…';api('POST','/v1/workflows/'+encodeURIComponent(id)+'/cancel').then(()=>{load();}).catch(()=>{cb.disabled=false;cb.textContent='Cancel';});});ctl.append(cb);}
    head.append(ctl);
    // steps
    const stc=el('div',{class:'card'},el('h2',{text:'Steps'}));
    const st=el('table');st.append(el('tr',null,el('th',{text:'Step'}),el('th',{text:'Round'}),el('th',{text:'Status'})));(wf.step_executions||[]).forEach(se=>st.append(el('tr',null,el('td',{text:se.step_id}),el('td',{text:se.round}),el('td',null,wfBadge(se.status)))));stc.append(st);
    // events (bounded, deduped, no raw task logs — workflow lifecycle events only)
    const evc=el('div',{class:'card'},el('h2',{text:'Recent events'}));
    const et=el('table');et.append(el('tr',null,el('th',{text:'#'}),el('th',{text:'Event'}),el('th',{text:'When'})));
    events.slice(-40).forEach(e=>et.append(el('tr',null,el('td',{class:'mono',text:e.seq}),el('td',{text:e.type}),el('td',{class:'mono muted',text:e.ts||''}))));
    evc.append(et);if(!events.length)evc.append(el('div',{class:'muted',text:'No events yet.'}));
    app.replaceChildren(head,stc,evc);
  };
  // snapshot poll (status/step/round/counters) — stops on terminal / disposal
  const load=()=>{
    if(disposed)return;
    api('GET','/v1/workflows/'+encodeURIComponent(id)).then(r=>{
      if(disposed)return;
      if(r.status===401){app.replaceChildren(el('div',{class:'card err',text:'Not authorized — open with ?token=<api token>.'}));return;}
      if(r.status===404){app.replaceChildren(el('div',{class:'card err',text:'No such workflow.'}));return;}
      if(r.status>=400||!r.body){app.replaceChildren(el('div',{class:'card err',text:'Error loading workflow.'}));return;}
      state.wf=r.body;render();
      if(!started&&!WF_TERMINAL.has(r.body.status)){started=true;openEvents();}
      if(!WF_TERMINAL.has(r.body.status)&&!disposed)pollTimer=setTimeout(load,1500);else closeStream();
    }).catch(()=>{if(!disposed)pollTimer=setTimeout(load,2500);});
  };
  // live events via SSE (same-origin cookie auth). EventSource resumes with Last-Event-ID
  // on reconnect; we dedupe by seq so nothing is displayed twice. A disconnect NEVER cancels.
  const WF_EVENT_TYPES=['workflow.created','workflow.validated','workflow.started','step.started','step.task_created','step.completed','step.failed','edge.selected','workflow.round_advanced','workflow.blocked','workflow.paused','workflow.resumed','workflow.completed','workflow.failed','workflow.cancelled'];
  const onEv=(ev)=>{if(disposed)return;let d={};try{d=JSON.parse(ev.data)||{};}catch(e){}const seq=Number(d.seq!=null?d.seq:ev.lastEventId);if(!Number.isFinite(seq)||seen.has(seq))return;seen.add(seq);events.push({seq:seq,type:String(d.type||'event'),ts:String(d.ts||'')});events.sort((a,b)=>a.seq-b.seq);render();};
  const openEvents=()=>{
    closeStream();if(disposed||typeof EventSource==='undefined')return;
    try{stream=new EventSource('/v1/workflows/'+encodeURIComponent(id)+'/events');}catch(e){return;}
    // the gateway emits NAMED SSE events (event: <type>); register the known types.
    stream.onmessage=onEv; // (default/unnamed frames, if any)
    WF_EVENT_TYPES.forEach(t=>stream.addEventListener(t,onEv));
    stream.onerror=()=>{/* browser auto-reconnects with Last-Event-ID; never cancels execution */};
  };
  load();
}

window.addEventListener('pagehide',()=>{disposed=true;stopPoll();closeStream();});
route();
</script>
</body></html>`
}
