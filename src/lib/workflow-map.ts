/**
 * Reusable live Workflow MAP — a small, framework-free SVG DAG renderer over the
 * AUTHORITATIVE draft preview (the same `preview` the compiler already produces:
 * entry_step + steps[] + edges[] + policy_summary). It invents no nodes/edges, mutates
 * nothing, and never approves/starts. Shared as an inline script + CSS string so the
 * builder page (and any future page) can embed it without a graph framework.
 *
 * Rendering is textContent/SVG-DOM only (no innerHTML). Visual state uses shape, border,
 * icon AND label — never colour alone. Layout is deterministic for the same draft
 * (level-based DAG, index sorted by id), so node positions are stable across turns and
 * selection can be preserved by node id.
 */

export const WORKFLOW_MAP_CSS = String.raw`
.wfmap-wrap{display:flex;flex-direction:column;gap:.4rem}
.wfmap-toolbar{display:flex;gap:.4rem;align-items:center}
.wfmap-toolbar .sp{flex:1}
.wfmap-scroll{overflow:auto;max-height:52vh;border:1px solid var(--line);border-radius:8px;background:#0b0e12;max-width:100%}
svg.wfmap{display:block}
.wfmap .nrect{fill:#1b222c;stroke:#3a4553;stroke-width:1.5}
.wfmap .node.valid .nrect{stroke:#3ec27a}
.wfmap .node.incomplete .nrect{stroke:#8b98a8;stroke-dasharray:5 4}
.wfmap .node.error .nrect{stroke:#e06666;stroke-width:2.5}
.wfmap .node.sel .nrect{stroke:#4c8dff;stroke-width:3}
.wfmap .node.added .nrect{stroke:#e0b24d}
.wfmap .node:focus{outline:none}
.wfmap .node:focus .nrect{stroke:#4c8dff;stroke-width:3}
.wfmap .nt-title{fill:#e6edf3;font:600 12px system-ui}
.wfmap .nt-sub{fill:#8b98a8;font:11px system-ui}
.wfmap .badge-r{fill:#0f1216;stroke:#3a4553}
.wfmap .badge-t{fill:#b7c2d0;font:10px ui-monospace,monospace}
.wfmap .term{fill:#161b22}
.wfmap .term-complete{stroke:#3ec27a} .wfmap .term-failed{stroke:#e06666} .wfmap .term-blocked{stroke:#e0b24d}
.wfmap .tt{font:700 12px system-ui}
.wfmap .verifier .vhex{fill:#161b22;stroke:#3ec27a;stroke-dasharray:4 3}
.wfmap .placeholder .nrect{fill:#141a22;stroke:#8b98a8;stroke-dasharray:2 3}
.wfmap .ph-t{fill:#e0b24d;font:11px system-ui}
.wfmap path.edge{fill:none;stroke:#7f8a99;stroke-width:1.6}
.wfmap path.edge.cond{stroke-dasharray:6 4}
.wfmap path.edge.e-complete{stroke:#3ec27a} .wfmap path.edge.e-failed{stroke:#e06666} .wfmap path.edge.e-blocked{stroke:#e0b24d} .wfmap path.edge.e-verify{stroke:#3ec27a;stroke-dasharray:4 3}
.wfmap .edge-lbl{fill:#b7c2d0;font:10px ui-monospace,monospace}
.wfmap-summary{font-size:12px;color:var(--muted)}
.wfmap-legend{display:flex;gap:.5rem;flex-wrap:wrap;font-size:11px;color:var(--muted)}
.wfmap-legend span{display:inline-flex;align-items:center;gap:.25rem}
`

// Injected inside the page's single nonce'd script; defines the global buildWorkflowMap.
export const WORKFLOW_MAP_SCRIPT = String.raw`
var SVGNS='http://www.w3.org/2000/svg';
function sv(t,props){var n=document.createElementNS(SVGNS,t);if(props)for(var k in props){if(k==='text')n.textContent=props[k];else if(k.slice(0,2)==='on')n.addEventListener(k.slice(2),props[k]);else n.setAttribute(k,String(props[k]));}for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c!=null)n.append(c);}return n;}
function mtrunc(s,n){s=String(s==null?'':s);return s.length>n?s.slice(0,n-1)+'…':s;}
function termClass(t){return t==='$complete'?'complete':t==='$failed'?'failed':'blocked';}

// Build the live map from the AUTHORITATIVE draft model. Returns {root, order, summary}.
// model: { preview, validation_status, warnings[], kind, missing[], selectedId, prevIds[], onSelect(id,info) }
function buildWorkflowMap(model){
  var pv=(model.preview)||{}; var steps=(pv.steps||[]).slice(); var edges=(pv.edges||[]).slice();
  var ps=pv.policy_summary||{}; var warnings=model.warnings||[]; var missing=model.missing||[];
  var kind=model.kind; var prevIds=model.prevIds||null;
  var wrap=document.createElement('div'); wrap.className='wfmap-wrap';

  // ── no draft OR no structure → explicit non-graph state (never a fake graph) ──
  if(!steps.length){
    var empty=document.createElement('div'); empty.className='card';
    var head=document.createElement('div'); head.className='ph-t';
    head.textContent = kind==='clarification_required' ? 'Draft in progress — waiting for details' : 'No workflow structure yet';
    empty.append(head);
    var reqs=missing.length?missing:(kind==='clarification_required'?['implementation details not yet provided']:[]);
    if(reqs.length){var ul=document.createElement('ul');ul.className='chips';reqs.forEach(function(m){var li=document.createElement('span');li.className='chip';li.textContent=String(m);ul.append(li);});empty.append(ul);}
    wrap.append(empty);
    return { root: wrap, order: [], summary: 'No steps yet. '+(reqs.length?('Unresolved: '+reqs.join('; ')):'Send a message to compile a workflow.') };
  }

  // ── issue index: attach validation warnings to the step/role they reference ──
  function issuesFor(id, role){
    return warnings.filter(function(w){ w=String(w); return w.indexOf('/steps/'+id)>=0 || w.indexOf(' '+id)>=0 || w.indexOf(id+' ')>=0 || (role&&(w.indexOf('/agents/'+role)>=0||w.indexOf('role '+role)>=0)); });
  }
  var unavailableRe=/unavail|not advertis|unknown_agent|no such node|node.*offline|not_advertised|placement/i;

  // ── deterministic level layout (start → steps → verifier → terminals) ──
  var byId={}; steps.forEach(function(s){byId[s.id]=s;});
  var level={}; steps.forEach(function(s){level[s.id]=0;});
  var stepEdges=edges.filter(function(e){return !e.loop&&!e.terminal&&byId[e.from]&&byId[e.to];});
  for(var it=0;it<=steps.length;it++)stepEdges.forEach(function(e){if(level[e.to]<level[e.from]+1)level[e.to]=level[e.from]+1;});
  var maxStep=0; steps.forEach(function(s){if(level[s.id]>maxStep)maxStep=level[s.id];});
  var verifierReq=!!ps.requires_verified_tests;
  var vLevel=maxStep+1; var termLevel=maxStep+(verifierReq?2:1);
  var rows={};
  var startId='__start'; (rows[-1]=rows[-1]||[]).push({kind:'start',id:startId});
  steps.slice().sort(function(a,b){return level[a.id]-level[b.id]||String(a.id).localeCompare(b.id);}).forEach(function(s){(rows[level[s.id]]=rows[level[s.id]]||[]).push({kind:'step',id:s.id,ref:s});});
  if(verifierReq)(rows[vLevel]=rows[vLevel]||[]).push({kind:'verifier',id:'__verifier'});
  var terms={}; edges.filter(function(e){return e.terminal;}).forEach(function(e){terms[e.to]=true;});
  Object.keys(terms).sort().forEach(function(t){(rows[termLevel]=rows[termLevel]||[]).push({kind:'term',id:t});});

  var NW=190,NH=70,HG=34,VG=58;var pos={};
  var levs=Object.keys(rows).map(Number).sort(function(a,b){return a-b;});
  var maxCols=1;levs.forEach(function(l){if(rows[l].length>maxCols)maxCols=rows[l].length;});
  var W=maxCols*(NW+HG)+HG,H=levs.length*(NH+VG)+VG;
  levs.forEach(function(l,ri){var r=rows[l];var rowW=r.length*(NW+HG)-HG;var startX=Math.max(HG,(W-rowW)/2);r.forEach(function(nd,i){pos[nd.id]={x:startX+i*(NW+HG),y:VG/2+ri*(NH+VG),nd:nd};});});

  var s=sv('svg',{viewBox:'0 0 '+W+' '+H,class:'wfmap',width:W,height:H,role:'group','aria-label':'Workflow map'});
  var defs=sv('defs');
  [['am-normal','#7f8a99'],['am-complete','#3ec27a'],['am-failed','#e06666'],['am-blocked','#e0b24d'],['am-verify','#3ec27a']].forEach(function(p){var m=sv('marker',{id:p[0],markerWidth:8,markerHeight:8,refX:7,refY:3,orient:'auto'});m.append(sv('path',{d:'M0,0 L7,3 L0,6 z',fill:p[1]}));defs.append(m);});
  s.append(defs);

  // edges (start→entry, step→step conditional/normal, →verifier, →terminal)
  function drawEdge(fromId,toId,cls,marker,label){var a=pos[fromId],b=pos[toId];if(!a||!b)return;var ax=a.x+NW/2,ay=a.y+NH,bx=b.x+NW/2,by=b.y;var mid=(ay+by)/2;var d='M'+ax+','+ay+' C'+ax+','+mid+' '+bx+','+mid+' '+bx+','+by;s.append(sv('path',{class:'edge '+cls,d:d,'marker-end':'url(#'+marker+')'}));if(label)s.append(sv('text',{class:'edge-lbl',x:(ax+bx)/2,y:mid,'text-anchor':'middle',text:mtrunc(label,18)}));}
  drawEdge(startId, pv.entry_step||(steps[0]&&steps[0].id), 'e-start','am-normal');
  var completing=[]; // steps that route to $complete
  edges.forEach(function(e){
    if(e.loop){ drawEdge(e.from,e.to,'cond','am-normal',e.cond?('⟲ '+e.cond):'⟲ loop'); return; }
    if(e.terminal){ if(e.to==='$complete'&&verifierReq){ completing.push(e.from); return; } drawEdge(e.from,e.to,'e-'+termClass(e.to)+(e.cond?' cond':''),'am-'+termClass(e.to),e.cond||''); return; }
    // conditional when the edge carries a condition or the source branches to multiple targets
    var branchy=edges.filter(function(x){return x.from===e.from&&!x.loop;}).length>1;
    drawEdge(e.from,e.to,(e.cond||branchy)?'cond':'','am-normal', e.cond||'');
  });
  if(verifierReq){ completing.forEach(function(f){drawEdge(f,'__verifier','e-verify','am-verify','verified');}); drawEdge('__verifier','$complete','e-complete','am-complete'); }

  var order=[]; var nodeEls={};
  function nodeDomId(id){return 'wfn-'+String(id).replace(/[^A-Za-z0-9_-]/g,'_');}
  function makeNode(nd){
    var p=pos[nd.id]; var g=sv('g',{class:'node',id:nodeDomId(nd.id),transform:'translate('+p.x+','+p.y+')',tabindex:'0',role:'button'});
    var baseCls='node', aria='';
    if(nd.kind==='start'){ g.append(sv('rect',{class:'nrect',x:NW*0.3,y:NH*0.28,rx:18,width:NW*0.4,height:NH*0.44})); g.append(sv('text',{class:'tt',x:NW/2,y:NH*0.57,'text-anchor':'middle',text:'▶ start'})); aria='Start'; }
    else if(nd.kind==='term'){ var tc=termClass(nd.id); g.append(sv('rect',{class:'term term-'+tc,x:NW*0.18,y:NH*0.24,rx:14,width:NW*0.64,height:NH*0.5})); g.append(sv('text',{class:'tt',x:NW/2,y:NH*0.55,'text-anchor':'middle',text:(nd.id==='$complete'?'⏹ complete':nd.id==='$failed'?'✕ failed':'⏸ '+nd.id.slice(1))})); aria=(nd.id==='$complete'?'Completion gate':nd.id+' terminal'); }
    else if(nd.kind==='verifier'){ baseCls='node verifier'; g.append(sv('rect',{class:'vhex',x:NW*0.22,y:NH*0.22,rx:6,width:NW*0.56,height:NH*0.52})); g.append(sv('text',{class:'tt',x:NW/2,y:NH*0.44,'text-anchor':'middle',text:'✓ verifier'})); g.append(sv('text',{class:'nt-sub',x:NW/2,y:NH*0.66,'text-anchor':'middle',text:'tests_passed gate'})); aria='Verifier stage (system-verified tests)'; }
    else { var st=nd.ref; var issues=issuesFor(st.id, st.role);
      var incomplete = !st.agent || (st.workspace && !st.node_id);
      var unavailable = issues.some(function(w){return unavailableRe.test(String(w));});
      var errored = (model.validation_status==='invalid' && issues.length>0) || unavailable;
      baseCls='node '+(errored?'error':incomplete?'incomplete':'valid');
      var rect=sv('rect',{class:'nrect',x:0,y:0,rx:9,width:NW,height:NH}); g.append(rect);
      var icon = errored?'! ':incomplete?'… ':'✓ ';
      g.append(sv('text',{class:'nt-title',x:12,y:20,text:icon+mtrunc(st.id,20)}));
      g.append(sv('text',{class:'nt-sub',x:12,y:37,text:mtrunc((st.agent||'agent not selected')+(st.node_id?(' @ '+st.node_id):(st.workspace?' @ node unresolved':'')),30)}));
      var badges=[]; if(st.role)badges.push('role:'+st.role); if(st.workspace_write)badges.push('✎ write'); else if(st.workspace)badges.push('ws'); if(st.verify)badges.push('✓'+st.verify); if(st.permission_mode&&st.permission_mode!=='default')badges.push(st.permission_mode);
      g.append(sv('text',{class:'nt-sub',x:12,y:53,text:mtrunc(badges.join(' · ')||'—',32)}));
      if(unavailable)g.append(sv('text',{class:'ph-t',x:12,y:66,text:'unavailable in inventory'}));
      else if(incomplete&&!errored)g.append(sv('text',{class:'ph-t',x:12,y:66,text:st.agent?'target node unresolved':'implementation agent not selected'}));
      aria='Step '+st.id+': '+(st.agent||'no agent')+(st.node_id?(' on '+st.node_id):'')+(st.workspace_write?', writes workspace':st.workspace?', workspace':'')+(st.verify?(', verifier '+st.verify):'')+', '+(errored?'validation error':incomplete?'incomplete':'valid')+(issues.length?('; '+issues.length+' issue(s)'):'');
      nd._issue = issues.length?issues.join(' | '):null; nd._incomplete=incomplete; nd._errored=errored;
    }
    g.setAttribute('class', baseCls);
    if(prevIds && prevIds.indexOf(nd.id)<0 && nd.kind==='step') g.setAttribute('class', g.getAttribute('class')+' added');
    if(model.selectedId===nd.id) g.setAttribute('class',g.getAttribute('class')+' sel');
    g.setAttribute('aria-label',aria); g.append(sv('title',{text:aria}));
    var info={node:nd, issue:(nd._issue||null)};
    g.addEventListener('click',function(){ if(model.onSelect)model.onSelect(nd.id,info); });
    g.addEventListener('keydown',function(ev){ var k=ev.key;
      if(k==='Enter'||k===' '){ if(ev.preventDefault)ev.preventDefault(); if(model.onSelect)model.onSelect(nd.id,info); return; }
      var idx=order.indexOf(nd.id);
      if((k==='ArrowRight'||k==='ArrowDown')&&idx<order.length-1){ if(ev.preventDefault)ev.preventDefault(); focusNode(order[idx+1]); }
      else if((k==='ArrowLeft'||k==='ArrowUp')&&idx>0){ if(ev.preventDefault)ev.preventDefault(); focusNode(order[idx-1]); }
    });
    nodeEls[nd.id]=g; order.push(nd.id); return g;
  }
  function focusNode(id){ var g=nodeEls[id]; if(g){ s.setAttribute('aria-activedescendant',nodeDomId(id)); try{g.focus();}catch(e){} focusedId=id; } }
  var focusedId=null;
  // draw nodes in nav order (start, steps by level, verifier, terminals)
  levs.forEach(function(l){ rows[l].forEach(function(nd){ s.append(makeNode(nd)); }); });
  s.setAttribute('aria-activedescendant', order.length?nodeDomId(order[0]):'');

  var scroll=document.createElement('div'); scroll.className='wfmap-scroll'; scroll.append(s);
  var toolbar=document.createElement('div'); toolbar.className='wfmap-toolbar';
  var reset=document.createElement('button'); reset.className='ghost'; reset.textContent='Reset view'; reset.id='map-reset';
  reset.addEventListener('click',function(){ scroll.scrollLeft=0; scroll.scrollTop=0; if(order.length)focusNode(order[0]); });
  toolbar.append(reset, spacer());
  var legend=document.createElement('div'); legend.className='wfmap-legend';
  ['✓ valid','… incomplete','! error','✓ verifier','⏹ completion','⟲ loop'].forEach(function(t){var sp=document.createElement('span');sp.textContent=t;legend.append(sp);});
  toolbar.append(legend);
  wrap.append(toolbar, scroll);

  // accessible text summary of the graph
  var summ = describeGraph(pv, ps, steps, edges, warnings, missing, model.validation_status, kind);
  var aside=document.createElement('p'); aside.className='wfmap-summary'; aside.textContent=summ; wrap.append(aside);

  return { root: wrap, order: order, summary: summ, focus: focusNode };
}
function spacer(){var d=document.createElement('span');d.className='sp';return d;}
function describeGraph(pv,ps,steps,edges,warnings,missing,vs,kind){
  var parts=[];
  parts.push((pv.name?('"'+pv.name+'"'):'Workflow')+' starts at '+(pv.entry_step||(steps[0]&&steps[0].id)||'—')+'.');
  parts.push(steps.length+' step'+(steps.length===1?'':'s')+': '+steps.map(function(s){return s.id+' ('+(s.agent||'no agent')+(s.node_id?('@'+s.node_id):'')+(s.workspace_write?', writes workspace':'')+(s.verify?(', verifier '+s.verify):'')+')';}).join('; ')+'.');
  var conds=edges.filter(function(e){return !e.terminal&&!e.loop;}); if(conds.length)parts.push(conds.length+' transition'+(conds.length===1?'':'s')+'.');
  if(ps.requires_verified_tests)parts.push('A verifier gate (system-verified tests) precedes completion.');
  var terms=[].concat.apply([],[]); var t=(pv.terminal_routes||[]); if(t.length)parts.push('Terminal routes: '+t.join(', ')+'.');
  if(vs==='invalid'&&warnings.length)parts.push(warnings.length+' validation issue'+(warnings.length===1?'':'s')+'.');
  if(kind==='clarification_required'&&missing.length)parts.push('Unresolved: '+missing.join('; ')+'.');
  if(vs==='valid')parts.push('Draft is valid and ready for review.');
  return parts.join(' ');
}
`
