/* ════════════════════════════════════════════════════════════════════════════
   PROPERTY SPINE — CANONICAL LEASING HOME (Leg 3 frontend shell)
   ────────────────────────────────────────────────────────────────────────────
   Reads ONE server-authored projection: GET /operator/leasing/desk through the
   sealed __psLive loader resource `leasingDesk`.

   The browser does not classify, rank, deduplicate, or infer lifecycle state.
   It preserves server band order and dispatches the structured primary action.

   Existing task writes remain on the canonical named __psLive methods:
     resolveTask · reassignTask · reopenTask · changeDueTask
     sendApplicationSms · leaseableUnits

   Compatibility: this file intentionally keeps the existing global surface
     window.__psFollowups = { mount, entryHTML, tileStatus, refresh, reset }
   so index.html does not need a second Leasing runtime.
   ════════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  var RESOURCE = { desk:'leasingDesk', eligibleStaff:'eligibleStaff' };
  var ACTIVE_BANDS = ['ready_to_bind','ready_to_advance','follow_ups'];
  var PRIMARY_BANDS = ['ready_to_advance','follow_ups'];
  var WAITING_CODES = { await_resident_acknowledgment:true, awaiting_acknowledgment:true, active:true, closed:true };

  function injectStyles(){
    if(typeof document==='undefined' || document.getElementById('ps-leasing-home-style')) return;
    var s=document.createElement('style');
    s.id='ps-leasing-home-style';
    s.textContent=[
      ":root{--pslh-ink:#151511;--pslh-muted:#6d685f;--pslh-faint:#9a958b;--pslh-line:#d8d4cb;--pslh-soft:#ece8df;--pslh-paper:#fff;--pslh-warm:#f4ede0;--pslh-warm-2:#fbf7ef;--pslh-sage:#e7f0eb;--pslh-sage-2:#f4f8f5;--pslh-red:#a13d31;--pslh-amber:#96681d;--pslh-green:#23664e;--pslh-shadow:0 18px 44px rgba(33,28,18,.08)}",
      ".pslh{max-width:1060px;color:var(--pslh-ink);font-family:\"IBM Plex Sans\",system-ui,sans-serif}",
      ".pslh *{box-sizing:border-box}",
      ".pslh-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(330px,420px);gap:38px;align-items:end;padding:4px 0 26px}",
      ".pslh-eyebrow{font:600 9px/1.2 \"IBM Plex Mono\",monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--pslh-green)}",
      ".pslh-title{font-family:\"Fraunces\",Georgia,serif;font-size:44px;font-weight:500;letter-spacing:-.045em;line-height:.98;margin:8px 0 0}",
      ".pslh-sub{font-size:13px;color:var(--pslh-muted);line-height:1.55;margin-top:10px;max-width:600px}",
      ".pslh-pulse{display:grid;grid-template-columns:1.25fr repeat(3,1fr);align-items:stretch;border:1px solid var(--pslh-line);border-radius:20px;background:rgba(255,255,255,.86);box-shadow:0 10px 28px rgba(33,28,18,.05);overflow:hidden}",
      ".pslh-pulse-cell{min-height:76px;padding:14px 14px 12px;border-left:1px solid var(--pslh-soft);display:flex;flex-direction:column;justify-content:center}",
      ".pslh-pulse-cell:first-child{border-left:0;background:#f7f4ed}",
      ".pslh-pulse-cell strong{font-family:\"Fraunces\",Georgia,serif;font-size:28px;font-weight:500;line-height:1}",
      ".pslh-pulse-cell span{margin-top:7px;font:600 8.5px/1.2 \"IBM Plex Mono\",monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--pslh-faint)}",
      ".pslh-pulse-cell.overdue strong{color:var(--pslh-red)}.pslh-pulse-cell.today strong{color:var(--pslh-amber)}.pslh-pulse-cell.unassigned strong{color:#38586a}",
      ".pslh-flash{border:1px solid #c9ddd2;border-radius:14px;background:#f3f8f5;color:var(--pslh-green);padding:11px 13px;font-size:12px;margin:6px 0 18px}",
      ".pslh-flash.err{border-color:#e2c4be;background:#fbefed;color:var(--pslh-red)}",
      ".pslh-band{margin-top:22px;border:1px solid var(--pslh-line);border-radius:24px;background:#fff;overflow:hidden;box-shadow:var(--pslh-shadow)}",
      ".pslh-band + .pslh-band{margin-top:24px}",
      ".pslh-band-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:22px;align-items:center;padding:23px 24px 21px;border-bottom:1px solid rgba(99,86,61,.12);position:relative;overflow:hidden}",
      ".pslh-band-head:after{content:\"\";position:absolute;right:-74px;top:-92px;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,.36);pointer-events:none}",
      ".pslh-band.advance .pslh-band-head{background:linear-gradient(135deg,#f6ecda 0%,#fbf7ef 76%)}",
      ".pslh-band.follow .pslh-band-head{background:linear-gradient(135deg,#e5efe9 0%,#f3f8f5 76%)}",
      ".pslh-band.bind .pslh-band-head{background:linear-gradient(135deg,#dfeee7 0%,#f1f7f3 76%)}",
      ".pslh-band-kicker{font:700 9px/1.2 \"IBM Plex Mono\",monospace;letter-spacing:.17em;text-transform:uppercase;color:var(--pslh-muted);margin-bottom:7px}",
      ".pslh-band.advance .pslh-band-kicker{color:#88601c}.pslh-band.follow .pslh-band-kicker,.pslh-band.bind .pslh-band-kicker{color:var(--pslh-green)}",
      ".pslh-band-title{font-family:\"Fraunces\",Georgia,serif;font-size:32px;font-weight:500;letter-spacing:-.04em;line-height:1}",
      ".pslh-band-desc{font-size:12.5px;color:var(--pslh-muted);margin-top:8px;line-height:1.48;max-width:650px}",
      ".pslh-band-count{position:relative;z-index:1;min-width:62px;height:62px;border-radius:999px;background:rgba(21,21,17,.92);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 8px 20px rgba(33,28,18,.13)}",
      ".pslh-band.follow .pslh-band-count{background:#285e4a}.pslh-band-count strong{font-family:\"Fraunces\",Georgia,serif;font-size:24px;font-weight:500;line-height:.92}.pslh-band-count span{font:600 7px/1.2 \"IBM Plex Mono\",monospace;letter-spacing:.09em;text-transform:uppercase;opacity:.68;margin-top:4px}",
      ".pslh-band-body{padding:0 24px;background:#fff}",
      ".pslh-empty{font-size:12px;color:var(--pslh-faint);padding:21px 0 24px;line-height:1.5}",
      ".pslh-row{display:grid;grid-template-columns:5px minmax(0,1fr) auto;gap:18px;align-items:center;padding:19px 0;border-top:1px solid var(--pslh-soft);transition:background .14s ease}",
      ".pslh-band-body .pslh-row:first-child{border-top:0}",
      ".pslh-row:before{content:\"\";width:5px;height:42px;border-radius:999px;background:#d8d4cb}",
      ".pslh-row.overdue:before{background:var(--pslh-red)}.pslh-row.blocked:before{background:var(--pslh-amber)}.pslh-row.unassigned:before{background:#6b8794}.pslh-row:hover{background:#fcfbf8}",
      ".pslh-row-main{min-width:0}",
      ".pslh-row-top{display:flex;align-items:baseline;gap:10px;min-width:0}",
      ".pslh-person{font-size:15px;font-weight:650;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".pslh-unit{font:500 9px/1.2 \"IBM Plex Mono\",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--pslh-faint);white-space:nowrap}",
      ".pslh-state{font-size:13px;color:#35332e;margin-top:5px;line-height:1.45}",
      ".pslh-blocker{font-size:11.5px;color:var(--pslh-amber);margin-top:5px;line-height:1.4;font-weight:500}",
      ".pslh-meta{display:flex;gap:8px 16px;flex-wrap:wrap;margin-top:8px;font-size:11.5px;color:var(--pslh-faint)}",
      ".pslh-owner.unassigned{color:#5f7c89}.pslh-due.overdue{color:var(--pslh-red);font-weight:600}",
      ".pslh-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px;min-width:190px;position:relative}",
      ".pslh-btn{appearance:none;border:1px solid #cbc9c2;background:#fff;color:#292823;border-radius:999px;padding:9px 14px;font:600 10.5px/1.2 \"IBM Plex Sans\",sans-serif;cursor:pointer;white-space:nowrap;transition:transform .12s ease,box-shadow .12s ease,background .12s ease}",
      ".pslh-btn:hover{border-color:#8d8981;background:#faf9f6;transform:translateY(-1px)}.pslh-btn:focus-visible{outline:2px solid #171713;outline-offset:3px}",
      ".pslh-btn.primary{background:var(--pslh-ink);color:#fff;border-color:var(--pslh-ink);box-shadow:0 7px 16px rgba(21,21,17,.14)}.pslh-btn.primary:hover{background:#302f2a;box-shadow:0 9px 20px rgba(21,21,17,.18)}",
      ".pslh-btn.ghost{border-color:transparent;background:transparent;color:#625f58;padding-left:4px;padding-right:4px;box-shadow:none}",
      ".pslh-btn.small{padding:6px 10px;font-size:10px}",
      ".pslh-more{position:relative}.pslh-more>summary{list-style:none;cursor:pointer;font-size:11px;color:#777169;padding:9px 2px;user-select:none}.pslh-more>summary::-webkit-details-marker{display:none}.pslh-more>summary:after{content:\" \u00b7\u00b7\u00b7\";letter-spacing:.08em}",
      ".pslh-menu{position:absolute;right:0;top:37px;z-index:40;width:164px;background:#fff;border:1px solid #d7d5ce;border-radius:13px;padding:6px;box-shadow:0 18px 44px rgba(20,18,14,.14)}",
      ".pslh-menu .pslh-btn{display:block;width:100%;border:0;border-radius:8px;background:transparent;text-align:left;padding:9px 10px;box-shadow:none}.pslh-menu .pslh-btn:hover{background:#f5f3ee;transform:none}",
      ".pslh-closed{margin-top:22px;border:1px solid var(--pslh-line);border-radius:18px;background:#faf9f5;overflow:hidden}.pslh-closed>summary{list-style:none;cursor:pointer;padding:16px 18px;font:600 10px/1.2 \"IBM Plex Mono\",monospace;letter-spacing:.08em;text-transform:uppercase;color:#605c54}",
      ".pslh-closed>summary::-webkit-details-marker{display:none}.pslh-closed>summary:after{content:\"+\";float:right;color:#8b887f}.pslh-closed[open]>summary:after{content:\"\u2013\"}.pslh-closed>summary span{color:var(--pslh-faint);margin-left:5px}",
      ".pslh-closed .pslh-crow,.pslh-closed .pslh-empty{margin:0 18px}.pslh-crow{display:flex;justify-content:space-between;gap:18px;align-items:center;padding:13px 0;border-top:1px solid var(--pslh-soft)}",
      ".pslh-crow-name{font-size:13px;font-weight:600}.pslh-crow-name small{font-weight:400;color:var(--pslh-muted)}.pslh-crow-meta{font-size:11px;color:var(--pslh-faint);margin-top:3px}.pslh-crow-act{display:flex;align-items:center;gap:8px;flex-shrink:0}.pslh-noreopen{font-size:11px;color:var(--pslh-faint);font-style:italic}",
      ".pslh-loading{font-size:13px;color:var(--pslh-muted);padding:28px 0;border-bottom:1px solid var(--pslh-line)}",
      ".pslh-error{border:1px solid #e2c4be;border-radius:14px;background:#fbefed;color:#8d3026;padding:12px 14px;font-size:12px;line-height:1.5;margin-top:16px}.pslh-error .pslh-btn{margin-left:8px}",
      ".pslh-scrim{position:fixed;inset:0;background:rgba(15,15,15,.38);display:flex;align-items:center;justify-content:center;z-index:9000;padding:20px;backdrop-filter:blur(3px)}",
      ".pslh-sheet{background:#fff;border-radius:22px;max-width:440px;width:100%;padding:25px;box-shadow:0 30px 80px rgba(0,0,0,.24)}",
      ".pslh-sheet-title{font-family:\"Fraunces\",Georgia,serif;font-size:24px;font-weight:500;letter-spacing:-.03em;margin-bottom:11px}.pslh-p{font-size:13px;color:#5f5c56;line-height:1.5;margin:0 0 14px}.pslh-label{display:block;font:600 9px/1.2 \"IBM Plex Mono\",monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--pslh-muted);margin:12px 0 5px}.pslh-input{width:100%;border:1px solid #d4d2cb;border-radius:10px;padding:10px 11px;font-size:13px;font-family:inherit;box-sizing:border-box}textarea.pslh-input{min-height:64px;resize:vertical}.pslh-sheet-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:19px}.pslh-unit-list{display:flex;flex-direction:column;gap:8px;margin:8px 0}.pslh-unit-btn{display:flex;justify-content:space-between;align-items:center;gap:12px;text-align:left;border:1px solid #deddd8;background:#fff;border-radius:10px;padding:11px 13px;cursor:pointer;font-family:inherit}.pslh-unit-btn:hover{border-color:#8f8b83}.pslh-unit-btn b{font-size:14px}.pslh-unit-btn span{font-size:11px;color:var(--pslh-muted)}",
      "@media(max-width:760px){.pslh-head{grid-template-columns:1fr;gap:22px}.pslh-title{font-size:39px}.pslh-pulse{grid-template-columns:1.2fr repeat(3,1fr)}.pslh-pulse-cell{min-height:68px;padding:12px 10px}.pslh-pulse-cell strong{font-size:24px}.pslh-band{margin-top:18px;border-radius:20px}.pslh-band + .pslh-band{margin-top:20px}.pslh-band-head{padding:19px 18px 18px}.pslh-band-title{font-size:28px}.pslh-band-count{width:54px;min-width:54px;height:54px}.pslh-band-body{padding:0 18px}.pslh-row{grid-template-columns:4px 1fr;gap:13px}.pslh-row:before{grid-row:1 / span 2;height:46px}.pslh-actions{grid-column:2;justify-content:space-between;min-width:0;padding-bottom:2px}.pslh-menu{left:0;right:auto}.pslh-crow{align-items:flex-start;flex-direction:column}}",
      "@media(max-width:460px){.pslh-pulse{grid-template-columns:1fr 1fr}.pslh-pulse-cell:nth-child(3){border-left:0;border-top:1px solid var(--pslh-soft)}.pslh-pulse-cell:nth-child(4){border-top:1px solid var(--pslh-soft)}.pslh-band-head{grid-template-columns:minmax(0,1fr) auto;gap:12px}.pslh-band-desc{font-size:12px}.pslh-actions{align-items:center}.pslh-btn.primary{max-width:220px;overflow:hidden;text-overflow:ellipsis}}"
    ].join('\n');
    document.head.appendChild(s);
  }
  if(typeof document!=='undefined'){ if(document.head) injectStyles(); else document.addEventListener('DOMContentLoaded',injectStyles); }

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
  function live(){ return (typeof window!=='undefined' && window.__psLive) ? window.__psLive : null; }
  function hasSession(){ var L=live(); return !!(L && L.hasSession && L.hasSession()); }
  function uid(){ return 'pslh_'+Date.now()+'_'+Math.random().toString(36).slice(2,8); }
  function unwrap(out){ return out && out.data ? out.data : out; }
  function humanCode(v){ return String(v||'').replace(/_/g,' '); }
  function localInputToISO(v){ if(!v) return null; var t=Date.parse(v); return isNaN(t)?null:new Date(t).toISOString(); }
  function toLocalInputValue(iso){ var t=iso?Date.parse(iso):Date.now(); var d=new Date(isNaN(t)?Date.now():t); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,16); }
  function fmtDue(v,state){
    if(!v) return 'No due time';
    var t=Date.parse(v); if(isNaN(t)) return state||'';
    var d=new Date(t);
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' · '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  }
  function relClosed(v){
    if(!v) return '';
    var t=Date.parse(v); if(isNaN(t)) return '';
    var mins=Math.max(0,Math.round((Date.now()-t)/60000));
    if(mins<60) return mins+'m ago';
    var hrs=Math.round(mins/60); if(hrs<48) return hrs+'h ago';
    return Math.round(hrs/24)+'d ago';
  }

  function closedReceipt(payload){
    var r=null;
    if(payload && payload.receipts && payload.receipts.recently_closed!=null) r=payload.receipts.recently_closed;
    else if(payload && payload.recently_closed!=null) r=payload.recently_closed;
    if(Array.isArray(r)) return { window_hours:72, items:r };
    if(r && typeof r==='object') return r;
    return { window_hours:72, items:[] };
  }

  function validateDesk(payload){
    if(!payload || typeof payload!=='object') throw new Error('Leasing Desk returned no contract.');
    if(!payload.bands || typeof payload.bands!=='object') throw new Error('Leasing Desk returned no bands.');
    var seen={};
    ACTIVE_BANDS.forEach(function(band){
      var rows=payload.bands[band];
      if(!Array.isArray(rows)) throw new Error('Leasing Desk band '+band+' is missing.');
      rows.forEach(function(row){
        if(!row || typeof row!=='object') throw new Error('Leasing Desk returned an invalid row.');
        if(row.band && row.band!==band) throw new Error('Leasing Desk row placement disagrees with its band.');
        if(!row.desk_key) throw new Error('Leasing Desk row has no desk_key.');
        if(seen[row.desk_key]) throw new Error('Leasing Desk returned the same desk_key twice.');
        seen[row.desk_key]=true;
        if(WAITING_CODES[row.next_action_code]) throw new Error('Leasing Desk returned waiting/completed work as actionable.');
        if(!row.primary_action || !row.primary_action.label || !row.primary_action.kind || !row.primary_action.target){
          throw new Error('Leasing Desk row has no complete primary_action.');
        }
      });
    });
    var r=closedReceipt(payload);
    if(r.items!=null && !Array.isArray(r.items)) throw new Error('Recently closed receipt is malformed.');
    return payload;
  }

  function makeController(){
    var root=null;
    var state={ loading:false, error:null, desk:null, staff:null, panel:null, sending:null, flash:null, errorFlash:null, returnPoint:null, awaitingReviewReturn:false };

    async function loadResource(name,params){
      var L=live(); if(!L || typeof L.loadResource!=='function') throw new Error('Live loader unavailable.');
      return unwrap(await L.loadResource(name,params||{}));
    }
    async function write(method,params){
      var L=live(); if(!L || typeof L[method]!=='function') throw new Error('Live action '+method+' is unavailable.');
      return unwrap(await L[method](params||{}));
    }

    async function refresh(){
      if(!hasSession()){ render(); return; }
      state.loading=true; state.error=null; render();
      state.desk=null; render();
      try{ state.desk=validateDesk(await loadResource(RESOURCE.desk,{})); }
      catch(e){ state.desk=null; state.error=(e&&e.message)||'Could not load Leasing.'; }
      state.loading=false; render(); restoreReturnPoint();
    }

    function restoreReturnPoint(){
      if(!root || !state.returnPoint || !state.desk) return;
      var p=state.returnPoint; state.returnPoint=null;
      requestAnimationFrame(function(){
        try{
          if(typeof window!=='undefined' && typeof window.scrollTo==='function') window.scrollTo(0,p.scrollY||0);
          var q='[data-desk-key="'+String(p.deskKey).replace(/"/g,'\\"')+'"] .pslh-btn.primary';
          var n=root.querySelector(q); if(n) n.focus();
        }catch(_){}
      });
    }

    async function ensureStaff(){
      if(state.staff) return state.staff;
      try{
        var r=await loadResource(RESOURCE.eligibleStaff,{});
        state.staff=Array.isArray(r)?r:(r.staff||r.items||[]);
      }catch(_){ state.staff=[]; }
      return state.staff;
    }

    function allRows(){
      if(!state.desk) return [];
      return ACTIVE_BANDS.reduce(function(a,b){ return a.concat(state.desk.bands[b]||[]); },[])
        .concat((closedReceipt(state.desk).items)||[]);
    }
    function findRow(key){ return allRows().filter(function(r){ return String(r.desk_key||r.obligation_id)===String(key); })[0]||null; }
    function openPanel(kind,key){
      var row=findRow(key); if(!row) return;
      state.panel={kind:kind,row:row,busy:false,error:null};
      if(kind==='reassign') ensureStaff().then(render);
      render();
    }
    function closePanel(){ state.panel=null; render(); }

    function applicationIdFor(row){
      var t=row&&row.primary_action&&row.primary_action.target;
      return (t&&t.type==='application'&&t.id) || row.application_id || null;
    }
    function openApplicationReview(row){
      var id=applicationIdFor(row); if(!id){ state.errorFlash='This row has no application target.'; render(); return; }
      state.returnPoint={deskKey:row.desk_key,scrollY:(typeof window!=='undefined'&&window.scrollY)||0};
      state.awaitingReviewReturn=true;
      var detail={application_id:id,source:'leasing_desk',return_to:'leasing'};
      try{
        if(typeof window.openApplicationReview==='function'){ window.openApplicationReview(detail); return; }
        if(typeof window.psOpenApplicationReview==='function'){ window.psOpenApplicationReview(id,detail); return; }
        if(typeof window.openLeasingApplicationReview==='function'){ window.openLeasingApplicationReview(id,detail); return; }
        var ev=new CustomEvent('ps:open-application-review',{detail:detail,cancelable:true});
        if(window.dispatchEvent(ev)===false) return;
      }catch(e){ state.errorFlash=(e&&e.message)||'Could not open Application Review.'; render(); return; }
      state.errorFlash='Application Review is not connected to the Leasing shell.'; render();
    }
    function openCard(row){
      if(!row || !row.person_id) return;
      try{
        if(typeof window.openPersonCard==='function'){ window.openPersonCard({person_id:row.person_id,name:row.person_name||null,context:'communications'}); return; }
        if(typeof window.openPersonCardById==='function') window.openPersonCardById(row.person_id);
      }catch(_){}
    }

    async function openSend(row){
      if(!row || !row.obligation_id || state.sending) return;
      if(row.unit_id){ await sendNow(row,row.unit_id); return; }
      state.panel={kind:'sendapp',row:row,busy:true,error:null,units:null}; render();
      try{
        var L=live(); if(!L || typeof L.leaseableUnits!=='function') throw new Error('Leaseable-unit read unavailable.');
        var out=unwrap(await L.leaseableUnits()); state.panel.units=(out&&out.units)||[]; state.panel.busy=false;
      }catch(e){ state.panel.busy=false; state.panel.error=(e&&e.message)||'Could not load leaseable units.'; }
      render();
    }
    async function sendNow(row,unitId){
      if(state.sending) return;
      state.sending=row.obligation_id; if(state.panel) state.panel.busy=true; render();
      try{
        var L=live(); if(!L || typeof L.sendApplicationSms!=='function') throw new Error('Application send is unavailable.');
        var out=unwrap(await L.sendApplicationSms({person_id:row.person_id,unit_id:unitId,conversion_id:row.conversion_id}));
        if(!out || !out.sent) throw new Error((out&&out.receipt)||'The application could not be sent.');
        state.panel=null; state.sending=null; state.flash=out.receipt||('Application sent to '+(row.person_name||'the prospect')+'.');
        await refresh(); setTimeout(function(){state.flash=null;render();},6000);
      }catch(e){ state.sending=null; if(state.panel){state.panel.busy=false;state.panel.error=(e&&e.message)||'The application could not be sent.';} else state.errorFlash=(e&&e.message)||'The application could not be sent.'; render(); }
    }

    function runPrimary(row){
      var a=row.primary_action||{}, t=a.target||{}, code=a.code||'';
      if(a.kind==='navigation' && t.type==='application'){ openApplicationReview(row); return; }
      if(a.kind==='navigation' && (t.type==='person'||t.type==='conversation')){ openCard(row); return; }
      if(a.kind==='task_write' && code==='send_application'){ openSend(row); return; }
      if(a.kind==='task_write' && (code==='complete_task'||code==='complete')){ openPanel('complete',row.desk_key); return; }
      state.errorFlash='The server authored an action this client does not support: '+(code||a.kind)+'.'; render();
    }

    async function submit(fn){
      if(!state.panel) return;
      state.panel.busy=true; state.panel.error=null; render();
      try{
        var out=await fn(); state.panel=null; state.flash=(out&&(out.receipt||out.message))||'Done.';
        await refresh(); setTimeout(function(){state.flash=null;render();},6000);
      }catch(e){ state.panel.busy=false; state.panel.error=(e&&(e.publicMessage||e.message))||'That did not go through.'; render(); }
    }

    function ownerText(row){
      if(row.owner_name) return esc(row.owner_name)+(row.owner_basis?' · '+esc(humanCode(row.owner_basis)):'');
      return 'Unassigned';
    }
    function taskSecondary(row){
      if(row.source!=='followup_rail') return '';
      var key=esc(row.desk_key);
      return '<details class="pslh-more"><summary aria-label="More actions">More</summary><div class="pslh-menu">'+
        '<button class="pslh-btn" data-act="complete" data-key="'+key+'">Complete</button>'+
        '<button class="pslh-btn" data-act="reassign" data-key="'+key+'">Reassign</button>'+
        '<button class="pslh-btn" data-act="changeDue" data-key="'+key+'">Change time</button>'+
        (row.person_id?'<button class="pslh-btn" data-act="message" data-key="'+key+'">Message</button>':'')+
      '</div></details>';
    }
    function rowHTML(row){
      var dueClass=row.due_state==='overdue'?' overdue':'';
      var ownerClass=row.owner_name?'':' unassigned';
      var unit=row.unit_number||row.unit_label||null;
      var rowClasses='pslh-row'+(row.due_state==='overdue'?' overdue':'')+(row.blocker_code?' blocked':'')+(!row.owner_name?' unassigned':'');
      return '<div class="'+rowClasses+'" data-desk-key="'+esc(row.desk_key)+'">'+
        '<div class="pslh-row-main"><div class="pslh-row-top"><span class="pslh-person">'+esc(row.person_name||'Unnamed person')+'</span>'+(unit?'<span class="pslh-unit">'+esc(unit)+'</span>':'')+'</div>'+
          '<div class="pslh-state">'+esc(row.state_label||row.label||'Leasing work')+'</div>'+
          (row.blocker_code?'<div class="pslh-blocker">Needs review · '+esc(humanCode(row.blocker_code))+'</div>':'')+
          '<div class="pslh-meta"><span class="pslh-owner'+ownerClass+'">'+ownerText(row)+'</span><span class="pslh-due'+dueClass+'">'+esc(fmtDue(row.due_at,row.due_state))+'</span></div></div>'+
        '<div class="pslh-actions"><button class="pslh-btn primary" data-act="primary" data-key="'+esc(row.desk_key)+'">'+esc(row.primary_action.label)+'</button>'+taskSecondary(row)+'</div></div>';
    }

    var BAND_META={
      ready_to_bind:{klass:'bind',kicker:'Signature desk',title:'Ready for company signature',desc:'The resident has signed. Company countersignature is the remaining governed step — this is not yet an executed lease.',empty:''},
      ready_to_advance:{klass:'advance',kicker:'Applications',title:'Ready to advance',desc:'Decisions and governed review steps the company can complete now.',empty:'No application needs a company decision right now.'},
      follow_ups:{klass:'follow',kicker:'Human commitments',title:'Follow-ups',desc:'Open promises, outreach, and leasing work that still needs a person.',empty:'No leasing follow-up is currently actionable.'}
    };
    function bandHTML(code){
      var m=BAND_META[code], rows=(state.desk.bands[code]||[]);
      return '<section class="pslh-band '+m.klass+'" data-band="'+code+'"><div class="pslh-band-head"><div><div class="pslh-band-kicker">'+m.kicker+'</div><div class="pslh-band-title">'+m.title+'</div><div class="pslh-band-desc">'+m.desc+'</div></div><div class="pslh-band-count"><strong>'+rows.length+'</strong><span>'+((rows.length===1)?'item':'items')+'</span></div></div><div class="pslh-band-body">'+
        (rows.length?rows.map(rowHTML).join(''):'<div class="pslh-empty" data-ps-state="empty">'+m.empty+'</div>')+'</div></section>';
    }
    function activeBandHTML(){
      var bindRows=(state.desk.bands.ready_to_bind||[]);
      var out=bindRows.length?bandHTML('ready_to_bind'):'';
      PRIMARY_BANDS.forEach(function(code){ out+=bandHTML(code); });
      return out;
    }

    var REOPEN_REASON={REOPEN_WINDOW_EXPIRED:'past the recovery window',DOWNSTREAM_WORK_EXISTS:'later work already happened',RELATIONSHIP_CLOSED:'the relationship is closed',ALREADY_RECOVERED:'already reopened once',DECISION_NOT_RECOVERABLE:'a decision, not a task'};
    function closedHTML(){
      var r=closedReceipt(state.desk), rows=r.items||[], hrs=r.window_hours||72;
      var body=rows.length?rows.map(function(row){
        var key=esc(row.desk_key||row.obligation_id), reopen=row.reopenable
          ? '<button class="pslh-btn small" data-act="reopen" data-key="'+key+'">Reopen</button>'
          : '<span class="pslh-noreopen">Can’t reopen · '+esc(REOPEN_REASON[row.not_reopenable_reason]||'not recoverable')+'</span>';
        return '<div class="pslh-crow"><div><div class="pslh-crow-name">'+esc(row.person_name||'Unnamed person')+' <small>'+esc(row.label||row.state_label||'')+'</small></div><div class="pslh-crow-meta">'+esc(row.resolution||'closed')+' · '+esc(row.closed_by_name||'system')+' · '+esc(relClosed(row.closed_at))+'</div></div><div class="pslh-crow-act">'+reopen+(row.person_id?'<button class="pslh-btn ghost small" data-act="message" data-key="'+key+'">Message</button>':'')+'</div></div>';
      }).join(''):'<div class="pslh-empty">Nothing closed in the last '+esc(hrs)+' hours.</div>';
      return '<details class="pslh-closed"><summary>Recently closed <span>'+rows.length+'</span></summary>'+body+'</details>';
    }

    function headerHTML(){
      var c=state.desk.counts||{};
      return '<header class="pslh-head"><div><div class="pslh-eyebrow">Operating desk</div><h1 class="pslh-title">Leasing</h1><div class="pslh-sub">The work closest to a lease, separated by decisions the company can make and commitments people still need to keep.</div></div><div class="pslh-pulse" aria-label="Leasing workload"><div class="pslh-pulse-cell"><strong>'+esc(c.actionable==null?0:c.actionable)+'</strong><span>Actionable</span></div><div class="pslh-pulse-cell overdue"><strong>'+esc(c.overdue==null?0:c.overdue)+'</strong><span>Overdue</span></div><div class="pslh-pulse-cell today"><strong>'+esc(c.due_today==null?0:c.due_today)+'</strong><span>Due today</span></div><div class="pslh-pulse-cell unassigned"><strong>'+esc(c.unassigned==null?0:c.unassigned)+'</strong><span>Unassigned</span></div></div></header>';
    }

    function render(){
      if(!root) return;
      if(!hasSession()){ root.innerHTML='<div class="pslh"><div class="pslh-empty">Leasing is available after staff sign-in.</div></div>'; return; }
      var psState=state.error?'unavailable':state.loading&&!state.desk?'loading':state.desk?'data':'empty';
      var h='<div class="pslh" data-ps-source="live" data-ps-state="'+psState+'">';
      if(state.error){ h+='<div class="pslh-error">Leasing is unavailable right now: '+esc(state.error)+' <button class="pslh-btn small" data-act="retry">Retry</button></div></div>'; root.innerHTML=h; bind(); return; }
      if(!state.desk){ h+='<div class="pslh-loading">Loading Leasing…</div></div>'; root.innerHTML=h; bind(); return; }
      h+=headerHTML();
      if(state.flash) h+='<div class="pslh-flash">'+esc(state.flash)+'</div>';
      if(state.errorFlash) h+='<div class="pslh-flash err">'+esc(state.errorFlash)+'</div>';
      h+=activeBandHTML()+closedHTML()+'</div>';
      root.innerHTML=h; if(state.panel) root.appendChild(panelHTML()); bind();
    }

    function panelHTML(){
      var p=state.panel,row=p.row,title='',body='',confirm='Save';
      if(p.kind==='complete'){
        title='Complete follow-up'; confirm='Complete';
        body='<p class="pslh-p">Mark <b>'+esc(row.state_label||row.label||'this follow-up')+'</b> for '+esc(row.person_name||'this person')+' as done.</p><label class="pslh-label">Coverage basis, when applicable</label><select id="pslhBasis" class="pslh-input"><option value="">I own this work</option><option value="coverage">Covering for the owner</option><option value="manager_intervention">Manager stepped in</option><option value="completed_together">Done together</option><option value="unassigned_pickup">Picked up while unassigned</option><option value="no_longer_needed">No longer needed</option></select><label class="pslh-label">Proof or note</label><textarea id="pslhProof" class="pslh-input" placeholder="What happened."></textarea>';
      }else if(p.kind==='reassign'){
        title='Reassign follow-up'; confirm='Reassign'; var staff=state.staff||[];
        body='<p class="pslh-p">Only this obligation moves. Conversation ownership stays unchanged.</p><label class="pslh-label">Assign to</label><select id="pslhTo" class="pslh-input"><option value="">Choose a person</option>'+staff.map(function(s){return '<option value="'+esc(s.user_id||s.id)+'">'+esc(s.name||s.display_name||s.user_id||s.id)+'</option>';}).join('')+'</select><label class="pslh-label">Reason</label><textarea id="pslhReason" class="pslh-input" placeholder="Why this handoff makes sense."></textarea>';
      }else if(p.kind==='changeDue'){
        title='Change follow-up time'; confirm='Change time';
        body='<label class="pslh-label">New due time</label><input id="pslhDue" class="pslh-input" type="datetime-local" value="'+esc(toLocalInputValue(row.due_at))+'"><label class="pslh-label">Reason</label><textarea id="pslhReason" class="pslh-input" placeholder="Why the commitment changed."></textarea>';
      }else if(p.kind==='reopen'){
        title='Reopen follow-up'; confirm='Reopen';
        body='<p class="pslh-p">The prior close remains in history. Reopening creates active work again.</p><label class="pslh-label">New due time</label><input id="pslhDue" class="pslh-input" type="datetime-local" value="'+esc(toLocalInputValue(null))+'"><label class="pslh-label">Reason</label><textarea id="pslhReason" class="pslh-input" placeholder="Why this work needs to return."></textarea>';
      }else if(p.kind==='sendapp'){
        title='Choose a unit'; confirm='';
        body='<p class="pslh-p">The server will verify the unit again before sending.</p>'+(p.busy?'<div class="pslh-loading">Loading leaseable units…</div>':'<div class="pslh-unit-list">'+((p.units||[]).map(function(u){return '<button class="pslh-unit-btn" data-act="pickunit" data-unit="'+esc(u.unit_id||u.id)+'"><b>'+esc(u.unit_number||u.label||'Unit')+'</b><span>'+esc(u.readiness||u.status||'')+'</span></button>';}).join('')||'<div class="pslh-empty">No leaseable unit is available.</div>')+'</div>');
      }
      var err=p.error?'<div class="pslh-error">'+esc(p.error)+'</div>':'';
      var foot='<div class="pslh-sheet-actions"><button class="pslh-btn" data-act="cancel">Cancel</button>'+(confirm?'<button class="pslh-btn primary" data-act="confirm"'+(p.busy?' disabled':'')+'>'+confirm+'</button>':'')+'</div>';
      return element('<div class="pslh-scrim" data-act="scrim"><div class="pslh-sheet" role="dialog" aria-modal="true"><div class="pslh-sheet-title">'+title+'</div>'+body+err+foot+'</div></div>');
    }
    function element(html){ var d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstChild; }

    function confirmPanel(){
      var p=state.panel;if(!p)return;var row=p.row,oid=row.obligation_id;
      if(p.kind==='complete'){
        var basis=(root.querySelector('#pslhBasis')||{}).value||null,proof=(root.querySelector('#pslhProof')||{}).value||null;
        submit(function(){return write('resolveTask',{obligationId:oid,result:'completed',proof:proof,resolution_basis:basis});});
      }else if(p.kind==='reassign'){
        var to=(root.querySelector('#pslhTo')||{}).value||null,reason=(root.querySelector('#pslhReason')||{}).value||null;
        if(!to){p.error='Choose who owns the work.';render();return;}
        submit(function(){return write('reassignTask',{obligationId:oid,to_user_id:to,reason:reason,idempotency_key:uid()});});
      }else if(p.kind==='changeDue'){
        var due=localInputToISO((root.querySelector('#pslhDue')||{}).value),reason2=(root.querySelector('#pslhReason')||{}).value||null;
        if(!due){p.error='Choose a new due time.';render();return;}
        submit(function(){return write('changeDueTask',{obligationId:oid,new_due_at:due,reason:reason2,idempotency_key:uid()});});
      }else if(p.kind==='reopen'){
        var due2=localInputToISO((root.querySelector('#pslhDue')||{}).value),reason3=(root.querySelector('#pslhReason')||{}).value||null;
        if(!due2){p.error='A reopened task needs a new due time.';render();return;}
        submit(function(){return write('reopenTask',{obligationId:oid,new_due_at:due2,reason:reason3,idempotency_key:uid()});});
      }
    }

    function bind(){
      if(!root)return;
      root.querySelectorAll('[data-act]').forEach(function(node){
        if(node.closest&&node.closest('.pslh-scrim'))return;
        node.onclick=function(ev){
          ev.preventDefault();var act=node.getAttribute('data-act'),key=node.getAttribute('data-key'),row=findRow(key);
          if(act==='retry'){refresh();return;}if(!row)return;
          if(act==='primary'){runPrimary(row);return;}if(act==='complete'||act==='reassign'||act==='changeDue'||act==='reopen'){openPanel(act,key);return;}if(act==='message'){openCard(row);return;}
        };
      });
      var scrim=root.querySelector('.pslh-scrim');if(!scrim)return;
      scrim.querySelectorAll('[data-act]').forEach(function(node){node.onclick=function(ev){ev.preventDefault();var act=node.getAttribute('data-act');if(act==='cancel'||(act==='scrim'&&ev.target===scrim)){closePanel();return;}if(act==='confirm'){confirmPanel();return;}if(act==='pickunit'&&state.panel){sendNow(state.panel.row,node.getAttribute('data-unit'));}};});
    }

    function alignLegacyShell(){
      var old=document.getElementById('leasingHeader');
      if(old){ old.hidden=true; old.setAttribute('data-ps-replaced-by','canonical-leasing-home'); }
    }
    function mount(node){ root=node||root||document.getElementById('psFollowupsEntry'); alignLegacyShell(); render(); refresh(); }
    function tileStatus(){ var c=(state.desk&&state.desk.counts)||{};return {enabled:hasSession(),connected:!!state.desk,open:Number(c.actionable||0),overdue:Number(c.overdue||0),unassigned:0}; }
    function onReturn(){ if(!state.awaitingReviewReturn)return;state.awaitingReviewReturn=false;refresh(); }
    if(typeof window!=='undefined'){
      window.addEventListener('ps:leasing-return',onReturn);
      document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')onReturn();});
    }
    return {mount:mount,refresh:refresh,tileStatus:tileStatus,_state:function(){return state;},_validateDesk:validateDesk};
  }

  var controller=null;
  function get(){if(!controller)controller=makeController();return controller;}
  function entryHTML(){return '<div id="psFollowupsEntry" data-ps-leasing-home="1"></div>';}
  function mount(node){var n=node||document.getElementById('psFollowupsEntry');if(n)get().mount(n);}
  function refresh(){if(controller)return controller.refresh();}
  function tileStatus(){try{return get().tileStatus();}catch(_){return {enabled:false,connected:false,open:0,overdue:0,unassigned:0};}}
  function reset(){controller=null;}

  if(typeof window!=='undefined'){
    var surface=Object.freeze({mount:mount,entryHTML:entryHTML,tileStatus:tileStatus,refresh:refresh,reset:reset});
    try{Object.defineProperty(window,'__psFollowups',{value:surface,writable:false,configurable:false,enumerable:true});}
    catch(_){window.__psFollowups=surface;}
  }
  if(typeof module!=='undefined'&&module.exports){module.exports={makeController:makeController,validateDesk:validateDesk,_helpers:{esc:esc,fmtDue:fmtDue,relClosed:relClosed,closedReceipt:closedReceipt}};}
})();
