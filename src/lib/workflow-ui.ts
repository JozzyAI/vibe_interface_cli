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
const uuid=()=>{try{return crypto.randomUUID().replace(/-/g,'').slice(0,24);}catch(e){return 'k'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);}};
function api(method,path,body){return fetch(path,{method,credentials:'same-origin',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}).then(async r=>{let j=null;try{j=await r.json();}catch(e){}return{status:r.status,body:j};});}
function go(url){history.pushState(null,'',url);route();}
window.addEventListener('popstate',route);
navNew.addEventListener('click',()=>go('/ui'));

let pollTimer=null,disposed=false;
function stopPoll(){if(pollTimer){clearTimeout(pollTimer);pollTimer=null;}}
function route(){stopPoll();disposed=false;const u=new URL(location.href);const d=u.searchParams.get('draft');if(d)draftView(d);else compileView();}

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
  if(cs==='ready'&&vs==='valid'&&d.preview){blocks.push(previewCard(d));}
  if(d.rationale&&Object.keys(d.rationale).length){const pre=el('div',{class:'mono'});pre.textContent=JSON.stringify(d.rationale,null,2);blocks.push(el('div',{class:'card rationale'},el('h2',{text:'Compiler rationale'}),el('div',{class:'muted',text:'Model-generated — not authoritative.'}),pre));}
  app.replaceChildren(...blocks);
}
function previewCard(d){
  const p=d.preview,ps=p.policy_summary||{};
  const c=el('div',{class:'card'},el('h2',{text:'Preview'}));
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
window.addEventListener('pagehide',()=>{disposed=true;stopPoll();});
route();
</script>
</body></html>`
}
