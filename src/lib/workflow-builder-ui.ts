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
 */

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
a{color:var(--accent)} .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.hdr{display:flex;align-items:center;gap:.6rem;padding:.5rem .8rem;border-bottom:1px solid var(--line);background:var(--panel)}
.hdr h1{font-size:15px;margin:0;flex:1} .hdr .tabs{display:none;gap:.4rem}
.builder{display:grid;grid-template-columns:270px minmax(0,1fr) 360px;height:calc(100vh - 49px)}
.col{min-width:0;min-height:0;overflow:auto;border-right:1px solid var(--line)}
.draftpanel{border-right:none;border-left:1px solid var(--line);background:var(--panel)}
.sidebar{background:var(--panel)}
.sbtop{display:flex;gap:.4rem;padding:.6rem;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel)}
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
</style></head>
<body>
<div class="hdr"><h1>Workflow Builder</h1>
  <div class="tabs"><button id="tab-sessions" class="ghost" aria-label="Toggle sessions">Sessions</button><button id="tab-draft" class="ghost" aria-label="Toggle draft">Draft</button></div>
  <a href="/ui" id="link-manual">Manual builder</a>
</div>
<div id="app" class="builder" role="application" aria-label="Conversational workflow builder"></div>
<p id="status" role="status" aria-live="polite" class="hidden"></p>
<script nonce="${nonce}">
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

function go(url){history.pushState(null,'',url);route();}
window.addEventListener('popstate',route);
window.addEventListener('pagehide',function(){disposed=true;stopPoll();});
if(tabSessions)tabSessions.addEventListener('click',function(){var s=document.getElementById('sidebar');if(s)s.className='col sidebar'+(s.className.indexOf('open')<0?' open':'');});
if(tabDraft)tabDraft.addEventListener('click',function(){var d=document.getElementById('draftpanel');if(d)d.className='col draftpanel'+(d.className.indexOf('open')<0?' open':'');});

function stopPoll(){if(pollTimer){clearTimeout(pollTimer);pollTimer=null;}}
function schedulePoll(){stopPoll();if(disposed)return;pollTimer=setTimeout(function(){if(disposed||!sid)return;api('GET','/v1/workflow-builder/sessions/'+encodeURIComponent(sid)).then(function(r){if(disposed)return;if(r.status===200){setModel(r.body);render();if(isProcessing())schedulePoll();}});},1300);}

function route(){stopPoll();var u=new URL(location.href);var s=u.searchParams.get('session');sid=s||null;notFound=false;authError=false;backendDown=false;loadList();if(sid)loadSession(sid);else{model=null;render();}}

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
  var wrap=el('div',{id:'sidebar-wrap'}); // placeholder; we mount directly
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
  top.append(el('button',{id:'new-session',class:'primary',onclick:createSession,text:'New session'}));
  side.append(top);
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
function renderDraft(){
  var p=el('div',{id:'draftpanel',class:'col draftpanel'});
  if(!sid||!model){p.append(el('div',{class:'empty',text:'The current draft and readiness will appear here.'}));return p;}
  var d=model.draft;var kind=currentKind();
  var head=el('div',{class:'card'});
  head.append(el('h3',{text:'Draft'}));
  var name=(d&&d.preview&&d.preview.name)||(model.session.title)||'—';
  head.append(el('div',{class:'kv'},el('span',{class:'k',text:'Name'}),el('span',{text:name}),el('span',{class:'k',text:'Readiness'}),readiness(kind,d)));
  p.append(head);
  if(!d){p.append(el('div',{class:'card'},el('div',{class:'empty',text:'No draft yet — send a message to compile one.'})));return p;}
  // review action when ready for review — routes to the EXISTING draft/approval view
  if((kind==='ready_for_review')||(d.validation_status==='valid'&&d.spec_hash)){
    var rc=el('div',{class:'card'});
    rc.append(el('button',{id:'review-workflow',class:'primary',onclick:function(){go('/ui?draft='+encodeURIComponent(d.draft_id));},text:'Review workflow'}));
    rc.append(el('div',{class:'kv'},el('span',{class:'k',text:'spec hash'}),el('span',{class:'mono',text:d.spec_hash||'—'})));
    p.append(rc);
  }
  var pv=d.preview||{};var ps=pv.policy_summary||{};
  // roles / agents / nodes
  var roles=ps.roles||[];
  if(roles.length){var rcard=el('div',{class:'card'});rcard.append(el('h3',{text:'Roles · agents · nodes'}));
    roles.forEach(function(r){rcard.append(el('div',{class:'kv'},el('span',{class:'k',text:r.role||'role'}),el('span',{text:(r.agent||'—')+(r.node_id?(' @ '+r.node_id):'')})));});p.append(rcard);}
  // verifier + completion policy
  var meta=el('div',{class:'card'});meta.append(el('h3',{text:'Policy'}));
  meta.append(el('div',{class:'kv'},
    el('span',{class:'k',text:'verifier'}),el('span',{text:ps.requires_verified_tests?'required (system-verified tests)':'none'}),
    el('span',{class:'k',text:'network'}),el('span',{text:ps.network_capable?'enabled':'disabled'}),
    el('span',{class:'k',text:'completion'}),el('span',{class:'mono scroll',text:ps.completion_policy?JSON.stringify(ps.completion_policy):'—'})));
  p.append(meta);
  // steps in execution order
  var steps=pv.steps||[];
  if(steps.length){var sc=el('div',{class:'card'});sc.append(el('h3',{text:'Steps (execution order)'}));var ol=el('ol',{class:'steps'});
    steps.forEach(function(s){ol.append(el('li',{class:'step',text:(s.id||'step')+' — '+(s.agent||'?')+(s.node_id?(' @ '+s.node_id):'')+(s.workspace?' · workspace':'')+' · '+(s.permission_mode||'default')}));});
    sc.append(ol);p.append(sc);}
  // validation issues (warnings when invalid)
  if(d.validation_status!=='valid'&&(d.warnings||[]).length){var vc=el('div',{class:'card'});vc.append(el('h3',{text:'Validation issues'}));(d.warnings||[]).slice(0,20).forEach(function(w){vc.append(el('div',{class:'step',text:String(w)}));});p.append(vc);}
  // identity
  p.append(el('div',{class:'card'},el('h3',{text:'Identity'}),el('div',{class:'kv'},
    el('span',{class:'k',text:'draft id'}),el('span',{class:'mono',text:d.draft_id||'—'}),
    el('span',{class:'k',text:'spec hash'}),el('span',{class:'mono scroll',text:d.spec_hash||'—'}),
    el('span',{class:'k',text:'revision'}),el('span',{text:String(model.session.revision)}))));
  // advanced: raw JSON (collapsed, NOT the default)
  var det=el('details',{class:'raw'});det.append(el('summary',{text:'Raw draft JSON (advanced)'}));det.append(el('pre',{class:'raw',text:JSON.stringify(d,null,2)}));p.append(det);
  return p;
}
function readiness(kind,d){
  var map={ready_for_review:['b-ready','ready for review'],clarification_required:['b-warn','clarification required'],draft_updated:['b-info','draft updated'],compile_failed:['b-bad','compile failed']};
  var m=map[kind]||(d&&d.validation_status==='valid'?['b-ready','ready for review']:['','pending']);
  return el('span',{class:'badge '+m[0],text:m[1]});
}

// ── actions ──
function createSession(){
  api('POST','/v1/workflow-builder/sessions',{compiler_agent:'mock'}).then(function(r){if(disposed)return;
    if(r.status===201&&r.body&&r.body.session){ sessions.unshift({builder_session_id:r.body.session.builder_session_id,title:r.body.session.title,status:'active',updated_at:r.body.session.updated_at,revision:r.body.session.revision,draft_ready:false,processing:false,last_outcome:null,last_message_preview:null}); go('/ui/builder?session='+encodeURIComponent(r.body.session.builder_session_id)); }
    else if(r.status===401){authError=true;render();}
    else{notice={kind:'bad',text:(r.body&&r.body.message)||'Could not create a session'};render();}
  });
}
function openSession(id){ pendingKey=null; composerText=''; notice=null; go('/ui/builder?session='+encodeURIComponent(id)); }
function archiveSession(){
  if(!sid)return;
  api('POST','/v1/workflow-builder/sessions/'+encodeURIComponent(sid)+'/archive').then(function(r){if(disposed)return;if(r.status===200){loadList();loadSession(sid);}});
}

route();
`
