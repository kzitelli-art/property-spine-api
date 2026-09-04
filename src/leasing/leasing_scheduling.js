// ════════════════════════════════════════════════════════════════════
//  SCHEDULING INTAKE — leasing_scheduling.js
//
//  Acuity/Squarespace tours enter Property Spine as canonical source events,
//  never hand-re-entered. Outlook is the current ingestion ADAPTER; a future
//  direct Acuity API/webhook feeds the SAME ingestSourceEvent() with no
//  redesign. Raw events (append-only) project into canonical scheduled_tours.
//
//  THE BOUNDARY: this creates/updates scheduled_tours ONLY. It never creates a
//  conversion case, conversation owner, or post-tour obligation — only
//  completed-tour feedback with a confirmed actual host does that (047).
//
//  PRECEDENCE: an individual notice outranks a weekly agenda digest. A digest
//  may backfill a missing tour but may not overwrite a more specific notice.
//  IDEMPOTENCY: the same source event never processes twice (by appt id, else
//  a stable fingerprint).
//
//  Deps: { pool }. Operator-gated. Parser specifics (which sender/template) are
//  NOT here — callers pass already-parsed fields; mapping resolves the property
//  from scheduling_source_mappings (configurable, no hard-coded names).
// ════════════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");

module.exports = function leasingSchedulingModule({ pool }) {
  const router = express.Router();

  function requireOperator(req, res, next) {
    const expected = process.env.OPERATOR_KEY;
    if (!expected) return res.status(503).json({ receipt: "Operator routes are locked: set OPERATOR_KEY." });
    if (req.headers["x-operator-key"] !== expected) return res.status(401).json({ receipt: "Operator key missing or wrong." });
    next();
  }

  function normalizePhone(raw) {
    if (!raw) return null;
    const d = String(raw).replace(/\D/g, "");
    if (d.length === 10) return "+1" + d;
    if (d.length === 11 && d[0] === "1") return "+" + d;
    if (String(raw).startsWith("+")) return String(raw).trim();
    return null;
  }
  function normalizeEmail(raw) { const e = raw && String(raw).trim().toLowerCase(); return e && e.includes("@") ? e : null; }

  // Stable fingerprint when no external appointment id is available.
  function fingerprint({ property_id, prospect_name, prospect_email, prospect_phone, scheduled_start, appointment_type }) {
    const basis = [
      property_id || "",
      (prospect_email || normalizePhone(prospect_phone) || prospect_name || "").toLowerCase().trim(),
      scheduled_start ? new Date(scheduled_start).toISOString() : "",
      (appointment_type || "").toLowerCase().trim(),
    ].join("|");
    return "fp_" + crypto.createHash("sha256").update(basis).digest("hex").slice(0, 24);
  }

  // ── Resolve which property an inbound notice belongs to (configurable map). ──
  // Caller may pass property_id directly (already resolved upstream) OR pass
  // match hints (calendar_label / sender / appointment_name) we resolve here.
  async function resolveProperty(client, { property_id, calendar_label, sender, appointment_name, recipient_mailbox }) {
    if (property_id) return property_id;
    const r = await client.query(
      `select property_id, default_host_user_id from scheduling_source_mappings
        where active
          and ( (calendar_label is not null and calendar_label = $1)
             or (recipient_mailbox is not null and recipient_mailbox = $4)
             or (appointment_name is not null and appointment_name = $3)
             or (sender_pattern is not null and $2 ilike '%'||sender_pattern||'%') )
        order by
          -- most specific signal first; a broad sender pattern is the WEAKEST match.
          -- coalesce makes a non-match FALSE (not NULL) so true matches sort first.
          coalesce(calendar_label = $1, false) desc,
          coalesce(recipient_mailbox = $4, false) desc,
          coalesce(appointment_name = $3, false) desc
        limit 1`,
      [calendar_label || null, sender || "", appointment_name || null, recipient_mailbox || null]
    );
    return r.rows[0] ? r.rows[0].property_id : null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  CORE — ingest ONE source ENVELOPE (an individual notice OR a digest that
  //  carries MANY appointments). Idempotent at the envelope level. Each parsed
  //  occurrence projects into one canonical scheduled_tour via a link row, so a
  //  weekly digest references many tours without duplicating the raw email.
  //
  //  evt shape:
  //   { source_system, ingestion_channel, source_event_id, event_type,
  //     sender, recipient_mailbox, raw_payload, source_received_at,
  //     occurrences: [ { external_appt_id, property_id|match-hints, prospect_*,
  //                       appointment_type, scheduled_start/end, scheduled_host_user_id,
  //                       source_status } , ... ] }
  //   For an individual notice, pass a single-element occurrences array (or the
  //   flat per-appointment fields at the top level — normalized below).
  //
  //  Returns { duplicate, source_event, results:[ {occurrence, scheduled_tour, action} ] }.
  // ════════════════════════════════════════════════════════════════════
  async function ingestSourceEvent(client, evt) {
    const {
      source_system = "acuity_squarespace",
      ingestion_channel = "outlook_email",
      source_event_id = null,
      event_type,                       // created|rescheduled|cancelled|agenda_digest
      sender = null, recipient_mailbox = null,
      raw_payload = null, source_received_at = null,
    } = evt;
    if (!event_type) throw httpErr(400, "event_type is required (created|rescheduled|cancelled|agenda_digest).");

    const specificity = (event_type === "agenda_digest") ? "digest" : "individual";

    // Normalize to an occurrences array. An individual notice may arrive as flat
    // top-level fields; wrap it as a one-element array.
    let occurrences = Array.isArray(evt.occurrences) ? evt.occurrences.slice() : null;
    if (!occurrences) {
      occurrences = [{
        external_appt_id: evt.external_appt_id || null,
        property_id: evt.property_id || null,
        calendar_label: evt.calendar_label || null, sender: evt.sender || sender,
        appointment_name: evt.appointment_name || null, recipient_mailbox: evt.recipient_mailbox || recipient_mailbox,
        prospect_name: evt.prospect_name || null, prospect_phone: evt.prospect_phone || null, prospect_email: evt.prospect_email || null,
        appointment_type: evt.appointment_type || null,
        scheduled_start: evt.scheduled_start || null, scheduled_end: evt.scheduled_end || null,
        scheduled_host_user_id: evt.scheduled_host_user_id || null, source_status: evt.source_status || null,
      }];
    }

    // ── ENVELOPE IDEMPOTENCY: the same inbound notice never processes twice. ──
    // Prefer the provider's own envelope id; else fingerprint the envelope by its
    // event_type + the set of occurrence keys it carries.
    const occKeysPreview = occurrences.map(o => o.external_appt_id
      ? `appt:${o.external_appt_id}`
      : fingerprint({ property_id: o.property_id, prospect_name: o.prospect_name, prospect_email: o.prospect_email, prospect_phone: o.prospect_phone, scheduled_start: o.scheduled_start, appointment_type: o.appointment_type })
    ).sort();
    const envelopeIdem = source_event_id
      ? `evt:${source_event_id}`
      : `env:${event_type}:` + crypto.createHash("sha256").update(occKeysPreview.join(",")).digest("hex").slice(0, 24);

    const existingEnv = await client.query(
      `select * from scheduled_tour_sources where source_system=$1 and idempotency_key=$2`,
      [source_system, envelopeIdem]
    );
    if (existingEnv.rows.length > 0) {
      const src = existingEnv.rows[0];
      const links = (await client.query(`select * from scheduled_tour_source_links where source_id=$1`, [src.id])).rows;
      return { duplicate: true, source_event: src, results: links.map(l => ({ occurrence: l, scheduled_tour_id: l.scheduled_tour_id, action: "duplicate_ignored" })) };
    }

    // Resolve the envelope's property where one applies (a digest may resolve
    // per-occurrence instead). Detect unresolved/parse states for visibility.
    const envelopeProperty = await resolveProperty(client, {
      property_id: evt.property_id || null, calendar_label: evt.calendar_label || null,
      sender, appointment_name: evt.appointment_name || null, recipient_mailbox,
    });

    // Record the ENVELOPE (append-only evidence).
    const src = (await client.query(
      `insert into scheduled_tour_sources
         (source_system, ingestion_channel, source_event_id, event_type, idempotency_key,
          specificity, property_id, recipient_mailbox, sender, raw_payload, source_received_at,
          parse_status, unresolved_property, occurrence_count)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning *`,
      [source_system, ingestion_channel, source_event_id, event_type, envelopeIdem,
       specificity, envelopeProperty, recipient_mailbox, sender,
       raw_payload ? JSON.stringify(raw_payload) : null, source_received_at,
       "parsed", false, occurrences.length]
    )).rows[0];

    // Project EACH occurrence into a canonical tour via a link row.
    const results = [];
    let anyUnresolved = false;
    for (const occ of occurrences) {
      const r = await projectOccurrence(client, { src, event_type, specificity, occ, source_system, envelopeProperty });
      if (r.unresolved_property) anyUnresolved = true;
      results.push(r);
    }

    // Update envelope parse-state if any occurrence couldn't resolve a property.
    if (anyUnresolved) {
      await client.query(
        `update scheduled_tour_sources set unresolved_property=true, parse_status='partial' where id=$1`, [src.id]
      );
    }

    return { duplicate: false, source_event: src, results };
  }

  // ── Project ONE occurrence: resolve property, find-or-create the canonical
  //  tour under the precedence rule, write the source link + a revision row. ──
  async function projectOccurrence(client, { src, event_type, specificity, occ, source_system, envelopeProperty }) {
    const property_id = occ.property_id
      || envelopeProperty
      || await resolveProperty(client, { property_id: null, calendar_label: occ.calendar_label, sender: occ.sender, appointment_name: occ.appointment_name, recipient_mailbox: occ.recipient_mailbox });
    const unresolved_property = !property_id;

    const occKey = occ.external_appt_id
      ? `appt:${occ.external_appt_id}`
      : fingerprint({ property_id, prospect_name: occ.prospect_name, prospect_email: occ.prospect_email, prospect_phone: occ.prospect_phone, scheduled_start: occ.scheduled_start, appointment_type: occ.appointment_type });

    // Find the canonical tour: by appt id, else by fingerprint within property/prospect.
    let tour = null;
    if (occ.external_appt_id) {
      tour = (await client.query(`select * from scheduled_tours where source_system=$1 and external_appt_id=$2`, [source_system, occ.external_appt_id])).rows[0] || null;
    }
    if (!tour) {
      //  THE SAME APPOINTMENT, NOT THE SAME PERSON. This fallback matched any
      //  prior tour for the prospect, so their second booking was "affirmed"
      //  onto the first: the new appointment id was dropped and the second
      //  date never appeared. When both sides know a start time it must
      //  agree; a row with no start (a digest backfill) may still be claimed.
      const cand = await client.query(
        `select st.* from scheduled_tours st
          where st.source_system=$1
            and coalesce(st.property_id::text,'') = coalesce($2::text,'')
            and ( (st.prospect_email is not null and lower(st.prospect_email)=lower($3))
               or (st.prospect_phone is not null and st.prospect_phone=$4)
               or (st.prospect_name is not null and lower(st.prospect_name)=lower($5)) )
            and (st.scheduled_start is null or $6::timestamptz is null or st.scheduled_start = $6::timestamptz)
          order by st.created_at limit 1`,
        [source_system, property_id, normalizeEmail(occ.prospect_email), normalizePhone(occ.prospect_phone), occ.prospect_name, occ.scheduled_start || null]
      );
      tour = cand.rows[0] || null;
    }

    let action, prevStart = null, prevEnd = null, prevStatus = null;
    if (!tour) {
      tour = (await client.query(
        `insert into scheduled_tours
           (property_id, prospect_name, prospect_phone, prospect_email, external_appt_id,
            source_system, appointment_type, scheduled_start, scheduled_end, scheduled_host_user_id, status, authority)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [property_id, occ.prospect_name, normalizePhone(occ.prospect_phone), normalizeEmail(occ.prospect_email), occ.external_appt_id,
         source_system, occ.appointment_type, occ.scheduled_start, occ.scheduled_end, occ.scheduled_host_user_id,
         (event_type === "cancelled" ? "cancelled" : "scheduled"), specificity]
      )).rows[0];
      action = (specificity === "digest") ? "backfilled" : "created";
      await writeRevision(client, { tour_id: tour.id, source_link_id: null, change_type: "created",
        prev: {}, next: { scheduled_start: tour.scheduled_start, scheduled_end: tour.scheduled_end, status: tour.status } });
    } else {
      prevStart = tour.scheduled_start; prevEnd = tour.scheduled_end; prevStatus = tour.status;
      const digestLower = (specificity === "digest" && tour.authority === "individual");
      if (event_type === "cancelled") {
        if (digestLower) action = "ignored_digest_lower";
        else {
          await client.query(`update scheduled_tours set status='cancelled', updated_at=now() where id=$1`, [tour.id]);
          action = "cancelled";
        }
      } else if (event_type === "rescheduled") {
        if (digestLower) action = "ignored_digest_lower";
        else {
          await client.query(
            `update scheduled_tours
               set previous_start=scheduled_start, previous_end=scheduled_end,
                   scheduled_start=$2, scheduled_end=$3,
                   scheduled_host_user_id=coalesce($4, scheduled_host_user_id),
                   status='rescheduled', reschedule_count=reschedule_count+1, authority='individual', updated_at=now()
             where id=$1`,
            [tour.id, occ.scheduled_start, occ.scheduled_end, occ.scheduled_host_user_id]
          );
          action = "rescheduled";
        }
      } else {
        if (digestLower) action = "ignored_digest_lower";
        else {
          await client.query(
            `update scheduled_tours
               set scheduled_start = coalesce(scheduled_start, $2),
                   scheduled_end   = coalesce(scheduled_end, $3),
                   scheduled_host_user_id = coalesce(scheduled_host_user_id, $4),
                   appointment_type = coalesce(appointment_type, $5),
                   external_appt_id = coalesce(external_appt_id, $6),
                   authority = case when $7='individual' then 'individual' else authority end,
                   updated_at = now()
             where id=$1`,
            [tour.id, occ.scheduled_start, occ.scheduled_end, occ.scheduled_host_user_id, occ.appointment_type, occ.external_appt_id, specificity]
          );
          action = "affirmed";
        }
      }
      tour = (await client.query(`select * from scheduled_tours where id=$1`, [tour.id])).rows[0];
    }

    // Write the source→tour link (one per occurrence in this envelope).
    const link = (await client.query(
      `insert into scheduled_tour_source_links
         (source_id, scheduled_tour_id, external_appt_id, property_id, prospect_name, prospect_phone, prospect_email,
          appointment_type, scheduled_start, scheduled_end, scheduled_host_user_id, source_status, occurrence_key, action)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (source_id, occurrence_key) do update set scheduled_tour_id=excluded.scheduled_tour_id, action=excluded.action
       returning *`,
      [src.id, tour.id, occ.external_appt_id, property_id, occ.prospect_name, normalizePhone(occ.prospect_phone), normalizeEmail(occ.prospect_email),
       occ.appointment_type, occ.scheduled_start, occ.scheduled_end, occ.scheduled_host_user_id, occ.source_status, occKey, action]
    )).rows[0];

    // Revision row for reschedule/cancellation (created already wrote one above).
    if (action === "rescheduled" || action === "cancelled") {
      await writeRevision(client, { tour_id: tour.id, source_link_id: link.id, change_type: action,
        prev: { scheduled_start: prevStart, scheduled_end: prevEnd, status: prevStatus },
        next: { scheduled_start: tour.scheduled_start, scheduled_end: tour.scheduled_end, status: tour.status } });
    }

    return { occurrence: link, scheduled_tour: tour, action, unresolved_property };
  }

  async function writeRevision(client, { tour_id, source_link_id, change_type, prev, next }) {
    await client.query(
      `insert into scheduled_tour_revisions
         (scheduled_tour_id, source_link_id, change_type,
          prev_scheduled_start, prev_scheduled_end, prev_status,
          new_scheduled_start, new_scheduled_end, new_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tour_id, source_link_id, change_type,
       prev.scheduled_start || null, prev.scheduled_end || null, prev.status || null,
       next.scheduled_start || null, next.scheduled_end || null, next.status || null]
    );
  }

  // Upcoming tours for Leasing Health (read-only view).
  async function upcomingTours(client, { property_id = null, withinDays = 30 }) {
    const r = await client.query(
      `select * from scheduled_tours
        where status <> 'cancelled'
          and scheduled_start is not null
          and scheduled_start >= now() - interval '1 day'
          and scheduled_start <= now() + ($2 || ' days')::interval
          and ($1::uuid is null or property_id=$1)
        order by scheduled_start asc`,
      [property_id, String(withinDays)]
    );
    return r.rows;
  }

  // ── HTTP ──
  function httpErr(status, message) { const e = new Error(message); e.http = status; return e; }
  async function tx(fn, res) {
    const c = await pool.connect();
    try { await c.query("begin"); const out = await fn(c); await c.query("commit"); return res.json(out); }
    catch (e) { await c.query("rollback"); return res.status(e.http || 500).json({ receipt: e.message }); }
    finally { c.release(); }
  }

  // POST /scheduling/source-events — ingest one Acuity notice/reschedule/cancel/digest
  router.post("/scheduling/source-events", requireOperator, (req, res) => tx(async (client) => {
    const out = await ingestSourceEvent(client, req.body || {});
    return { receipt: out.duplicate
      ? "Duplicate source notice ignored (idempotent)."
      : `Processed ${out.results.length} appointment${out.results.length === 1 ? "" : "s"} from this notice.`, ...out };
  }, res));

  // GET /scheduling/upcoming-tours — Leasing Health feed
  router.get("/scheduling/upcoming-tours", requireOperator, async (req, res) => {
    const client = await pool.connect();
    try {
      const rows = await upcomingTours(client, { property_id: req.query.property_id || null, withinDays: Number(req.query.days) || 30 });
      return res.json({ upcoming: rows });
    } catch (e) { return res.status(500).json({ receipt: e.message }); }
    finally { client.release(); }
  });

  // POST /scheduling/source-mappings — configure a property's source mapping
  router.post("/scheduling/source-mappings", requireOperator, (req, res) => tx(async (client) => {
    const b = req.body || {};
    if (!b.property_id) throw httpErr(400, "property_id is required.");
    const row = (await client.query(
      `insert into scheduling_source_mappings
         (property_id, source_system, calendar_label, sender_pattern, appointment_name, template_shape, recipient_mailbox, default_host_user_id, active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,true)) returning *`,
      [b.property_id, b.source_system || "acuity_squarespace", b.calendar_label || null, b.sender_pattern || null,
       b.appointment_name || null, b.template_shape || null, b.recipient_mailbox || null, b.default_host_user_id || null, b.active]
    )).rows[0];
    return { receipt: "Source mapping saved.", mapping: row };
  }, res));

  router._service = { ingestSourceEvent, projectOccurrence, writeRevision, upcomingTours, resolveProperty, fingerprint };
  return router;
};
