/**
 * Conversational Workflow Builder workspace — a self-contained page (one inline
 * nonce'd script, no external resources) served by the Agent Gateway at
 * `/ui/builder`. It drives the existing `/v1/workflow-builder/*` REST routes: a
 * persistent session sidebar + a conversation panel + a live draft/readiness panel.
 *
 * The DURABLE server history is the single source of truth (no client-only session
 * store, no optimistic assistant answers). Each turn carries ONE stable client
 * idempotency_key preserved across retries/timeouts; ambiguous sends reconcile from
 * the server; a builder_revision_conflict refreshes state without dropping the
 * composer text. Rendering is textContent-only (XSS-safe); no innerHTML.
 *
 * New sessions are created with a SELECTED compiler placement — an (agent, node)
 * pair from the authoritative advertised inventory (`GET /v1/agents`) — never a
 * hard-coded id. The pair matters: the backend compiler routes by exactly
 * (compiler_agent, compiler_node_id), so node-advertised agents must carry their
 * node_id or every compile fails closed. The default prefers a real advertised
 * agent over the deterministic `mock`; a stale selection blocks creation with a
 * clear message (no silent substitution). Each session's compiler placement is
 * fixed at creation and shown in its header.
 *
 * The right panel offers a live MAP (default) and DETAILS view of the current durable
 * draft — the map is the reusable framework-free SVG DAG from ./workflow-map.
 */
import { WORKFLOW_MAP_CSS, WORKFLOW_MAP_SCRIPT } from './workflow-map.js'

/** Render the conversational builder workspace. `nonce` locks the single inline script. */
export function workflowBuilderUiHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Workflow Builder</title>
<style>
:root{--bg:#0f1216;--panel:#161b22;--panel2:#1b222c;--line:#2a3340;--ink:#e6edf3;--muted:#8b98a8;--accent:#4c8dff;--good:#3ec27a;--warn:#e0b24d;--bad:#e06666;--user:#20303f}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow-x:hidden}
button{font:inherit;color:var(--ink);background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:.4rem .7rem;cursor:pointer}
button:hover:not(:disabled){border-color:var(--accent)} button:disabled{opacity:.5;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:#04101f;font-weight:600}
button.ghost{background:transparent}
textarea{font:inherit;color:var(--ink);background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:.55rem .65rem;width:100%;resize:vertical;min-height:44px}
select{font:inherit;color:var(--ink);background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:.35rem .45rem;flex:1;min-width:0}
select:disabled{opacity:.5}
a{color:var(--accent)} .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.hdr{display:flex;align-items:center;gap:.6rem;padding:.5rem .8rem;border-bottom:1px solid var(--line);background:var(--panel)}
.hdr h1{font-size:15px;margin:0;flex:1} .hdr .tabs{display:none;gap:.4rem}
.builder{display:grid;grid-template-columns:270px minmax(0,1fr) 360px;height:calc(100vh - 49px)}
.col{min-width:0;min-height:0;overflow:auto;border-right:1px solid var(--line)}
.draftpanel{border-right:none;border-left:1px solid var(--line);background:var(--panel)}
.sidebar{background:var(--panel)}
.sbtop{display:flex;gap:.4rem;padding:.6rem;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel);flex-wrap:wrap;align-items:center}
.sbnote{margin:.5rem .6rem 0}
.slist{list-style:none;margin:0;padding:.3rem}
.sitem{padding:.5rem .6rem;border-radius:8px;cursor:pointer;border:1px solid transparent}
.sitem:hover{background:var(--panel2)} .sitem.sel{background:var(--panel2);border-color:var(--accent)}
.sitem .t{font-weight:600;display:flex;align-items:center;gap:.4rem}
.sitem .p{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sitem .meta{display:flex;gap:.4rem;align-items:center;margin-top:.2rem;flex-wrap:wrap}
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block}
.dot.active{background:var(--accent)} .dot.processing{background:var(--warn);animation:none} .dot.ready{background:var(--good)} .dot.failed{background:var(--bad)} .dot.archived{background:var(--muted)}
.badge{font-size:11px;padding:.05rem .4rem;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.badge.b-ready{color:var(--good);border-color:var(--good)} .badge.b-warn{color:var(--warn);border-color:var(--warn)} .badge.b-bad{color:var(--bad);border-color:var(--bad)} .badge.b-arch{color:var(--muted)}
.conversation{display:flex;flex-direction:column}
.msgs{flex:1;overflow:auto;padding:1rem;display:flex;flex-direction:column;gap:.7rem}
.msg{max-width:80%;padding:.55rem .8rem;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:var(--user);border:1px solid var(--line)}
.msg.assistant{align-self:flex-start;background:var(--panel2);border:1px solid var(--line)}
.msg.system{align-self:center;background:transparent;color:var(--muted);font-size:12px;border:1px dashed var(--line)}
.msg.pending{opacity:.65} .msg .role{font-size:11px;color:var(--muted);margin-bottom:.15rem}
.msg.failed{border-color:var(--bad)}
.chips{display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.4rem}
.chip{font-size:12px;background:var(--panel);border:1px solid var(--warn);color:var(--warn);border-radius:999px;padding:.1rem .5rem}
.composer{border-top:1px solid var(--line);padding:.6rem;display:flex;flex-direction:column;gap:.4rem;background:var(--panel);position:sticky;bottom:0}
.composer .row{display:flex;gap:.5rem;align-items:flex-end}
.notice{padding:.4rem .6rem;border-radius:8px;font-size:12.5px;border:1px solid var(--line)}
.notice.warn{border-color:var(--warn);color:var(--warn)} .notice.bad{border-color:var(--bad);color:var(--bad)} .notice.info{color:var(--muted)}
.proc{display:flex;align-items:center;gap:.5rem;color:var(--warn);font-size:12.5px}
.card{margin:.6rem;padding:.6rem .7rem;background:var(--panel2);border:1px solid var(--line);border-radius:10px}
.card h3{margin:0 0 .35rem;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.kv{display:grid;grid-template-columns:auto 1fr;gap:.15rem .6rem;font-size:13px}
.kv .k{color:var(--muted)}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.3rem}
.step{padding:.35rem .5rem;background:var(--panel);border:1px solid var(--line);border-radius:8px;font-size:12.5px}
.scroll{overflow-x:auto}
details.raw>summary{cursor:pointer;color:var(--muted);font-size:12px;margin:.6rem}
pre.raw{margin:0 .6rem .6rem;padding:.6rem;background:#0b0e12;border:1px solid var(--line);border-radius:8px;overflow:auto;max-height:40vh;font-size:11.5px}
.empty{padding:2rem;color:var(--muted);text-align:center}
.hidden{display:none}
@media (max-width:860px){
  .hdr .tabs{display:flex}
  .builder{grid-template-columns:1fr}
  .sidebar,.draftpanel{position:fixed;top:49px;bottom:0;width:min(88vw,340px);z-index:20;box-shadow:0 0 0 100vmax rgba(0,0,0,.5);display:none}
  .sidebar{left:0} .draftpanel{right:0;border-left:1px solid var(--line)}
  .sidebar.open,.draftpanel.open{display:block}
  .conversation{display:flex}
  .msg{max-width:92%}
}
.dtabs{display:flex;gap:.3rem;padding:.5rem .6rem;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel)}
.dtabs button{padding:.3rem .7rem} .dtabs button.on{background:var(--accent);border-color:var(--accent);color:#04101f;font-weight:600}
.selnode{margin:.6rem;padding:.5rem .6rem;background:var(--panel2);border:1px solid var(--accent);border-radius:8px;font-size:12.5px}
.selnode .issue{color:var(--bad);margin-top:.3rem}
${WORKFLOW_MAP_CSS}
</style></head>
<body>
<div class="hdr"><h1>Workflow Builder</h1>
  <div class="tabs"><button id="tab-sessions" class="ghost" aria-label="Toggle sessions">Sessions</button><button id="tab-draft" class="ghost" aria-label="Toggle draft">Draft</button></div>
  <a href="/ui" id="link-manual">Manual builder</a>
</div>
<div id="app" class="builder" role="application" aria-label="Conversational workflow builder"></div>
<p id="status" role="status" aria-live="polite" class="hidden"></p>
<script nonce="${nonce}">
${WORKFLOW_MAP_SCRIPT}
${BUILDER_SCRIPT}
</script>
</body></html>`
}

// The page's client script (kept as a separate constant for readability; injected above).
const BUILDER_SCRIPT = String.raw`
'use strict';
var app=document.getElementById('app');
var statusEl=document.getElementById('status');
var tabSessions=document.getElementById('tab-sessions');
var tabDraft=document.getElementById('tab-draft');
function announce(m){if(statusEl)statusEl.textContent=String(m||'');}
function uuid(){try{if(crypto&&crypto.randomUUID)return crypto.randomUUID();}catch(e){}return 'k'+Date.now()+Math.random().toString(36).slice(2);}
function fmtTs(iso){if(!iso)return '';var d=new Date(iso);return isNaN(d.getTime())?String(iso):d.toLocaleString();}
var el=function(t,props){var n=document.createElement(t);if(props)for(var k in props){if(k==='class')n.className=props[k];else if(k==='text')n.textContent=props[k];else if(k.slice(0,2)==='on')n.addEventListener(k.slice(2),props[k]);else n.setAttribute(k,props[k]);}for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c!=null)n.append(c);}return n;};
function api(method,path,body){
  return fetch(path,{method:method,credentials:'same-origin',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined})
    .then(function(r){return r.json().catch(function(){return null;}).then(function(j){return{status:r.status,body:j};});})
    .catch(function(){return{status:0,body:null,net:true};});
}

// ── compiler-agent selection (authoritative inventory: GET /v1/agents) ──
// A selectable choice is a PLACEMENT — an (agent id, node_id|null) pair — because the
// backend compiler contract routes by exactly that pair: the builder session's
// compiler_agent + compiler_node_id must match one inventory placement (findPlacement)
// or every compile fails closed. Distinct nodes advertising the same agent id are
// therefore distinct choices, never collapsed.
var LS_KEY='vibe_builder_compiler_agent';
function lsGet(k){try{return window.localStorage.getItem(k);}catch(e){return null;}}
function lsSet(k,v){try{window.localStorage.setItem(k,v);}catch(e){}}
function lsDel(k){try{window.localStorage.removeItem(k);}catch(e){}}
function encChoice(id,node){return JSON.stringify([id,node||null]);}   // unambiguous for hostile ids
function decChoice(v){try{var a=JSON.parse(v);if(Array.isArray(a)&&typeof a[0]==='string'&&a[0])return{id:a[0],node_id:(typeof a[1]==='string'&&a[1])?a[1]:null};}catch(e){}return null;}
var agents=[];            // AVAILABLE advertised placements [{id,node_id,key}]
var agentsLoaded=false, agentsError=null, agentsReqSeq=0;
var selectedKey=lsGet(LS_KEY)||null;  // explicit choice key (restored per-browser); validated against inventory
if(selectedKey&&!decChoice(selectedKey)){selectedKey=null;lsDel(LS_KEY);} // untrusted storage: drop malformed silently
var creating=false;       // session-create in flight
var sbNotice=null;        // {kind,text} shown in the sidebar (selector-related)

// Available placements only, deduped by (id,node) pair. Advertised (server) order is
// preserved (stable sort); mock placements sort last.
function normalizeAgents(list){
  var seen={},out=[];
  (Array.isArray(list)?list:[]).forEach(function(a){
    if(!a||typeof a.id!=='string'||!a.id||!a.available)return;
    var node=(typeof a.node_id==='string'&&a.node_id)?a.node_id:null;
    var k=encChoice(a.id,node);
    if(seen[k])return;seen[k]=1;
    out.push({id:a.id,node_id:node,key:k});
  });
  out.sort(function(x,y){return (x.id==='mock'?1:0)-(y.id==='mock'?1:0);});
  return out;
}
function realAgents(){return agents.filter(function(a){return a.id!=='mock';});}
function choiceName(c){return c.id+(c.node_id?(' @ '+c.node_id):'');}
// Compact label: the node suffix appears only when the same agent id has multiple
// placements (disambiguation); mock is always marked deterministic.
function choiceLabel(c){
  var dup=agents.filter(function(a){return a.id===c.id;}).length>1;
  var base=dup?choiceName(c):c.id;
  return c.id==='mock'?base+' (deterministic)':base;
}
// Default order: previously selected available placement → first real advertised
// placement → mock only when no real agent is available. (No configured Builder
// default exists; that rung is intentionally vacant.)
function effectiveChoice(){
  if(!agents.length)return null;
  if(selectedKey){var m=agents.filter(function(a){return a.key===selectedKey;})[0];if(m)return m;}
  var real=realAgents();
  return real.length?real[0]:agents[0];
}
// A restored/explicit selection that is no longer advertised is DROPPED with a visible
// message (never silently carried into a session; never silently substituted at create).
function reconcileSelection(){
  if(selectedKey&&agentsLoaded&&!agents.some(function(a){return a.key===selectedKey;})){
    var c=decChoice(selectedKey);
    sbNotice={kind:'warn',text:'Compiler agent "'+(c?choiceName(c):'?')+'" is no longer available. Pick an agent before creating a session.'};
    selectedKey=null;lsDel(LS_KEY);
    return false;
  }
  return true;
}
// Applies a fresh inventory; returns FALSE when the current selection vanished (the
// reconcile notice is set and the selection cleared) — callers that are about to act
// on the selection MUST stop on false rather than fall through to the default.
function applyAgents(list){agents=normalizeAgents(list);agentsLoaded=true;agentsError=null;return reconcileSelection();}
function loadAgents(){
  var q=++agentsReqSeq; // ignore out-of-order responses (a stale reply never overwrites fresher inventory)
  api('GET','/v1/agents').then(function(r){if(disposed||q!==agentsReqSeq)return;
    if(r.status===200&&r.body&&Array.isArray(r.body.agents)){applyAgents(r.body.agents);}
    else if(r.status===401){authError=true;}
    else{agentsError='Could not load the compiler agent inventory.';}
    render();
  });
}

// ── durable state (server is the source of truth) ──
var sid=null;           // active session id
var sessions=[];        // list summaries
var model=null;         // {session,messages,draft,pending_turn}
var loading=false, listError=null, notFound=false, authError=false, backendDown=false;
var sending=false;      // our POST is in flight
var pendingKey=null;    // the ONE stable idempotency key for the in-flight/unfinished turn
var composerText='';    // preserved across re-renders + conflicts
var notice=null;        // {kind,text}
var pollTimer=null, disposed=false;
// ── draft/map view state ──
var draftTab=null;          // null=auto (map when structure present), 'map', 'details'
var selectedNodeId=null;    // selected map node (preserved while the same draft is active)
var selectedIssue=null;     // its validation issue text, when any
var mapLastDraftId=null, mapLastStepIds=[]; // for added-node highlighting on a real draft change

function go(url){history.pushState(null,'',url);route();}
window.addEventListener('popstate',route);
window.addEventListener('pagehide',function(){disposed=true;stopPoll();});
if(tabSessions)tabSessions.addEventListener('click',function(){var s=document.getElementById('sidebar');if(s)s.className='col sidebar'+(s.className.indexOf('open')<0?' open':'');});
if(tabDraft)tabDraft.addEventListener('click',function(){var d=document.getElementById('draftpanel');if(d)d.className='col draftpanel'+(d.className.indexOf('open')<0?' open':'');});

function stopPoll(){if(pollTimer){clearTimeout(pollTimer);pollTimer=null;}}
function schedulePoll(){stopPoll();if(disposed)return;pollTimer=setTimeout(function(){if(disposed||!sid)return;api('GET','/v1/workflow-builder/sessions/'+encodeURIComponent(sid)).then(function(r){if(disposed)return;if(r.status===200){setModel(r.body);render();if(isProcessing())schedulePoll();}});},1300);}

function route(){stopPoll();var u=new URL(location.href);var s=u.searchParams.get('session');sid=s||null;notFound=false;authError=false;backendDown=false;loadAgents();loadList();if(sid)loadSession(sid);else{model=null;render();}}

function loadList(){api('GET','/v1/workflow-builder/sessions').then(function(r){if(disposed)return;if(r.status===0){backendDown=true;}else if(r.status===401){authError=true;}else if(r.status===200&&r.body){sessions=r.body.sessions||[];listError=null;}else{listError=(r.body&&r.body.message)||'Could not load sessions';}render();});}

function loadSession(id,opts){opts=opts||{};loading=!model||model.session.builder_session_id!==id;render();
  api('GET','/v1/workflow-builder/sessions/'+encodeURIComponent(id)).then(function(r){if(disposed)return;loading=false;
    if(r.status===0){backendDown=true;}
    else if(r.status===401){authError=true;}
    else if(r.status===404){notFound=true;model=null;}
    else if(r.status===200){setModel(r.body);notFound=false;backendDown=false;if(!opts.keepComposer&&!pendingKey)composerText='';if(isProcessing())schedulePoll();}
    render();
  });
}
function setModel(m){model=m;var s=(m.messages||[]);}

function currentKind(){ // the last assistant turn's explicit outcome
  if(!model)return null;var ms=model.messages||[];for(var i=ms.length-1;i>=0;i--){if(ms[i].role==='assistant'){var md=ms[i].metadata||{};return md.kind||null;}}return null;
}
function isProcessing(){return !!(model&&model.pending_turn)||sending;}
function isArchived(){return !!(model&&model.session&&model.session.status==='archived');}

// ── send a turn: ONE stable key, preserved until authoritatively done/failed ──
function submitTurn(){
  if(!sid||!model||sending||isArchived())return;
  var text=composerText;
  if(!text||!text.trim())return;
  if(model.pending_turn){notice={kind:'warn',text:'A turn is already being processed. Please wait.'};render();return;}
  if(!pendingKey)pendingKey=uuid();            // generate ONCE per turn; reused on retry
  var expected=model.session.revision;
  sending=true;notice=null;render();announce('Sending…');
  api('POST','/v1/workflow-builder/sessions/'+encodeURIComponent(sid)+'/messages',{content:text,expected_revision:expected,idempotency_key:pendingKey})
    .then(function(r){if(disposed)return;sending=false;
      if(r.status===0||r.net){ notice={kind:'warn',text:'Network issue — reconciling with the server…'}; announce('Reconciling'); reconcile(); return; }
      if(r.status===200){ pendingKey=null; composerText=''; notice=null; loadSession(sid); return; }
      if(r.status===401){ authError=true; render(); return; }
      if(r.status===409&&r.body&&r.body.code==='builder_revision_conflict'){ notice={kind:'warn',text:'A newer turn was loaded. Your text is preserved — review and resend.'}; announce('Newer turn loaded'); loadSession(sid,{keepComposer:true}); return; }
      if(r.status===409&&r.body&&r.body.code==='builder_turn_in_progress'){ notice={kind:'warn',text:'A turn is already in progress. Waiting for it to finish…'}; loadSession(sid,{keepComposer:true}); return; }
      notice={kind:'bad',text:(r.body&&r.body.message)||('Send failed ('+r.status+')')}; render();
    });
}
// After an AMBIGUOUS failure: query the server (same session), never auto-resubmit a new turn.
function reconcile(){
  api('GET','/v1/workflow-builder/sessions/'+encodeURIComponent(sid)).then(function(r){if(disposed)return;
    if(r.status===200){ setModel(r.body);
      var landed=(model.messages||[]).some(function(m){return m.role==='assistant'&&m.turn_key===pendingKey;});
      if(landed){ pendingKey=null; composerText=''; notice=null; announce('Turn completed.'); }
      else { notice={kind:'warn',text:'Send was interrupted. Retry to resubmit the same turn (no duplicate).'}; }
      render(); if(isProcessing())schedulePoll();
    } else { notice={kind:'bad',text:'Could not reconcile — retry when ready.'}; render(); }
  });
}
function retryTurn(){ if(!pendingKey)return; submitTurn(); } // reuses the preserved key

// ── rendering ──
function render(){
  if(disposed)return;
  // reset a stale selection safely when a newer draft no longer contains that node
  if(selectedNodeId&&model&&model.draft){ if(draftNodeIds(model.draft).indexOf(selectedNodeId)<0){selectedNodeId=null;selectedIssue=null;} }
  app.replaceChildren(renderSidebar(), renderConversation(), renderDraft());
}
function statusBadge(s){var m={active:'',completed:'b-ready',archived:'b-arch'};return el('span',{class:'badge '+(m[s]||''),text:s});}
function outcomeDot(sm){
  var cls='active';
  if(sm.status==='archived')cls='archived';
  else if(sm.processing)cls='processing';
  else if(sm.last_outcome==='compile_failed')cls='failed';
  else if(sm.last_outcome==='ready_for_review'||sm.draft_ready)cls='ready';
  return el('span',{class:'dot '+cls,title:cls,'aria-label':cls});
}
function renderSidebar(){
  var side=el('div',{id:'sidebar',class:'col sidebar'});
  var top=el('div',{class:'sbtop'});
  // compiler selector — options come ONLY from the advertised inventory (labels via textContent)
  var sel=el('select',{id:'compiler-select','aria-label':'Compiler agent for new sessions',title:'Compiler agent for new sessions'});
  if(!agentsLoaded){sel.append(el('option',{value:'',text:agentsError?'agents unavailable':'loading agents…'}));sel.disabled=true;}
  else if(!agents.length){sel.append(el('option',{value:'',text:'no agents available'}));sel.disabled=true;}
  else agents.forEach(function(a){sel.append(el('option',{value:a.key,text:choiceLabel(a),title:choiceName(a)}));});
  var eff=effectiveChoice(); if(eff)sel.value=eff.key;
  sel.addEventListener('change',function(){selectedKey=sel.value;lsSet(LS_KEY,sel.value);sbNotice=null;render();});
  var nb=el('button',{id:'new-session',class:'primary',onclick:createSession,text:creating?'Creating…':'New session'});
  nb.disabled=creating||(agentsLoaded&&!agents.length);
  top.append(sel,nb);
  side.append(top);
  if(sbNotice)side.append(el('div',{class:'notice sbnote '+(sbNotice.kind||'info'),id:'compiler-notice',text:sbNotice.text}));
  if(agentsError)side.append(el('div',{class:'notice sbnote bad',id:'agents-error',text:agentsError}));
  if(agentsLoaded&&agents.length&&!realAgents().length)
    side.append(el('div',{class:'notice sbnote info',id:'mock-only-note',text:'Real conversational compilation is unavailable — no real compiler agent is advertised. New sessions use the deterministic mock compiler.'}));
  if(agentsLoaded&&!agents.length)
    side.append(el('div',{class:'notice sbnote warn',id:'no-agents-note',text:'No compiler agents are advertised — sessions cannot be created until an agent is available.'}));
  if(backendDown){side.append(el('div',{class:'empty',text:'Builder backend unavailable. Retrying…'}));return side;}
  if(listError){side.append(el('div',{class:'empty',text:listError}));return side;}
  var ul=el('ul',{class:'slist'});
  var sorted=(sessions||[]).slice().sort(function(a,b){return String(b.updated_at).localeCompare(String(a.updated_at));});
  if(!sorted.length)ul.append(el('li',{class:'empty',text:'No sessions yet. Start one above.'}));
  sorted.forEach(function(sm){
    var li=el('li',{class:'sitem'+(sm.builder_session_id===sid?' sel':''),role:'button',tabindex:'0',onclick:function(){openSession(sm.builder_session_id);}});
    var t=el('div',{class:'t'});t.append(outcomeDot(sm),el('span',{text:sm.title||'Untitled'}));
    var meta=el('div',{class:'meta'});meta.append(statusBadge(sm.status));
    if(sm.processing)meta.append(el('span',{class:'badge b-warn',text:'processing'}));
    else if(sm.last_outcome==='compile_failed')meta.append(el('span',{class:'badge b-bad',text:'compile failed'}));
    else if(sm.last_outcome==='ready_for_review'||sm.draft_ready)meta.append(el('span',{class:'badge b-ready',text:'ready'}));
    meta.append(el('span',{class:'badge',text:fmtTs(sm.updated_at)}));
    li.append(t,meta);
    if(sm.last_message_preview)li.append(el('div',{class:'p',text:sm.last_message_preview}));
    ul.append(li);
  });
  side.append(ul);return side;
}
function renderConversation(){
  var conv=el('div',{id:'conversation',class:'col conversation'});
  var msgs=el('div',{id:'msgs',class:'msgs'});
  if(authError){msgs.append(el('div',{class:'empty',text:'Authentication failed. Reload the page to re-authenticate.'}));conv.append(msgs);return conv;}
  if(backendDown){msgs.append(el('div',{class:'empty',text:'Builder backend unavailable.'}));conv.append(msgs);return conv;}
  if(!sid){msgs.append(el('div',{class:'empty',text:'Select a session, or start a new one, to begin building a workflow by conversation.'}));conv.append(msgs);return conv;}
  if(notFound){msgs.append(el('div',{class:'empty',text:'Session not found.'}));conv.append(msgs);return conv;}
  if(loading||!model){msgs.append(el('div',{class:'empty',text:'Loading conversation…'}));conv.append(msgs);return conv;}
  var head=el('div',{class:'sbtop'});
  head.append(el('span',{class:'t',text:(model.session.title||'Untitled')}),statusBadge(model.session.status));
  // the session's OWNING compiler placement — persisted session data only (never the
  // current selector/inventory); fixed at creation (no mid-session switching)
  if(model.session.compiler_agent)head.append(el('span',{class:'badge'+(model.session.compiler_agent==='mock'?' b-warn':''),id:'session-compiler',title:'Compiler agent for this session (fixed at creation)',text:'compiler: '+model.session.compiler_agent+(model.session.compiler_node_id?(' @ '+model.session.compiler_node_id):'')}));
  if(!isArchived())head.append(el('button',{id:'archive-session',class:'ghost',onclick:archiveSession,text:'Archive'}));
  conv.append(head);
  var kind=currentKind();
  (model.messages||[]).forEach(function(m){msgs.append(msgBubble(m));});
  // clarification: surface missing concepts as chips under the last assistant message
  if(kind==='clarification_required'){
    var last=lastAssistant();var missing=(last&&last.metadata&&last.metadata.missing)||[];
    if(missing.length){var ch=el('div',{class:'chips','aria-label':'Missing information'});missing.forEach(function(x){ch.append(el('span',{class:'chip',text:String(x)}));});msgs.append(ch);}
  }
  if(sending&&composerText.trim())msgs.append(msgBubble({role:'user',content:composerText,_pending:true}));
  conv.append(msgs,renderComposer());return conv;
}
function lastAssistant(){var ms=(model&&model.messages)||[];for(var i=ms.length-1;i>=0;i--)if(ms[i].role==='assistant')return ms[i];return null;}
function msgBubble(m){
  var kind=(m.metadata&&m.metadata.kind)||'';
  var cls='msg '+(m.role||'system')+(m._pending?' pending':'')+(kind==='compile_failed'?' failed':'');
  var b=el('div',{class:cls});
  b.append(el('div',{class:'role',text:m.role+(m._pending?' · sending…':'')}));
  b.append(el('span',{text:String(m.content||'')}));
  return b;
}
function renderComposer(){
  var c=el('div',{id:'composer',class:'composer'});
  if(notice)c.append(el('div',{class:'notice '+(notice.kind||'info'),text:notice.text}));
  if(model&&model.pending_turn&&!sending)c.append(el('div',{class:'proc',text:'A turn is processing… the composer is disabled until it completes.'}));
  if(isArchived()){c.append(el('div',{class:'notice info',text:'This session is archived (read-only). It remains fully viewable.'}));return c;}
  var ta=el('textarea',{id:'composer-input','aria-label':'Message',placeholder:'Describe the workflow, or answer the question…',rows:'2'});
  ta.value=composerText;
  ta.disabled=sending||isProcessing();
  ta.addEventListener('input',function(){composerText=ta.value;});
  ta.addEventListener('keydown',function(ev){if(ev.key==='Enter'&&!ev.shiftKey){if(ev.preventDefault)ev.preventDefault();composerText=ta.value;submitTurn();}});
  var row=el('div',{class:'row'});row.append(ta);
  if(pendingKey&&!sending){ row.append(el('button',{id:'retry-turn',class:'ghost',onclick:function(){composerText=ta.value;retryTurn();},text:'Retry'})); }
  var send=el('button',{id:'send-turn',class:'primary',onclick:function(){composerText=ta.value;submitTurn();},text:sending?'Sending…':'Send'});
  send.disabled=sending||isProcessing();
  row.append(send);
  c.append(row);
  return c;
}
// Node ids the current draft's map contains (start + steps + verifier + terminals).
function draftNodeIds(d){
  if(!d||!d.preview)return [];
  var pv=d.preview; var ids=['__start']; (pv.steps||[]).forEach(function(s){ids.push(s.id);});
  if(pv.policy_summary&&pv.policy_summary.requires_verified_tests)ids.push('__verifier');
  (pv.terminal_routes||[]).forEach(function(t){ids.push(t);});
  return ids;
}
function stepIdsOf(d){return (d&&d.preview&&d.preview.steps||[]).map(function(s){return s.id;});}
function draftHasStructure(d){return !!(d&&d.preview&&(d.preview.steps||[]).length);}
function activeDraftTab(d){ if(draftTab)return draftTab; return draftHasStructure(d)?'map':'details'; }

// Re-render ONLY the draft panel (tab switch / node select) — never rebuilds conversation.
function rerenderDraft(){var dp=document.getElementById('draftpanel');if(dp)dp.replaceChildren.apply(dp,draftChildren());}

function renderDraft(){var p=el('div',{id:'draftpanel',class:'col draftpanel'});p.append.apply(p,draftChildren());return p;}

function draftChildren(){
  if(!sid||!model)return [el('div',{class:'empty',text:'The current draft and readiness will appear here.'})];
  var out=[]; var d=model.draft;var kind=currentKind();
  var head=el('div',{class:'card'}); head.append(el('h3',{text:'Draft'}));
  var name=(d&&d.preview&&d.preview.name)||(model.session.title)||'—';
  head.append(el('div',{class:'kv'},el('span',{class:'k',text:'Name'}),el('span',{text:name}),el('span',{class:'k',text:'Readiness'}),readiness(kind,d)));
  out.push(head);
  // Review action (ready_for_review) — SAME current_draft_id/spec_hash as the map; routes
  // to the EXISTING draft/approval page. Never approves/materializes/starts.
  if(d&&((kind==='ready_for_review')||(d.validation_status==='valid'&&d.spec_hash))){
    var rc=el('div',{class:'card'});
    rc.append(el('button',{id:'review-workflow',class:'primary',onclick:function(){go('/ui?draft='+encodeURIComponent(d.draft_id));},text:'Review workflow'}));
    rc.append(el('div',{class:'kv'},el('span',{class:'k',text:'spec hash'}),el('span',{class:'mono',text:d.spec_hash||'—'})));
    out.push(rc);
  }
  // Map | Details tabs
  var tab=activeDraftTab(d);
  var tabbar=el('div',{class:'dtabs'});
  tabbar.append(el('button',{id:'dtab-map',class:tab==='map'?'on':'',onclick:function(){draftTab='map';rerenderDraft();},text:'Map'}));
  tabbar.append(el('button',{id:'dtab-details',class:tab==='details'?'on':'',onclick:function(){draftTab='details';rerenderDraft();},text:'Details'}));
  out.push(tabbar);
  if(tab==='map'){ mapView(d,kind).forEach(function(x){out.push(x);}); }
  else { detailsCards(d,kind).forEach(function(x){out.push(x);}); }
  return out;
}

function mapView(d,kind){
  var out=[];
  var missing=[]; var la=lastAssistant(); if(la&&la.metadata&&la.metadata.missing)missing=la.metadata.missing;
  // added-node highlighting only on a REAL draft change (not on tab switches)
  var curStepIds=stepIdsOf(d); var prevIds=(d&&d.draft_id!==mapLastDraftId)?mapLastStepIds:null;
  var m=buildWorkflowMap({preview:d?d.preview:null,validation_status:d?d.validation_status:'pending',warnings:d?(d.warnings||[]):[],kind:kind,missing:missing,selectedId:selectedNodeId,prevIds:prevIds,onSelect:onMapSelect});
  if(d&&d.draft_id!==mapLastDraftId){mapLastDraftId=d.draft_id;mapLastStepIds=curStepIds;}
  out.push(m.root);
  // selected-node inspector (reveals the node's validation issue in the panel)
  if(selectedNodeId){
    var box=el('div',{class:'selnode',id:'selnode'});
    box.append(el('div',{text:'Selected: '+selectedNodeId}));
    var st=(d&&d.preview&&d.preview.steps||[]).filter(function(s){return s.id===selectedNodeId;})[0];
    if(st)box.append(el('div',{class:'muted',text:(st.agent||'agent not selected')+(st.node_id?(' @ '+st.node_id):'')+(st.workspace_write?' · writes workspace':'')+(st.verify?(' · verifier '+st.verify):'')+' · '+(st.permission_mode||'default')}));
    if(selectedIssue){box.append(el('div',{class:'issue',text:'Validation: '+selectedIssue}));box.append(el('button',{class:'ghost',onclick:function(){draftTab='details';rerenderDraft();},text:'View in Details'}));}
    out.push(box);
  }
  return out;
}

function detailsCards(d,kind){
  var out=[];
  if(!d){out.push(el('div',{class:'card'},el('div',{class:'empty',text:'No draft yet — send a message to compile one.'})));return out;}
  var pv=d.preview||{};var ps=pv.policy_summary||{};
  // roles / agents / nodes
  var roles=ps.roles||[];
  if(roles.length){var rcard=el('div',{class:'card'});rcard.append(el('h3',{text:'Roles · agents · nodes'}));
    roles.forEach(function(r){rcard.append(el('div',{class:'kv'},el('span',{class:'k',text:r.role||'role'}),el('span',{text:(r.agent||'—')+(r.node_id?(' @ '+r.node_id):'')})));});out.push(rcard);}
  // verifier + completion policy
  var meta=el('div',{class:'card'});meta.append(el('h3',{text:'Policy'}));
  meta.append(el('div',{class:'kv'},
    el('span',{class:'k',text:'verifier'}),el('span',{text:ps.requires_verified_tests?'required (system-verified tests)':'none'}),
    el('span',{class:'k',text:'network'}),el('span',{text:ps.network_capable?'enabled':'disabled'}),
    el('span',{class:'k',text:'completion'}),el('span',{class:'mono scroll',text:ps.completion_policy?JSON.stringify(ps.completion_policy):'—'})));
  out.push(meta);
  // steps in execution order
  var steps=pv.steps||[];
  if(steps.length){var sc=el('div',{class:'card'});sc.append(el('h3',{text:'Steps (execution order)'}));var ol=el('ol',{class:'steps'});
    steps.forEach(function(s){ol.append(el('li',{class:'step',text:(s.id||'step')+' — '+(s.agent||'?')+(s.node_id?(' @ '+s.node_id):'')+(s.workspace_write?' · writes':s.workspace?' · workspace':'')+(s.verify?(' · ✓'+s.verify):'')+' · '+(s.permission_mode||'default')}));});
    sc.append(ol);out.push(sc);}
  // validation issues (warnings when invalid) — also targeted by map-node selection
  if(d.validation_status!=='valid'&&(d.warnings||[]).length){var vc=el('div',{class:'card',id:'validation-issues'});vc.append(el('h3',{text:'Validation issues'}));(d.warnings||[]).slice(0,20).forEach(function(w){vc.append(el('div',{class:'step',text:String(w)}));});out.push(vc);}
  // identity
  out.push(el('div',{class:'card'},el('h3',{text:'Identity'}),el('div',{class:'kv'},
    el('span',{class:'k',text:'draft id'}),el('span',{class:'mono',text:d.draft_id||'—'}),
    el('span',{class:'k',text:'spec hash'}),el('span',{class:'mono scroll',text:d.spec_hash||'—'}),
    el('span',{class:'k',text:'revision'}),el('span',{text:String(model.session.revision)}))));
  // advanced: raw JSON (collapsed, NOT the default)
  var det=el('details',{class:'raw'});det.append(el('summary',{text:'Raw draft JSON (advanced)'}));det.append(el('pre',{class:'raw',text:JSON.stringify(d,null,2)}));out.push(det);
  return out;
}
function onMapSelect(id,info){ selectedNodeId=id; selectedIssue=(info&&info.issue)||null; rerenderDraft(); }
function readiness(kind,d){
  var map={ready_for_review:['b-ready','ready for review'],clarification_required:['b-warn','clarification required'],draft_updated:['b-info','draft updated'],compile_failed:['b-bad','compile failed']};
  var m=map[kind]||(d&&d.validation_status==='valid'?['b-ready','ready for review']:['','pending']);
  return el('span',{class:'badge '+m[0],text:m[1]});
}

// ── actions ──
// Create with the SELECTED compiler placement, re-validated against a FRESH
// authoritative inventory at click time. A selection that disappeared blocks creation
// with a clear message — never silently substituted, never silently downgraded to mock.
// The POST carries compiler_node_id when the placement is node-advertised: the backend
// compiler routes by the exact (agent, node) pair, so dropping the node would make
// every compile of a remote agent fail closed.
function createSession(){
  if(creating)return;
  creating=true;sbNotice=null;render();
  ++agentsReqSeq; // this fresh fetch supersedes any in-flight background load
  api('GET','/v1/agents').then(function(r){if(disposed)return;
    if(r.status===401){creating=false;authError=true;render();return;}
    if(r.status!==200||!r.body||!Array.isArray(r.body.agents)){creating=false;sbNotice={kind:'bad',text:'Could not load the compiler agent inventory — no session was created.'};render();return;}
    // The create decision is anchored to THIS fresh response. A selection that
    // vanished blocks creation HERE (sbNotice names it) — never falls through to
    // the default, never substitutes.
    if(!applyAgents(r.body.agents)){creating=false;render();return;}
    var choice=effectiveChoice();
    if(!choice){creating=false;sbNotice={kind:'bad',text:'No compiler agents are currently available — a session cannot be created.'};render();return;}
    var body={compiler_agent:choice.id};
    if(choice.node_id)body.compiler_node_id=choice.node_id;
    api('POST','/v1/workflow-builder/sessions',body).then(function(r2){if(disposed)return;creating=false;
      if(r2.status===201&&r2.body&&r2.body.session){ lsSet(LS_KEY,choice.key); sessions.unshift({builder_session_id:r2.body.session.builder_session_id,title:r2.body.session.title,status:'active',updated_at:r2.body.session.updated_at,revision:r2.body.session.revision,draft_ready:false,processing:false,last_outcome:null,last_message_preview:null}); go('/ui/builder?session='+encodeURIComponent(r2.body.session.builder_session_id)); }
      else if(r2.status===401){authError=true;render();}
      else{sbNotice={kind:'bad',text:(r2.body&&r2.body.message)||'Could not create a session'};render();}
    });
  });
}
function openSession(id){ pendingKey=null; composerText=''; notice=null; selectedNodeId=null; selectedIssue=null; draftTab=null; go('/ui/builder?session='+encodeURIComponent(id)); }
function archiveSession(){
  if(!sid)return;
  api('POST','/v1/workflow-builder/sessions/'+encodeURIComponent(sid)+'/archive').then(function(r){if(disposed)return;if(r.status===200){loadList();loadSession(sid);}});
}

route();
`
