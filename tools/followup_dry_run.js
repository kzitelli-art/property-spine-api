// followup_dry_run.js — WHO would the ladder text, and when. READ ONLY.
//
//   node tools/followup_dry_run.js
//
// Sends nothing. Opens no send path. It reads real leads, computes real
// ladder decisions, and prints them so a human can look at the list BEFORE
// anything is switched on. Phone numbers are masked.
//
// Class 3. Removal condition: delete when the live runner has its own
// operator-facing preview surface.

const fs = require("fs");
const path = require("path");
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { Pool } = require("pg");
const { nextFollowup } = require(path.join(__dirname, "..", "src", "leasing", "followup_ladder.js"));
const commsBoundary = require(path.join(__dirname, "..", "src", "comms", "communications_boundary.js"))({
  pool: { query: async () => ({ rows: [] }) }, sms: null,
});

const PROPERTY = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const mask = (p) => (p ? String(p).replace(/^(\+?\d{0,3})(\d+)(\d{4})$/, (_, a, b, c) => `${a}${"*".repeat(b.length)}${c}`) : "(none)");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const { rows } = await pool.query(`
      select l.id lead_id, l.status, l.tour_scheduled_at,
             p.id person_id, p.name, coalesce(p.primary_phone_e164, p.phone) phone,
             (select cp.consent_state from contact_preferences cp
               where cp.person_id = p.id and cp.channel = 'text') consent,
             (select max(occurred_at) from comm_events e
                where e.person_id = p.id and e.direction = 'outbound') last_out,
             (select max(occurred_at) from comm_events e
                where e.person_id = p.id and e.direction = 'inbound') last_in
        from leasing_leads l
        join persons p on p.id = l.person_id
       where l.property_id = $1
       order by l.updated_at desc nulls last`, [PROPERTY]);

    const now = Date.now();
    const due = [], held = [];

    for (const r of rows) {
      // Consent FIRST. The send gate blocks opted_out downstream, but the
      // ladder must not select a person it may never contact: safety that
      // depends on a gate two layers away is not safety.
      const stopped = r.consent === "opted_out" ? "opted_out"
                    : r.status === "lost" ? "said_no"
                    : r.status === "leased" ? "leased_elsewhere"
                    : r.status === "human_takeover" ? "human_owns" : null;

      // rungsSent is 0 here: no ladder has ever run, so nobody has received one.
      const d = nextFollowup({
        lastOutboundAt: r.last_out ? new Date(r.last_out).getTime() : null,
        lastInboundAt: r.last_in ? new Date(r.last_in).getTime() : null,
        rungsSent: 0,
        stopped,
        tourBooked: !!r.tour_scheduled_at,
      }, now);

      const line = {
        name: r.name || "(no name)", phone: mask(r.phone), status: r.status,
        last_contact: r.last_out ? new Date(r.last_out).toISOString().slice(0, 10) : "never",
        decision: d.send ? `SEND rung ${d.rung} (${d.job})` : `hold — ${d.reason}`,
      };
      (d.send ? due : held).push(line);
    }

    console.log(`\n=== LEADS EXAMINED: ${rows.length} on Demo Building ===\n`);
    console.log(`WOULD TEXT NOW: ${due.length}`);
    if (due.length) console.table(due);
    console.log(`\nHELD: ${held.length}`);
    console.table(held);

    // AWAITED as of Slice 9 — withinSendWindow reads the governed property
    // timezone, so it is async. Un-awaited it printed "CLOSED (undefined)".
    const w = await commsBoundary.withinSendWindow(PROPERTY, "followup", new Date());
    console.log(`\nSend window right now: ${w.allowed ? "OPEN" : "CLOSED"} (${w.reason})`);
    console.log("NOTHING WAS SENT. This script has no send path.\n");
  } catch (e) {
    console.error("DRY RUN ERROR:", e.message);
    process.exitCode = 1;
  } finally { await pool.end(); }
})();
