// ════════════════════════════════════════════════════════════════════
//  FOLLOWUP RUNNER — turns a ladder decision into a real, sent message.
//
//  Deps: { pool, commBoundary, tours }. The ladder decides; this sends.
//
//  ── SAFETY POSTURE ───────────────────────────────────────────────────
//  dryRun defaults TRUE. Sending requires passing dryRun:false explicitly.
//  Every send additionally passes through commBoundary, which owns consent,
//  scope, send mode, and quiet hours. This module never touches sms directly.
//
//  ── NO NEW TABLE ─────────────────────────────────────────────────────
//  "How many rungs has this lead had?" is DERIVED, not stored: it is the
//  count of outbound messages since their last inbound, minus one for the
//  reply that started the silence. Never replied at all → one outbound
//  (the opener) → zero rungs. Capture once, read everywhere (§7).
//
//  ── WHY THE COPY IS DETERMINISTIC ────────────────────────────────────
//  A follow-up fires with nobody watching, so a model call here is an
//  unsupervised generation aimed at a real phone. The first slice writes
//  the copy from real facts instead: no invented rent, no invented tour,
//  no invented concession. It is plainer than the agent's live voice, and
//  that is the trade for now. composeRung() is the seam to swap in a
//  model-drafted body once there is a human-review step in front of it.
// ════════════════════════════════════════════════════════════════════

const { nextFollowup } = require("./followup_ladder");

module.exports = function followupRunner(deps) {
  const { pool, commBoundary } = deps;
  if (!pool) throw new Error("followup_runner requires { pool }");

  const leasingKnowledge = require("./leasing_knowledge");

  const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";

  // One short message per rung. No markdown, no dashes, no invented facts.
  function composeRung(rung, { name, virtualTourText }) {
    const who = firstName(name);
    switch (rung) {
      case 1:
        return `Hey ${who}, just circling back on your question about the apartment. Still happy to help if you're weighing options.`;
      case 2: {
        if (virtualTourText) return `Hey ${who}, here are the property's recorded virtual tours. These may show representative layouts:\n${virtualTourText}`;
        return `Hey ${who}, would you like help arranging a tour?`;
      }
      // RUNG 3 CARRIES NO ECONOMICS (owner decision, 2026-07-27). This rung
      // used to state a dated financial promise as a string literal: "a month
      // free right now on a one year lease ending July 2027". That was wrong
      // three ways. It is an unattended send, so nobody reviews the claim
      // before it reaches a real phone. It lived in DEPLOYED SOURCE rather
      // than data, so changing or withdrawing the offer required a release,
      // and retiring the governed fact would not have reached it. And it
      // hardcoded an expiry it cannot enforce — the day the special ends, the
      // runner keeps promising it. No unattended message makes a dated
      // financial promise from code. When there is one approved pricing
      // source per property, a concession reaches a prospect from THAT, dated
      // and withdrawable, or it does not reach them at all.
      // NOT null: a null body is skipped as "no_body_for_rung", and rungsSent
      // is derived from the outbound count — so a permanently-skipped rung is
      // never consumed and the ladder would stall here forever, and rungs 4-6
      // would never fire for anyone.
      case 3:
        return `Hey ${who}, if budget is the question, tell me the number you're working with and I'll tell you straight whether we have something that fits.`;
      case 4:
        return `Hey ${who}, want me to just hold a tour time for you? Takes two minutes and you're not committed to anything.`;
      case 5:
        return `Hey ${who}, checking in before things move. Happy to tell you what's actually still open if you're still looking.`;
      case 6:
        return `Hey ${who}, I'll assume you went a different direction unless I hear back. If anything changes, I'm here.`;
      default:
        return null;
    }
  }

  // Everything the ladder needs, derived in one read.
  async function loadCandidates(client, propertyId) {
    const { rows } = await client.query(`
      select l.id lead_id, l.status, l.tour_scheduled_at,
             p.id person_id, p.name,
             coalesce(p.primary_phone_e164, p.phone) phone,
             (select cp.consent_state from contact_preferences cp
               where cp.person_id = p.id and cp.channel = 'text') consent,
             (select max(occurred_at) from comm_events e
               where e.person_id = p.id and e.direction = 'outbound') last_out,
             (select max(occurred_at) from comm_events e
               where e.person_id = p.id and e.direction = 'inbound') last_in,
             (select count(*) from comm_events e
               where e.person_id = p.id and e.direction = 'outbound'
                 and e.occurred_at > coalesce(
                       (select max(occurred_at) from comm_events i
                         where i.person_id = p.id and i.direction = 'inbound'),
                       '-infinity'::timestamptz))::int outbound_since_inbound
        from leasing_leads l
        join persons p on p.id = l.person_id
       where l.property_id = $1`, [propertyId]);
    return rows;
  }

  function decideFor(row, now) {
    const stopped =
      row.consent === "opted_out" ? "opted_out" :
      row.status === "lost" ? "said_no" :
      row.status === "leased" ? "leased_elsewhere" :
      row.status === "human_takeover" ? "human_owns" : null;

    // Minus one: the first outbound after their last inbound is the REPLY,
    // not a ladder rung.
    const rungsSent = Math.max(0, (row.outbound_since_inbound || 0) - 1);

    return nextFollowup({
      lastOutboundAt: row.last_out ? new Date(row.last_out).getTime() : null,
      lastInboundAt: row.last_in ? new Date(row.last_in).getTime() : null,
      rungsSent,
      stopped,
      tourBooked: !!row.tour_scheduled_at,
      askedAboutLayout: row.layout || null,
    }, now);
  }

  // The whole job. Returns a receipt: what was sent, what was skipped, why.
  async function runFollowups({ propertyId, now = Date.now(), dryRun = true, limit = 25 } = {}) {
    if (!propertyId) throw new Error("runFollowups requires propertyId");
    const results = { dryRun, examined: 0, sent: [], skipped: [], failed: [] };

    const rows = await loadCandidates(pool, propertyId);
    results.examined = rows.length;

    for (const row of rows) {
      if (results.sent.length >= limit) break;
      const d = decideFor(row, now);
      if (!d.send) { results.skipped.push({ name: row.name, reason: d.reason }); continue; }

      // Quiet hours, asked BEFORE composing so a closed window costs nothing.
      const win = commBoundary && commBoundary.withinSendWindow
        ? await commBoundary.withinSendWindow(propertyId, "followup", new Date(now))
        : { allowed: false, reason: "no_boundary" };
      if (!win.allowed) { results.skipped.push({ name: row.name, reason: win.reason }); continue; }

      let virtualTourText = null;
      if (d.rung === 2) {
        try {
          const facts = await leasingKnowledge.readActive(pool, propertyId);
          const tour = facts.find(f => f.fact_key === "virtual_tours");
          virtualTourText = tour && tour.rendered_text;
        } catch (_) {
          results.failed.push({name:row.name, rung:d.rung, reason:"leasing_knowledge_unavailable"});
          continue;
        }
      }
      const body = composeRung(d.rung, { name: row.name, virtualTourText });
      if (!body) { results.skipped.push({ name: row.name, reason: "no_body_for_rung" }); continue; }

      if (dryRun) { results.sent.push({ name: row.name, rung: d.rung, job: d.job, body, dryRun: true }); continue; }

      // SAVE FIRST: the message is real whether or not the wire cooperates.
      let eventId = null;
      try {
        const ins = await pool.query(
          `insert into comm_events (property_id, person_id, channel, direction, body, occurred_at, sender_role)
           values ($1,$2,'sms','outbound',$3, now(), 'ai') returning id`,
          [propertyId, row.person_id, body]);
        eventId = ins.rows[0].id;
        const out = await commBoundary.sendPropertySms({
          property_id: propertyId, recipient: row.phone, body,
          purpose: "followup", person_id: row.person_id, eventId,
        });
        if (out.sent) results.sent.push({ name: row.name, rung: d.rung, job: d.job, sid: out.sid });
        else results.failed.push({ name: row.name, rung: d.rung, reason: out.reason });
      } catch (e) {
        results.failed.push({ name: row.name, rung: d.rung, reason: e.message, eventId });
      }
    }
    return results;
  }

  return { runFollowups, composeRung, decideFor };
};
