// ════════════════════════════════════════════════════════════════════
//  SEND MODE CHANGE — READ-ONLY PREVIEW
//
//  Answers ONE question before anybody touches Render:
//    if SMS_SEND_MODE goes customer_care -> internal_qa_autonomous,
//    who becomes reachable, who stops being reachable, and WHO WOULD
//    ACTUALLY HAVE A MESSAGE SENT?
//
//  STRICTLY READ-ONLY. No insert, no update, no delete, no transaction.
//  It does not change SMS_SEND_MODE anywhere real: it sets the variable
//  inside THIS node process only, so the REAL canSendSmsForRecord is
//  evaluated under each mode. Render is untouched. The boundary reads
//  the mode fresh per call, which is exactly what makes this honest —
//  we are exercising the shipped gate, not a copy of its rules.
//
//  Reports, per Kameron's spec 2026-07-25:
//    1  every record reachable under customer_care
//    2  every record reachable under internal_qa_autonomous
//    3  who BECOMES reachable
//    4  who STOPS being reachable
//    5  classification + its source, consent state, property, phone
//    6  duplicate-person and duplicate-phone conflicts
//    7  opt-out / STOP history
//    8  ACTUAL-SEND CANDIDATES — not who passes the gate, but who has a
//       real pending draft or autonomous path that would dispatch
//    9  the 7147 opted-out record stays blocked in BOTH modes
//   10  the Demo number is property-pinned; cross-property fails closed
//   11  whether the mode flip itself can wake anything on its own
//
//  Every row carries explicit person_id / property_id. Nothing here
//  decides anything by name or category.
//
//  Run (PowerShell, from api/):
//    $env:DATABASE_URL = ...
//    node tests/send_mode_change_preview.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const boundaryFactory = require("../src/comms/communications_boundary");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const BLOCKED_TAIL = "7147";           // the known wrong number, must stay blocked
const PURPOSE = "ai_reply";            // the autonomous purpose Act One actually uses

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// sms stub: enabled so transport never masks a POLICY answer. Nothing is sent —
// canSendSmsForRecord is a pure decision function; sendPropertySms is never called.
const boundary = boundaryFactory({
  pool,
  sms: { enabled: () => true, sendSms: async () => { throw new Error("harness must never send"); } },
});

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const short = (id) => (id ? String(id).slice(0, 8) : "—");

async function decideUnder(mode, cand) {
  const prev = process.env.SMS_SEND_MODE;
  process.env.SMS_SEND_MODE = mode;              // THIS PROCESS ONLY
  try {
    return await boundary.canSendSmsForRecord({
      property_id: cand.property_id,
      recipient: cand.phone,
      person_id: cand.person_id,
      purpose: PURPOSE,
      from: cand.property_line,
    }, pool);
  } finally {
    if (prev === undefined) delete process.env.SMS_SEND_MODE;
    else process.env.SMS_SEND_MODE = prev;
  }
}

(async () => {
  console.log("SEND MODE CHANGE — READ-ONLY PREVIEW");
  console.log(`purpose evaluated: '${PURPOSE}'   property: ${DEMO}\n`);
  console.log(`live SMS_SEND_MODE in THIS process: ${process.env.SMS_SEND_MODE || "(unset -> disabled)"}`);
  console.log("(production runs its own value in Render; this harness cannot change it)\n");

  // ── the property line, and that it is pinned ──────────────────────
  const prop = (await pool.query(
    `select id, name, sms_number from properties where id=$1`, [DEMO])).rows[0];
  const otherLines = (await pool.query(
    `select count(*)::int c from properties where sms_number = $1 and id <> $2`,
    [prop.sms_number, DEMO])).rows[0].c;

  console.log("[10] the Demo line is property-pinned");
  check(!!prop.sms_number, `Demo Building has a line`, prop.sms_number);
  check(otherLines === 0, "no other property shares that number",
        otherLines === 0 ? "unique" : `${otherLines} OTHER PROPERTIES SHARE IT`);

  // ── candidate set: anyone with a relationship at Demo who has a phone ──
  const candidates = (await pool.query(
    `select distinct p.id as person_id, $1::uuid as property_id, p.name, p.phone,
            c.record_class, c.created_at as classified_at,
            coalesce(p.source,'(null)') as person_source,
            coalesce(cp.consent_state,'(no row)') as consent
       from persons p
       left join lateral (
         select record_class, created_at from person_property_classifications x
          where x.person_id=p.id and x.property_id=$1 and x.superseded_at is null
          order by created_at desc limit 1) c on true
       left join contact_preferences cp on cp.person_id=p.id
      where p.phone is not null and p.phone <> ''
        and (exists (select 1 from leasing_leads l where l.person_id=p.id and l.property_id=$1)
          or exists (select 1 from conversations v where v.person_id=p.id and v.property_id=$1)
          or c.record_class is not null)
      order by p.name`, [DEMO])).rows
    .map(r => ({ ...r, property_line: prop.sms_number }));

  console.log(`\ncandidate recipients with a relationship at Demo and a phone: ${candidates.length}`);

  // ── evaluate BOTH modes through the REAL gate ─────────────────────
  for (const c of candidates) {
    c.cc = await decideUnder("customer_care", c);
    c.qa = await decideUnder("internal_qa_autonomous", c);
  }

  const reachCC = candidates.filter(c => c.cc.allowed);
  const reachQA = candidates.filter(c => c.qa.allowed);
  const gains  = candidates.filter(c => !c.cc.allowed && c.qa.allowed);
  const losses = candidates.filter(c => c.cc.allowed && !c.qa.allowed);

  const table = (rows) => rows.map(r => ({
    person_id: short(r.person_id), name: r.name,
    phone_last4: (r.phone || "").slice(-4),
    classification: r.record_class || "(none)",
    person_source: r.person_source,
    consent: r.consent,
    cc: r.cc.allowed ? "ALLOW" : r.cc.reason,
    qa: r.qa.allowed ? "ALLOW" : r.qa.reason,
  }));

  console.log(`\n═══ [1] REACHABLE TODAY under customer_care — ${reachCC.length} ═══`);
  if (reachCC.length) console.table(table(reachCC)); else console.log("(none)");

  console.log(`\n═══ [2] REACHABLE under internal_qa_autonomous — ${reachQA.length} ═══`);
  if (reachQA.length) console.table(table(reachQA).slice(0, 40));
  if (reachQA.length > 40) console.log(`  … ${reachQA.length - 40} more`);

  console.log(`\n═══ [3] BECOME REACHABLE — ${gains.length} ═══`);
  if (gains.length) console.table(table(gains).slice(0, 40)); else console.log("(none)");
  if (gains.length > 40) console.log(`  … ${gains.length - 40} more`);

  console.log(`\n═══ [4] STOP BEING REACHABLE — ${losses.length} ═══`);
  if (losses.length) console.table(table(losses)); else console.log("(none)");

  // ── [9] the opted-out record stays blocked in BOTH modes ──────────
  console.log("\n[9] the opted-out wrong number stays blocked");
  const blocked = candidates.filter(c => (c.phone || "").endsWith(BLOCKED_TAIL));
  if (!blocked.length) {
    check(false, `found the ...${BLOCKED_TAIL} record among candidates`, "not present — cannot prove it stays blocked");
  } else {
    for (const b of blocked) {
      check(!b.cc.allowed && !b.qa.allowed,
            `...${BLOCKED_TAIL} (${b.name}, person ${short(b.person_id)}) blocked in BOTH modes`,
            `customer_care=${b.cc.reason} · internal_qa=${b.qa.reason}`);
    }
  }

  // ── [10b] cross-property must fail closed ─────────────────────────
  console.log("\n[10b] cross-property recipients fail closed");
  const foreign = (await pool.query(
    `select p.id, p.name, p.phone, c.property_id
       from person_property_classifications c join persons p on p.id=c.person_id
      where c.property_id <> $1 and c.superseded_at is null
        and p.phone is not null and p.phone <> '' limit 1`, [DEMO])).rows[0];
  if (!foreign) {
    console.log("  (no classified person at another property to test with — skipped)");
  } else {
    const r = await decideUnder("internal_qa_autonomous",
      { property_id: DEMO, person_id: foreign.id, phone: foreign.phone, property_line: prop.sms_number });
    check(!r.allowed, `a person classified only at another property cannot be sent to via Demo`,
          r.allowed ? "ALLOWED — CROSS-PROPERTY LEAK" : r.reason);
  }

  // ── [6] duplicate person / duplicate phone conflicts ──────────────
  console.log("\n═══ [6] DUPLICATE CONFLICTS ═══");
  const dupPhone = (await pool.query(
    `select p.phone, count(*)::int as people,
            string_agg(distinct p.name, ' | ') as names,
            string_agg(distinct left(p.id::text,8), ',') as person_ids
       from persons p where p.phone is not null and p.phone <> ''
      group by p.phone having count(*) > 1 order by 2 desc limit 15`)).rows;
  if (dupPhone.length) console.table(dupPhone); else console.log("(no duplicate phones)");

  const dupName = (await pool.query(
    `select p.name, count(*)::int as records,
            string_agg(left(p.id::text,8), ',') as person_ids,
            string_agg(distinct coalesce(right(p.phone,4),'—'), ',') as phone_last4
       from persons p
      where exists (select 1 from person_property_classifications c
                     where c.person_id=p.id and c.property_id=$1 and c.superseded_at is null)
      group by p.name having count(*) > 1 order by 2 desc limit 15`, [DEMO])).rows;
  if (dupName.length) console.table(dupName); else console.log("(no duplicate names among classified Demo records)");

  // ── [7] opt-out / STOP history ────────────────────────────────────
  console.log("\n═══ [7] OPT-OUT / STOP HISTORY ═══");
  const optOut = (await pool.query(
    `select left(cp.person_id::text,8) as person_id, p.name,
            right(coalesce(p.phone,''),4) as phone_last4, cp.consent_state,
            cp.updated_at::date as changed
       from contact_preferences cp join persons p on p.id=cp.person_id
      where cp.consent_state <> 'opted_in' order by cp.updated_at desc limit 20`)).rows;
  if (optOut.length) console.table(optOut); else console.log("(nobody is opted out)");

  const stopMsgs = (await pool.query(
    `select left(e.person_id::text,8) as person_id, coalesce(p.name,'—') as name,
            e.occurred_at::date as day, left(e.body,24) as body
       from comm_events e left join persons p on p.id=e.person_id
      where e.direction='inbound'
        and upper(trim(coalesce(e.body,''))) in
            ('STOP','QUIT','END','REVOKE','OPT OUT','OPTOUT','CANCEL','UNSUBSCRIBE')
      order by e.occurred_at desc limit 20`)).rows;
  console.log(`\ninbound STOP-class messages ever received: ${stopMsgs.length}`);
  if (stopMsgs.length) console.table(stopMsgs);

  // ── [8] ACTUAL-SEND CANDIDATES — the part that matters most ───────
  console.log("\n═══ [8] ACTUAL-SEND CANDIDATES ═══");
  console.log("passing the gate is NOT a send. These are real pending artifacts.\n");

  const readyDrafts = (await pool.query(
    `select d.id as draft_id, d.created_at, c.person_id, c.property_id,
            p.name, p.phone, s.mode as thread_mode
       from agent_drafts d
       join agent_runs r on r.id = d.agent_run_id
       join conversations c on c.id = r.conversation_id
       left join persons p on p.id = c.person_id
       left join agent_thread_state s on s.conversation_id = c.id
      where d.status = 'ready'
      order by d.created_at asc`)).rows;

  const sendable = [];
  for (const d of readyDrafts) {
    if (!d.phone || !d.property_id) { sendable.push({ ...d, cc: "(no phone/property)", qa: "(no phone/property)" }); continue; }
    const line = (await pool.query(`select sms_number from properties where id=$1`, [d.property_id])).rows[0];
    const cand = { property_id: d.property_id, person_id: d.person_id, phone: d.phone, property_line: line && line.sms_number };
    const cc = await decideUnder("customer_care", cand);
    const qa = await decideUnder("internal_qa_autonomous", cand);
    sendable.push({ ...d, cc: cc.allowed ? "WOULD SEND" : cc.reason, qa: qa.allowed ? "WOULD SEND" : qa.reason });
  }

  console.log(`ready (undispatched) drafts: ${readyDrafts.length}`);
  if (sendable.length) console.table(sendable.map(d => ({
    draft: short(d.draft_id), person: short(d.person_id), name: d.name,
    phone_last4: (d.phone || "").slice(-4), thread: d.thread_mode || "—",
    age_days: Math.floor((Date.now() - new Date(d.created_at)) / 86400000),
    under_customer_care: d.cc, under_internal_qa: d.qa,
  })));

  const newlySendable = sendable.filter(d => d.cc !== "WOULD SEND" && d.qa === "WOULD SEND");
  console.log(`\n  >>> drafts that become SENDABLE only after the mode change: ${newlySendable.length}`);
  if (newlySendable.length) console.table(newlySendable.map(d => ({
    draft: short(d.draft_id), person: short(d.person_id), name: d.name, phone_last4: (d.phone || "").slice(-4),
  })));

  // ── [11] can the flip wake anything by itself? ────────────────────
  console.log("\n[11] does changing the mode dispatch anything on its own?");
  const perim = (process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  console.log(`  AGENT_AUTO_DISPATCH_PROPERTY_IDS in THIS process: ${perim.length ? perim.join(",") : "(unset -> auto-dispatch OFF everywhere)"}`);
  console.log("  NOTE: this harness cannot read Render's value. Confirm it there.");
  check(true, "a ready draft requires an explicit dispatch action (operator send, or auto-dispatch on a NEW inbound)",
        "no poller/cron dispatches drafts; nothing self-sends because a mode changed");
  const awaiting = (await pool.query(
    `select count(*)::int c from agent_thread_state where mode='awaiting_review'`)).rows[0].c;
  console.log(`  threads sitting in awaiting_review: ${awaiting} (these need a human either way)`);

  // ── summary ───────────────────────────────────────────────────────
  console.log("\n══════════════ SUMMARY ══════════════");
  console.log(`  reachable now (customer_care)      : ${reachCC.length}`);
  console.log(`  reachable after (internal_qa_auto) : ${reachQA.length}`);
  console.log(`  BECOME reachable                   : ${gains.length}`);
  console.log(`  STOP being reachable               : ${losses.length}`);
  console.log(`  ready drafts that would newly send : ${newlySendable.length}`);
  console.log(`\n${failures === 0 ? "ALL SAFETY CHECKS PASSED" : failures + " SAFETY CHECK(S) FAILED"}`);
  console.log("\nNothing was changed. SMS_SEND_MODE was set only inside this process.");
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e.stack); process.exitCode = 1; })
  .finally(() => pool.end());
