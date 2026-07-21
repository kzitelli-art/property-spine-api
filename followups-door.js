/* ════════════════════════════════════════════════════════════════════════════
   PROPERTY SPINE — LIVE FOLLOW-UPS DOOR  (Release 3, app side)
   ────────────────────────────────────────────────────────────────────────────
   The operator surface for the 069 task queue: tour-follow-up ANCHORS and
   leasing-task SIBLINGS, read from the systems of record and acted on through
   the frozen conversion-obligation-closure capability.

   DOCTRINE THIS FILE OBEYS (do not soften):
   • This is a PROJECTION. It renders domain objects; it authors none. Every
     mutation is a POST to the live rail; the browser is never the truth.
   • The door exposes exactly five row actions:
        Complete · Reassign · Reopen · Change-due · Message (opens the conversation)
     Raw "Released" and "Missed" are NOT task buttons — closing a relationship
     is a separate deliberate lifecycle action, never a one-tap vanish.
   • Reopen renders ONLY when the server says reopenable:true. A dead button is
     a lie; the not-reopenable reason shows as a quiet disabled line instead.
   • Owner, owner_basis, anchor/sibling, and due_state come from the server as
     read — never recomputed here. Honest blank over confident wrong.
   • Shares the app session via window.__psLive. NO bootstrap, NO token, NO
     revoke — by construction. If there's no live session, the tile is inert
     and the offline drawer still answers.

   Mirrors the __psLeasing sealed-module pattern: one IIFE, one frozen surface
   window.__psFollowups = { mount, entryHTML, tileStatus, open }.
   ════════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  /* ── scoped styles, injected once. Property Spine system: Fraunces headers,
        Plex Sans body, Plex Mono labels, white ground, near-black ink, hairline
        rows (never nested cards), four restrained status colors. ── */
  function injectStyles(){
    if(typeof document==='undefined' || document.getElementById('r3fu-style')) return;
    var s=document.createElement('style'); s.id='r3fu-style';
    s.textContent = [
      ':root{--r3fu-ink:#171713;--r3fu-muted:#77746d;--r3fu-faint:#9b978f;--r3fu-line:#deddd8;--r3fu-soft:#eceae5;--r3fu-red:#a43b2e;--r3fu-green:#23664e}',
      '.r3fu-shell{max-width:1040px;color:var(--r3fu-ink);font-family:"IBM Plex Sans",system-ui,sans-serif}',
      '.r3fu-head{display:flex;align-items:baseline;justify-content:space-between;gap:22px;padding:2px 0 22px;border-bottom:1px solid var(--r3fu-line);margin-bottom:0}',
      '.r3fu-principle{font-family:"Fraunces",Georgia,serif;font-size:22px;font-weight:450;letter-spacing:-.025em;line-height:1.15}',
      '.r3fu-principle small{display:block;margin-top:7px;font-family:"IBM Plex Sans",system-ui,sans-serif;font-size:13px;font-weight:400;letter-spacing:0;color:var(--r3fu-muted);line-height:1.45}',
      '.r3fu-countline{font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--r3fu-muted);white-space:nowrap}',
      '.r3fu-countline .attention{color:var(--r3fu-red)}',
      '.r3fu-stage{margin:0;border:0;border-bottom:1px solid var(--r3fu-line);background:transparent}',
      '.r3fu-stage-h{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:start;padding:25px 0 12px}',
      '.r3fu-stage[data-rank="close"] .r3fu-stage-h{padding-top:31px}',
      '.r3fu-stage-title{font-family:"Fraunces",Georgia,serif;font-size:24px;font-weight:450;letter-spacing:-.028em;line-height:1.1}',
      '.r3fu-stage[data-rank="close"] .r3fu-stage-title{font-size:29px}',
      '.r3fu-stage-count{font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.08em;color:var(--r3fu-muted);padding-top:4px}',
      '.r3fu-stage-desc{font-size:12px;color:var(--r3fu-muted);margin-top:6px;line-height:1.4}',
      '.r3fu-stage-body{padding:0}',
      '.r3fu-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:center;padding:18px 0;border-top:1px solid var(--r3fu-soft)}',
      '.r3fu-row-main{min-width:0}',
      '.r3fu-row-top{display:flex;align-items:baseline;gap:10px;min-width:0}',
      '.r3fu-person{font-size:15.5px;font-weight:600;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.r3fu-state{font-size:11px;color:var(--r3fu-muted);white-space:nowrap}',
      '.r3fu-label{font-size:13.5px;color:#302f2b;margin-top:5px;line-height:1.4}',
      '.r3fu-next{font-size:12px;color:var(--r3fu-muted);margin-top:3px;line-height:1.4}',
      '.r3fu-meta{display:flex;gap:9px 14px;margin-top:8px;font-size:11.5px;color:var(--r3fu-faint);flex-wrap:wrap}',
      '.r3fu-owner small{color:var(--r3fu-faint)} .r3fu-owner em{color:#8b641e;font-style:normal}',
      '.r3fu-due.overdue{color:var(--r3fu-red)}',
      '.r3fu-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;position:relative}',
      '.r3fu-btn{appearance:none;border:1px solid #cfcdc6;background:#fff;border-radius:999px;padding:9px 14px;font-size:11px;cursor:pointer;color:#282722;font-family:inherit;white-space:nowrap;transition:background .12s,border-color .12s,color .12s}',
      '.r3fu-btn:hover{border-color:#99958d;background:#faf9f6}',
      '.r3fu-btn.primary{background:var(--r3fu-ink);color:#fff;border-color:var(--r3fu-ink);font-weight:600}',
      '.r3fu-btn.primary:hover{background:#30302a}',
      '.r3fu-btn.ghost{border-color:transparent;background:transparent;color:#5f5c56}',
      '.r3fu-btn.small{padding:6px 10px;font-size:10px}',
      '.r3fu-secondary{position:relative}',
      '.r3fu-secondary>summary{list-style:none;cursor:pointer;color:#68655e;font-size:11px;padding:9px 2px;user-select:none}',
      '.r3fu-secondary>summary::-webkit-details-marker{display:none}',
      '.r3fu-secondary>summary:after{content:" ···";letter-spacing:.08em}',
      '.r3fu-secondary[open]>summary{color:#111}',
      '.r3fu-secondary-menu{position:absolute;right:0;top:38px;z-index:20;width:150px;background:#fff;border:1px solid #d8d6cf;border-radius:13px;padding:6px;box-shadow:0 18px 44px rgba(20,18,14,.14)}',
      '.r3fu-secondary-menu .r3fu-btn{display:block;width:100%;border:0;border-radius:8px;background:transparent;text-align:left;padding:9px 10px}',
      '.r3fu-secondary-menu .r3fu-btn:hover{background:#f5f3ee}',
      '.r3fu-empty{color:var(--r3fu-faint);font-size:12px;padding:4px 0 19px;text-align:left}',
      '.r3fu-loading{color:var(--r3fu-muted);font-size:13px;padding:26px 0;border-bottom:1px solid var(--r3fu-line)}',
      '.r3fu-more{appearance:none;width:100%;border:0;border-bottom:1px solid var(--r3fu-line);background:transparent;padding:15px 0;font-size:11px;cursor:pointer;color:var(--r3fu-muted);font-family:inherit;text-align:left}',
      '.r3fu-flash{border-left:2px solid var(--r3fu-green);background:#f3f8f5;color:var(--r3fu-green);padding:11px 13px;font-size:12px;margin:14px 0}',
      '.r3fu-flash.err{border-left-color:var(--r3fu-red);background:#fbefed;color:var(--r3fu-red)}',
      '.r3fu-err{border-left:2px solid var(--r3fu-red);background:#fbefed;color:#8d3026;padding:11px 13px;font-size:12px;margin:12px 0;line-height:1.45}',
      '.r3fu-err.small{padding:8px 10px}',
      '.r3fu-closed{border-bottom:1px solid var(--r3fu-line);padding:0}',
      '.r3fu-closed>summary{list-style:none;cursor:pointer;padding:17px 0;font-size:12px;color:#5f5c56}',
      '.r3fu-closed>summary::-webkit-details-marker{display:none}',
      '.r3fu-closed>summary:after{content:"+";float:right;color:#8b887f}',
      '.r3fu-closed[open]>summary:after{content:"–"}',
      '.r3fu-closed>summary span{color:var(--r3fu-faint);margin-left:5px}',
      '.r3fu-closed-body{padding:0 0 9px}',
      '.r3fu-crow{display:flex;justify-content:space-between;gap:18px;align-items:center;padding:12px 0;border-top:1px solid var(--r3fu-soft)}',
      '.r3fu-crow-top{font-size:13px;font-weight:600}.r3fu-crow-top small{font-weight:400;color:var(--r3fu-muted)}',
      '.r3fu-crow-meta{font-size:11px;color:var(--r3fu-faint);margin-top:3px}',
      '.r3fu-crow-act{display:flex;align-items:center;gap:8px;flex-shrink:0}',
      '.r3fu-noreopen{font-size:11px;color:var(--r3fu-faint);font-style:italic}',
      '.r3fu-unitwrap{display:flex;flex-direction:column;gap:8px;margin:8px 0}',
      '.r3fu-unitbtn{display:flex;justify-content:space-between;align-items:center;gap:12px;text-align:left;border:1px solid #deddd8;background:#fff;border-radius:10px;padding:11px 13px;cursor:pointer;font-family:inherit}',
      '.r3fu-unitbtn:hover{border-color:#8f8b83}',
      '.r3fu-unitbtn b{font-size:14px;font-weight:600}.r3fu-unitbtn span{font-size:11px;color:var(--r3fu-muted);text-transform:capitalize}',
      '.r3fu-scrim{position:fixed;inset:0;background:rgba(15,15,15,.34);display:flex;align-items:center;justify-content:center;z-index:9000;padding:20px}',
      '.r3fu-sheet{background:#fff;border-radius:20px;max-width:440px;width:100%;padding:24px;box-shadow:0 30px 80px rgba(0,0,0,.22)}',
      '.r3fu-sheet-h{font-family:"Fraunces",Georgia,serif;font-size:23px;font-weight:450;letter-spacing:-.025em;margin-bottom:11px}',
      '.r3fu-p{font-size:13px;color:#5f5c56;line-height:1.5;margin:0 0 14px}',
      '.r3fu-l{display:block;font-family:"IBM Plex Mono",monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--r3fu-muted);margin:12px 0 5px}',
      '.r3fu-inp{width:100%;border:1px solid #d4d2cb;border-radius:10px;padding:10px 11px;font-size:13px;font-family:inherit;box-sizing:border-box}',
      'textarea.r3fu-inp{min-height:64px;resize:vertical}',
      '.r3fu-sheet-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:19px}',
      '@media(max-width:700px){.r3fu-head{display:block}.r3fu-countline{margin-top:12px;white-space:normal}.r3fu-row{grid-template-columns:1fr;gap:13px}.r3fu-actions{justify-content:space-between}.r3fu-stage[data-rank="close"] .r3fu-stage-title{font-size:26px}.r3fu-secondary-menu{left:0;right:auto}.r3fu-crow{align-items:flex-start;flex-direction:column}}'
    ].join('\n');

    document.head.appendChild(s);
  }
  if(typeof document!=='undefined'){ if(document.head) injectStyles(); else document.addEventListener('DOMContentLoaded', injectStyles); }

  // GET reads only — mutations go through the sealed named write methods.
  var RES = {
    queue:          'taskQueue',
    recentlyClosed: 'taskRecentlyClosed',
    eligibleStaff:  'eligibleStaff'
  };

  // ── small DOM + format helpers (self-contained; no reliance on app globals) ──
  function esc(s){ return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
  function el(html){ var d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstChild; }
  function live(){ return (typeof window!=='undefined' && window.__psLive) ? window.__psLive : null; }
  function hasSession(){ var L=live(); return !!(L && L.hasSession && L.hasSession()); }

  // Owner-basis → plain words. The server already resolved this through the ONE
  // canonical identity resolver; we only phrase it.
  var BASIS_WORDS = {
    eligible_assignment: 'eligible',
    eligibility_lapsed:  'eligibility lapsed',
    unassigned:          'unassigned'
  };
  // Reopen refusal codes → one honest line each (from assessReopenability).
  var REOPEN_REASON_WORDS = {
    NOT_TERMINAL:            'still open',
    REOPEN_WINDOW_EXPIRED:   'past the 72-hour recovery window',
    DOWNSTREAM_WORK_EXISTS:  'later work already happened',
    RELATIONSHIP_CLOSED:     'the conversation is closed',
    ALREADY_RECOVERED:       'already reopened once',
    DECISION_NOT_RECOVERABLE:'a decision, not reopenable',
    UNKNOWN:                 'not reopenable'
  };
  // resolution_basis choices for completing work you don't own (execute-vs-decide;
  // honest blank stays an option — the operator is never forced to invent one).
  var RESOLUTION_BASES = [
    ['',                     '— (I own this task)'],
    ['coverage',             'Covering for the owner'],
    ['manager_intervention', 'Manager stepped in'],
    ['completed_together',   'Done together'],
    ['no_longer_needed',     'No longer needed'],
    ['unassigned_pickup',    'Picked up (unassigned)']
  ];

  function fmtDue(due_at, due_state){
    if(!due_at) return 'no due time';
    var t = Date.parse(due_at); if(isNaN(t)) return esc(due_state||'');
    var d = new Date(t);
    var day = d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
    var tm  = d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
    return day + ' · ' + tm;
  }
  function relClosed(closed_at){
    if(!closed_at) return '';
    var t=Date.parse(closed_at); if(isNaN(t)) return '';
    var mins=Math.round((Date.now()-t)/60000);
    if(mins<60) return mins+'m ago';
    var hrs=Math.round(mins/60); if(hrs<48) return hrs+'h ago';
    return Math.round(hrs/24)+'d ago';
  }
  // datetime-local <-> ISO
  function toLocalInputValue(iso){
    var t = iso?Date.parse(iso):Date.now(); var d=new Date(isNaN(t)?Date.now():t);
    d.setMinutes(d.getMinutes()-d.getTimezoneOffset());
    return d.toISOString().slice(0,16);
  }
  function localInputToISO(v){ if(!v) return null; var t=Date.parse(v); return isNaN(t)?null:new Date(t).toISOString(); }
  function uid(){ return 'r3_'+Date.now()+'_'+Math.random().toString(36).slice(2,8); }

  /* ─────────────────────────── the controller ─────────────────────────── */
  function makeController(){
    var rootEl = null;
    var state = {
      loading:false, err:null,
      counts:null, items:[], next_cursor:null, receipt:'',
      closed:null, closedReceipt:'', closedErr:null,
      staff:null,          // eligible-staff cache for the reassign picker
      panel:null           // {kind, row} for an open action panel, or null
    };

    function rebindRoot(node){ rootEl = node; }

    async function loadResource(name, params){
      var L=live(); if(!L) throw new Error('live loader unavailable');
      var out = await L.loadResource(name, params||{});
      return (out && out.data) ? out.data : out;  // unwrap { data, meta }
    }

    async function refresh(){
      if(!hasSession()){ render(); return; }
      state.loading=true; state.err=null; render();
      try{
        var r = await loadResource(RES.queue, {});
        state.counts = r.counts || null;
        state.items  = Array.isArray(r.items) ? r.items : [];
        state.next_cursor = r.next_cursor || null;
        state.receipt = r.receipt || '';
      }catch(e){ state.err = (e && e.message) || 'Could not load the queue.'; }
      state.loading=false; render();
      // recently-closed loads alongside but never blocks the queue paint
      loadClosed();
    }

    async function loadMore(){
      if(!state.next_cursor || !hasSession()) return;
      try{
        // the queue resource path builder takes a raw cursor param
        var r = await loadResource(RES.queue, { cursor: state.next_cursor });
        state.items = state.items.concat(Array.isArray(r.items)?r.items:[]);
        state.next_cursor = r.next_cursor || null;
        state.counts = r.counts || state.counts;
      }catch(e){ state.err=(e&&e.message)||'Could not load more.'; }
      render();
    }

    async function loadClosed(){
      if(!hasSession()) return;
      try{
        var r = await loadResource(RES.recentlyClosed, {});
        state.closed = Array.isArray(r.items)?r.items:[];
        state.closedReceipt = r.receipt || '';
        state.closedErr=null;
      }catch(e){ state.closedErr=(e&&e.message)||'Could not load recently closed.'; }
      render();
    }

    async function ensureStaff(){
      if(state.staff) return state.staff;
      try{
        var r = await loadResource(RES.eligibleStaff, {});
        // tolerate {staff:[...]} or a bare array
        state.staff = Array.isArray(r) ? r : (r && r.staff) ? r.staff : (r && r.items) ? r.items : [];
      }catch(e){ state.staff = []; }
      return state.staff;
    }

    // ── action panel open/close ──
    function openPanel(kind, obligationId){
      var row = state.items.filter(function(x){return x.obligation_id===obligationId;})[0]
             || (state.closed||[]).filter(function(x){return x.obligation_id===obligationId;})[0];
      if(!row) return;
      state.panel = { kind:kind, row:row, busy:false, err:null };
      if(kind==='reassign'){ ensureStaff().then(render); }
      render();
    }
    function closePanel(){ state.panel=null; render(); }

    // ── the four mutations — through the sealed NAMED write methods on __psLive
    //    (the loader is GET-only; these are the obligation-keyed allow-list verbs).
    //    Each returns { data, meta }; we surface data as the receipt source. ──
    async function doResolve(obligationId, fields){ return write('resolveTask', obligationId, fields); }
    async function doReassign(obligationId, fields){ return write('reassignTask', obligationId, fields); }
    async function doReopen(obligationId, fields){ return write('reopenTask', obligationId, fields); }
    async function doChangeDue(obligationId, fields){ return write('changeDueTask', obligationId, fields); }

    // ── SEND APPLICATION — the real invitation loop from a Post-Tour row. ──
    // prepare (a real 'prepared' invitation + link) → operator delivers it →
    // "I've sent it" attests → the rail advances the opportunity to Applicants
    // → refresh() and the row visibly MOVES buckets. Copying writes nothing.
    // Unit required: the row's tour unit when known, else the leaseable list.
    // ONE-TAP SEND. Unit attached -> dispatch immediately. No unit -> show the
    // leaseable picker, then dispatch on pick. Server revalidates, texts the
    // link, records the SID, and advances to Applicants -- the row then moves.
    async function openSendPanel(obligationId){
      var row = state.items.filter(function(x){return x.obligation_id===obligationId;})[0];
      if(!row) return;
      if(row.unit_id){ sendNow(row, row.unit_id); return; }
      state.panel = { kind:'sendapp', row:row, busy:true, err:null, step:'unit', units:null };
      render();
      try{
        var L=live(); if(!L || typeof L.leaseableUnits!=='function') throw new Error('live read unavailable');
        var r = await L.leaseableUnits();
        state.panel.units = (r && r.data && r.data.units) || [];
        state.panel.busy=false;
      }catch(e){ state.panel.busy=false; state.panel.err=(e&&(e.publicMessage||e.message))||'Could not load units.'; }
      render();
    }
    async function sendNow(row, unit_id){
      console.log('[door] sendNow', row && row.person_id, unit_id, 'sending=', state.sending);
      if(state.sending){ console.log('[door] sendNow blocked: already sending'); return; }   // re-entrancy guard
      if(state.panel && state.panel.kind==='sendapp'){ state.panel.step='sending'; state.panel.busy=true; state.panel.err=null; }
      state.sending = row.obligation_id;
      render();
      try{
        var L=live(); if(!L || typeof L.sendApplicationSms!=='function') throw new Error('live write unavailable');
        console.log('[door] calling sendApplicationSms...');
        var out = await L.sendApplicationSms({ person_id: row.person_id, unit_id: unit_id, conversion_id: row.conversion_id });
        console.log('[door] sendApplicationSms result', out);
        var d = (out && out.data) || {};
        if(!d.sent) throw new Error((d && d.receipt) || 'The application could not be sent.');
        state.panel=null; state.sending=null;
        state.flash='Application sent to '+esc(row.person_name||'the prospect')+'. Moved to Applicants.';
        await refresh();
        setTimeout(function(){ state.flash=null; render(); }, 6000);
      }catch(e){
        state.sending=null;
        var msg=(e&&(e.publicMessage||e.message))||'The application could not be sent.';
        if(/unit_not_offerable|not_leaseable|not_ready_by_move_in|not_at_property|no longer be offered/i.test(msg)){
          state.panel = { kind:'sendapp', row:row, busy:true, err:'That unit can no longer be offered - choose another.', step:'unit', units:null };
          render();
          try{ var L2=live(); var r2 = await L2.leaseableUnits(); state.panel.units=(r2&&r2.data&&r2.data.units)||[]; state.panel.busy=false; }
          catch(_){ state.panel.busy=false; state.panel.units=[]; }
        } else if(state.panel && state.panel.kind==='sendapp'){
          state.panel.busy=false; state.panel.step='unit'; state.panel.err=msg;
        } else {
          state.err_flash=msg;
          setTimeout(function(){ state.err_flash=null; render(); }, 8000);
        }
        render();
      }
    }

    async function write(method, obligationId, fields){
      var L=live(); if(!L || typeof L[method]!=='function') throw new Error('live write "'+method+'" unavailable');
      var params = Object.assign({ obligationId:obligationId }, fields||{});
      var out = await L[method](params);
      return (out && out.data) ? out.data : out;  // unwrap { data, meta }
    }

    // A submit wrapper: run the POST, show the receipt, refresh the board.
    async function submit(fn, panelRef){
      if(!state.panel) return;
      state.panel.busy=true; state.panel.err=null; render();
      try{
        var out = await fn();
        var receipt = (out && (out.receipt || out.message)) || 'Done.';
        state.panel=null;
        state.flash = receipt;
        await refresh();
        // clear the flash after paint
        setTimeout(function(){ state.flash=null; render(); }, 6000);
      }catch(e){
        state.panel.busy=false;
        state.panel.err = (e && (e.publicMessage||e.message)) || 'That did not go through.';
        render();
      }
    }

    /* ─────────────────────────── rendering ─────────────────────────── */
    function render(){
      if(!rootEl) return;
      if(!hasSession()){
        rootEl.innerHTML = ''+
          '<div class="r3fu-shell">'+
            '<div class="r3fu-empty">Live follow-ups are not connected in this view.</div>'+
          '</div>';
        return;
      }
      // S3/S4 markers (contract 6): machine-checkable state on the surface root.
      var psState = state.err ? 'unavailable'
                  : (state.loading && !state.items.length) ? 'loading'
                  : (state.items.length ? 'data' : 'empty');
      var h = '<div class="r3fu-shell" data-ps-source="live" data-ps-state="'+psState+'">';
      if(state.err){
        // RULING 1: a failed live refresh suppresses ALL operational content --
        // no counts, no queue rows, no Recently-Closed, no mutation controls. A
        // stale task may have been resolved/reassigned/reopened since the last
        // read; in this product that is potentially WRONG OWNERSHIP, not mere
        // visual staleness. Unavailable copy + Retry only.
        h += '<div class="r3fu-err">Follow-Ups are unavailable right now: '+esc(state.err)+
             ' <button class="r3fu-btn small" data-act="retryQueue">Retry</button></div>';
        h += '</div>';
        rootEl.innerHTML = h;
        bind();
        return;
      }
      h += header();
      if(state.flash){ h += '<div class="r3fu-flash">'+esc(state.flash)+'</div>'; }
      if(state.err_flash){ h += '<div class="r3fu-flash err">'+esc(state.err_flash)+'</div>'; }
      if(state.loading && !state.items.length){ h += '<div class="r3fu-loading">Loading follow-ups…</div>'; }
      else { h += queueGroups(); }
      if(state.next_cursor){ h += '<button class="r3fu-more" data-act="more">Load more</button>'; }
      h += closedSection();
      h += '</div>';
      rootEl.innerHTML = h;
      if(state.panel) rootEl.appendChild(panelSheet());
      bind();
    }

    function header(){
      var c = state.counts || {};
      var open = Number(c.open==null ? state.items.length : c.open);
      var overdue = Number(c.overdue||0);
      var today = Number(c.due_today||0);
      var line = open+' open';
      if(today) line += ' · '+today+' due today';
      if(overdue) line += ' · <span class="attention">'+overdue+' overdue</span>';
      return ''+
        '<div class="r3fu-head">'+
          '<div class="r3fu-principle">Closest to a signed lease comes first.'+
            '<small>Closing-stage work leads. Applications and post-tour follow-through sit below it.</small>'+
          '</div>'+
          '<div class="r3fu-countline">'+line+'</div>'+
        '</div>';
    }

    // REVERSE-FUNNEL PRESENTATION — the server-authored rung still places
    // every row. The browser changes only order and language of the projection.
    // This slice does NOT infer that a lease is ready for countersignature.
    var FLOW_BUCKETS = [
      { name:'Closest to close', rungs:['lease_signature_followup'], rank:'close',
        desc:'Lease and deposit follow-through', empty:'No lease-stage follow-up needs attention.' },
      { name:'Applications', rungs:['application_approval','applicant_followup'], rank:'advance',
        desc:'Applications moving toward a lease', empty:'No application-stage work needs attention.' },
      { name:'Post-tour follow-ups', rungs:['tour_followup'], rank:'follow',
        desc:'Human follow-through after the tour', empty:'No post-tour follow-up needs attention.' }
    ];

    function stageSection(bucket, rows){
      var count = rows.length;
      return ''+
        '<section class="r3fu-stage" data-rank="'+esc(bucket.rank||'other')+'">'+
          '<div class="r3fu-stage-h">'+
            '<div>'+
              '<div class="r3fu-stage-title">'+esc(bucket.name)+'</div>'+
              '<div class="r3fu-stage-desc">'+esc(bucket.desc)+'</div>'+
            '</div>'+
            '<div class="r3fu-stage-count">'+count+'</div>'+
          '</div>'+
          '<div class="r3fu-stage-body">'+
            (count ? rows.map(taskRow).join('') :
              '<div class="r3fu-empty" data-ps-state="empty">'+esc(bucket.empty)+'</div>')+
          '</div>'+
        '</section>';
    }

    function queueGroups(){
      var placed = {};
      var out = '';
      FLOW_BUCKETS.forEach(function(bucket){
        var rows = state.items.filter(function(r){
          return bucket.rungs.indexOf(r.rung)>=0;
        });
        rows.forEach(function(r){ placed[r.obligation_id]=true; });
        out += stageSection(bucket, rows);
      });
      var rest = state.items.filter(function(r){ return !placed[r.obligation_id]; });
      if(rest.length){
        out += stageSection({
          name:'Other leasing work',
          rank:'other',
          desc:'Open work not yet placed in the closing path',
          empty:''
        }, rest);
      }
      return out;
    }

    var SUBSTATUS_WORDS = {
      application_sent: 'Application sent',
      submitted: 'Submitted',
      approved: 'Approved — lease next',
      declined: 'Declined / withdrawn'
    };

    function taskRow(r){
      var basis = BASIS_WORDS[r.owner_basis] || r.owner_basis || '';
      var owner = r.owner_name
        ? esc(r.owner_name)+(basis ? ' <small>· '+esc(basis)+'</small>' : '')
        : '<em>Unassigned</em>';
      var stateWords = ((r.rung==='applicant_followup'||r.rung==='application_approval') && r.applicant_substatus)
        ? (SUBSTATUS_WORDS[r.applicant_substatus] || String(r.applicant_substatus).replace(/_/g,' '))
        : '';
      var next = r.next_move_label
        ? '<div class="r3fu-next">'+esc(r.next_move_label)+'</div>'
        : '';
      var dueClass = /overdue/i.test(String(r.due_state||'')) ? ' overdue' : '';
      var sending = (state.sending===r.obligation_id);
      var primary = '';

      if(r.rung==='tour_followup' && r.next_move_code==='send_application'){
        var sendLabel = sending ? 'Sending…'
          : (r.unit_number ? ('Send application · Unit '+esc(r.unit_number)) : 'Send application');
        primary = '<button class="r3fu-btn primary" data-act="sendapp" data-oid="'+
          esc(r.obligation_id)+'"'+(sending?' disabled':'')+'>'+sendLabel+'</button>';
      } else {
        primary = '<button class="r3fu-btn primary" data-act="complete" data-oid="'+
          esc(r.obligation_id)+'">Complete</button>';
      }

      var secondary = '';
      if(r.rung==='tour_followup' && r.next_move_code!=='send_application'){
        secondary += '<button class="r3fu-btn" data-act="sendapp" data-oid="'+
          esc(r.obligation_id)+'">Send application</button>';
      }
      if(r.rung==='tour_followup' && r.next_move_code==='send_application'){
        secondary += '<button class="r3fu-btn" data-act="complete" data-oid="'+
          esc(r.obligation_id)+'">Complete</button>';
      }
      secondary +=
        '<button class="r3fu-btn" data-act="reassign" data-oid="'+esc(r.obligation_id)+'">Reassign</button>'+
        '<button class="r3fu-btn" data-act="changeDue" data-oid="'+esc(r.obligation_id)+'">Change time</button>';
      if(r.person_id){
        secondary += '<button class="r3fu-btn" data-act="card" data-pid="'+esc(r.person_id)+
          '" data-pname="'+esc(r.person_name||'')+'">Message</button>';
      }

      return ''+
        '<div class="r3fu-row" data-oid="'+esc(r.obligation_id)+'">'+
          '<div class="r3fu-row-main">'+
            '<div class="r3fu-row-top">'+
              '<span class="r3fu-person">'+esc(r.person_name||'—')+'</span>'+
              (stateWords ? '<span class="r3fu-state">'+esc(stateWords)+'</span>' : '')+
            '</div>'+
            '<div class="r3fu-label">'+esc(r.label||'Follow up')+'</div>'+
            next+
            '<div class="r3fu-meta">'+
              (r.unit_number ? '<span>Unit '+esc(r.unit_number)+'</span>' : '')+
              '<span class="r3fu-owner">'+owner+'</span>'+
              '<span class="r3fu-due'+dueClass+'">'+esc(fmtDue(r.due_at,r.due_state))+'</span>'+
            '</div>'+
          '</div>'+
          '<div class="r3fu-actions">'+
            primary+
            '<details class="r3fu-secondary">'+
              '<summary>More</summary>'+
              '<div class="r3fu-secondary-menu">'+secondary+'</div>'+
            '</details>'+
          '</div>'+
        '</div>';
    }

    function closedSection(){
      var rows = state.closed;
      if(rows==null) return '';
      var body;
      if(state.closedErr){
        body = '<div class="r3fu-err small" data-ps-source="live" data-ps-state="unavailable">'+
          'Recently closed is unavailable: '+esc(state.closedErr)+
          ' <button class="r3fu-btn small" data-act="retryClosed">Retry</button></div>';
      } else if(!rows.length){
        body = '<div class="r3fu-empty" data-ps-source="live" data-ps-state="empty">'+
          'Nothing closed in the last 72 hours.</div>';
      } else {
        body = rows.map(function(r){
          var who = r.closed_by_name ? esc(r.closed_by_name) : 'system';
          var reopenCtl = r.reopenable
            ? '<button class="r3fu-btn small" data-act="reopen" data-oid="'+esc(r.obligation_id)+'">Reopen</button>'
            : '<span class="r3fu-noreopen">Can’t reopen — '+
              esc(REOPEN_REASON_WORDS[r.not_reopenable_reason]||REOPEN_REASON_WORDS.UNKNOWN)+'</span>';
          return ''+
            '<div class="r3fu-crow">'+
              '<div class="r3fu-crow-main">'+
                '<div class="r3fu-crow-top">'+esc(r.person_name||'—')+
                  ' <small>'+esc(r.label||'')+'</small></div>'+
                '<div class="r3fu-crow-meta">'+esc(r.resolution||'closed')+
                  ' · '+who+' · '+esc(relClosed(r.closed_at))+'</div>'+
              '</div>'+
              '<div class="r3fu-crow-act">'+reopenCtl+
                (r.person_id ? ' <button class="r3fu-btn ghost small" data-act="card" data-pid="'+
                  esc(r.person_id)+'" data-pname="'+esc(r.person_name||'')+'">Message</button>' : '')+
              '</div>'+
            '</div>';
        }).join('');
      }
      return ''+
        '<details class="r3fu-closed">'+
          '<summary>Recently closed <span>'+rows.length+' · 72h</span></summary>'+
          '<div class="r3fu-closed-body">'+body+'</div>'+
        '</details>';
    }

    /* ─── the action sheet (Complete / Reassign / Change-due / Reopen) ─── */
    function panelSheet(){
      var p = state.panel, r = p.row;
      var title, body;
      if(p.kind==='complete'){
        title = 'Complete follow-up';
        var opts = RESOLUTION_BASES.map(function(b){ return '<option value="'+b[0]+'">'+esc(b[1])+'</option>'; }).join('');
        body = ''+
          '<p class="r3fu-p">Marking <b>'+esc(r.label||'this follow-up')+'</b> for '+esc(r.person_name||'—')+' as done.</p>'+
          '<label class="r3fu-l">If you\u2019re closing work you don\u2019t own, say why</label>'+
          '<select id="r3fuBasis" class="r3fu-inp">'+opts+'</select>'+
          '<label class="r3fu-l">Proof / note (optional)</label>'+
          '<textarea id="r3fuProof" class="r3fu-inp" placeholder="What happened."></textarea>';
      } else if(p.kind==='reassign'){
        title = 'Reassign this task';
        var staff = state.staff||[];
        var sopts = '<option value="">— pick a person —</option>' + staff.map(function(s){
          var id = s.user_id||s.id; var nm = s.name||s.display_name||id;
          return '<option value="'+esc(id)+'">'+esc(nm)+'</option>';
        }).join('');
        body = ''+
          '<p class="r3fu-p">Only the task moves. The conversation\u2019s ownership is untouched.</p>'+
          '<label class="r3fu-l">Assign to</label>'+
          '<select id="r3fuTo" class="r3fu-inp">'+sopts+'</select>'+
          (staff.length?'':'<div class="r3fu-err small">No eligible staff returned for this property.</div>')+
          '<label class="r3fu-l">Reason</label>'+
          '<input id="r3fuReason" class="r3fu-inp" placeholder="Why the handoff.">';
      } else if(p.kind==='changeDue'){
        title = 'Change follow-up time';
        body = ''+
          '<p class="r3fu-p">This moves when the follow-up is due. It does not close it, and the owner stays the same. (Not a tour reschedule.)</p>'+
          '<label class="r3fu-l">New due time</label>'+
          '<input id="r3fuDue" class="r3fu-inp" type="datetime-local" value="'+esc(toLocalInputValue(r.due_at))+'">'+
          '<label class="r3fu-l">Reason</label>'+
          '<input id="r3fuReason" class="r3fu-inp" placeholder="Why the time changed.">';
      } else if(p.kind==='reopen'){
        title = 'Reopen this task';
        body = ''+
          '<p class="r3fu-p">Deliberate recovery of a closed follow-up. The prior close stays in the record. A new due time is required; a lapsed owner comes back unassigned.</p>'+
          '<label class="r3fu-l">New due time</label>'+
          '<input id="r3fuDue" class="r3fu-inp" type="datetime-local" value="'+esc(toLocalInputValue(null))+'">'+
          '<label class="r3fu-l">Reason</label>'+
          '<input id="r3fuReason" class="r3fu-inp" placeholder="Why it\u2019s being reopened.">';
      } else if(p.kind==='sendapp'){
        title = 'Send application';
        if(p.step==='unit'){
          var u = p.units;
          var list;
          if(p.busy || u==null){ list = '<div class="r3fu-empty small">Loading leaseable units\u2026</div>'; }
          else if(!u.length){ list = '<div class="r3fu-err small">No leaseable units to offer right now.</div>'; }
          else {
            list = u.map(function(x){
              var stw = String(x.availability_state||'').replace(/_/g,' ');
              return '<button class="r3fu-unitbtn" data-act="pickunit" data-uid="'+esc(x.unit_id)+'" data-ulabel="'+esc(x.unit_number||'')+'">'+
                       '<b>Unit '+esc(x.unit_number||'?')+'</b><span>'+esc(stw)+'</span></button>';
            }).join('');
          }
          body = '<p class="r3fu-p">Which unit is <b>'+esc(p.row.person_name||'this prospect')+'</b> applying for? Only currently leaseable units are offered — tapping one texts the application.</p>'+
                 '<div class="r3fu-unitwrap">'+list+'</div>';
        } else { // sending
          body = '<p class="r3fu-p">Sending the application to '+esc(p.row.person_name||'the prospect')+'\u2026</p>';
        }
      }
      var errHtml = p.err ? '<div class="r3fu-err">'+esc(p.err)+'</div>' : '';
      var busy = p.busy ? ' disabled' : '';
      // sendapp drives its own actions inline — footer is just a quiet Close.
      var footer = (p.kind==='sendapp')
        ? '<div class="r3fu-sheet-actions"><button class="r3fu-btn ghost" data-act="cancel">Close</button></div>'
        : '<div class="r3fu-sheet-actions">'+
            '<button class="r3fu-btn ghost" data-act="cancel">Cancel</button>'+
            '<button class="r3fu-btn primary" data-act="confirm"'+busy+'>'+(p.busy?'Working\u2026':'Confirm')+'</button>'+
          '</div>';
      var node = el(''+
        '<div class="r3fu-scrim" data-act="scrim">'+
          '<div class="r3fu-sheet" role="dialog" aria-modal="true">'+
            '<div class="r3fu-sheet-h">'+esc(title)+'</div>'+
            body + errHtml +
            footer +
          '</div>'+
        '</div>');
      return node;
    }

    /* ─────────────────────────── event binding ─────────────────────────── */
    function bind(){
      if(!rootEl) return;
      rootEl.querySelectorAll('[data-act]').forEach(function(node){
        // skip nodes inside the panel/scrim — those get their own handlers below.
        if(node.closest && node.closest('.r3fu-scrim')){ return; }
        var act = node.getAttribute('data-act');
        node.onclick = function(ev){
          ev.preventDefault();
          if(act==='more'){ loadMore(); return; }
          if(act==='retryQueue'){ refresh(); return; }
          if(act==='retryClosed'){ loadClosed(); return; }
          if(act==='card'){ openCard(node.getAttribute('data-pid'), node.getAttribute('data-pname')); return; }
          if(act==='complete'||act==='reassign'||act==='changeDue'||act==='reopen'){
            openPanel(act, node.getAttribute('data-oid')); return;
          }
          if(act==='sendapp'){ openSendPanel(node.getAttribute('data-oid')); return; }
        };
      });
      // panel controls are on the appended scrim
      var scrim = rootEl.querySelector('.r3fu-scrim');
      if(scrim){
        scrim.querySelectorAll('[data-act]').forEach(function(node){
          var act=node.getAttribute('data-act');
          node.onclick=function(ev){
            ev.preventDefault();
            if(act==='cancel'||act==='scrim'){ if(ev.target===scrim || act==='cancel') closePanel(); return; }
            if(act==='confirm'){ confirmPanel(); return; }
            if(act==='pickunit'){
              console.log('[door] pickunit clicked', node.getAttribute('data-uid'), 'panel.row=', state.panel && state.panel.row && state.panel.row.person_id);
              var prow = state.panel && state.panel.row;
              if(!prow){ console.warn('[door] pickunit: no panel.row'); return; }
              sendNow(prow, node.getAttribute('data-uid')); return;
            }
          };
        });
      }
    }

    function confirmPanel(){
      var p=state.panel; if(!p) return; var r=p.row; var oid=r.obligation_id;
      if(p.kind==='complete'){
        var basis = (rootEl.querySelector('#r3fuBasis')||{}).value || null;
        var proof = (rootEl.querySelector('#r3fuProof')||{}).value || null;
        submit(function(){ return doResolve(oid, { result:'completed', proof:proof, resolution_basis:basis||null }); });
      } else if(p.kind==='reassign'){
        var to = (rootEl.querySelector('#r3fuTo')||{}).value || null;
        var reason = (rootEl.querySelector('#r3fuReason')||{}).value || null;
        if(!to){ p.err='Pick who it goes to.'; render(); return; }
        submit(function(){ return doReassign(oid, { to_user_id:to, reason:reason, idempotency_key:uid() }); });
      } else if(p.kind==='changeDue'){
        var due = localInputToISO((rootEl.querySelector('#r3fuDue')||{}).value);
        var reason2 = (rootEl.querySelector('#r3fuReason')||{}).value || null;
        if(!due){ p.err='Pick a new time.'; render(); return; }
        submit(function(){ return doChangeDue(oid, { new_due_at:due, reason:reason2, idempotency_key:uid() }); });
      } else if(p.kind==='reopen'){
        var due2 = localInputToISO((rootEl.querySelector('#r3fuDue')||{}).value);
        var reason3 = (rootEl.querySelector('#r3fuReason')||{}).value || null;
        if(!due2){ p.err='A reopened task needs a new due time.'; render(); return; }
        submit(function(){ return doReopen(oid, { new_due_at:due2, reason:reason3, idempotency_key:uid() }); });
      }
    }

    // Hand person-card opening back to the app if it exposes a hook; otherwise
    // no-op gracefully (never throw inside the door).
    // A follow-up IS a communication commitment. Opening it lands directly on
    // the CONVERSATION thread (context:'communications' → the card's
    // Communication tab, where the message is read and sent), not a profile.
    function openCard(pid, personName){
      if(!pid) return;
      try{
        if(typeof window.openPersonCard==='function'){
          window.openPersonCard({ person_id:pid, name:personName||null, context:'communications' });
          return;
        }
        if(typeof window.openPersonCardById==='function'){ window.openPersonCardById(pid); return; }
      }catch(e){}
    }

    function mount(node){
      rebindRoot(node || (rootEl || document.getElementById('psFollowupsEntry')));
      render();
      refresh();
    }

    function tileStatus(){
      if(!hasSession()) return { enabled:false, connected:false, open:0, overdue:0 };
      var c = state.counts || {};
      return { enabled:true, connected:true,
               open:Number(c.open||0), overdue:Number(c.overdue||0),
               unassigned:Number(c.unassigned||0) };
    }

    return { mount:mount, rebindRoot:rebindRoot, tileStatus:tileStatus, refresh:refresh, _state:function(){return state;} };
  }

  /* ─────────────── one controller across rerenders (idempotent) ─────────────── */
  var _ctl = null;
  function ensureController(){ if(!_ctl) _ctl = makeController(); return _ctl; }

  function entryHTML(){
    return '<div id="psFollowupsEntry" class="r3fu-lane" data-psfu="1"></div>';
  }
  function mount(rootEl){
    if(!rootEl) rootEl = document.getElementById('psFollowupsEntry');
    if(!rootEl) return;
    if(!hasSession()){
      rootEl.innerHTML = '<div class="r3fu-shell"><div class="r3fu-empty">Live follow-ups are not connected in this view.</div></div>';
      return;
    }
    ensureController().mount(rootEl);
  }
  function tileStatus(){
    try{ return ensureController().tileStatus(); }
    catch(e){ return { enabled:false, connected:false, open:0, overdue:0 }; }
  }
  // Property-switch teardown hook: drop the controller so the next property
  // starts clean (mirrors __resetPropertyScopedState clearing sealed state).
  function reset(){ _ctl = null; }

  if(typeof window!=='undefined'){
    var surface = Object.freeze({
      mount: mount,
      entryHTML: entryHTML,
      tileStatus: tileStatus,
      reset: reset
    });
    Object.defineProperty(window, '__psFollowups', {
      value: surface, writable:false, configurable:false, enumerable:true
    });
  }

  // Headless export for the smoke harness (factory + helpers only; no window).
  if(typeof module!=='undefined' && module.exports){
    module.exports = {
      makeController: makeController,
      _helpers: { esc:esc, fmtDue:fmtDue, relClosed:relClosed, localInputToISO:localInputToISO, toLocalInputValue:toLocalInputValue,
                  BASIS_WORDS:BASIS_WORDS, REOPEN_REASON_WORDS:REOPEN_REASON_WORDS, RESOLUTION_BASES:RESOLUTION_BASES, GROUPS_ORDER:['overdue','today','upcoming','none'] }
    };
  }
})();
