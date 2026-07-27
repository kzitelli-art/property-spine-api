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

  // Layout → the tour we actually have. Verified links only; a layout that
  // is absent (the two-bedroom) must fall through to null, never substitute.
  const TOURS = {
    studio: "https://my.matterport.com/show/?m=H5qs9j6vYc5",
    one_bedroom: "https://my.matterport.com/show/?m=CbvpwiPGRah",
    one_bedroom_furnished: "https://my.matterport.com/show/?m=CVU7qPMehm9",
    one_bedroom_den: "https://my.matterport.com/show/?m=QmzDAeTLUmK",
    three_bedroom: "https://my.matterport.com/show/?m=tBSRwYtiTMU",
    // two_bedroom: intentionally absent. No tour exists. Do not substitute.
  };

  const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";

  // One short message per rung. No markdown, no dashes, no invented facts.
  function composeRung(rung, { name, layout }) {
    const who = firstName(name);
    switch (rung) {
      case 1:
        return `Hey ${who}, just circling back on your question about the apartment. Still happy to help if you're weighing options.`;
      case 2: {
        const url = layout ? TOURS[layout] : null;
        if (url) {
          return `Hey ${who}, here's a 3D walkthrough of that layout so you can look around without coming in: ${url}`;
        }
        // No tour for their layout. Offer the live option rather than the
        // wrong apartment.
        return `Hey ${who}, if it's easier than coming in, we do live video tours over FaceTime or WhatsApp, weekdays 9 to 4:30. Want me to set one up?`;
      }
      case 3:
        return `Hey ${who}, one thing worth knowing: there's a month free right now on a one year lease ending July 2027, which brings the monthly down a fair bit.`;
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
        ? commBoundary.withinSendWindow(propertyId, "followup", new Date(now))
        : { allowed: false, reason: "no_boundary" };
      if (!win.allowed) { results.skipped.push({ name: row.name, reason: win.reason }); continue; }

      const body = composeRung(d.rung, { name: row.name, layout: d.layout });
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

  return { runFollowups, composeRung, decideFor, TOURS };
};
