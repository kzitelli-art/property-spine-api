// ════════════════════════════════════════════════════════════════════
//  AVAILABILITY PROJECTION — availability.js   (Availability Slice C)
//
//  A READ-ONLY, server-authored projection of forward supply. It answers,
//  per rentable SPACE: is this leaseable now, leaseable forward, turning,
//  committed to a future resident, or not supply at all — and when will it
//  honestly be ready, with what confidence.
//
//  IT WRITES NOTHING. No INSERT, no UPDATE, no table. There is no
//  `availability` table and there must never be one — availability is
//  DERIVED from units / spaces / leases / unit_events / turnovers /
//  lease_applications every time it is read. (Rule: no parallel inventory
//  system, no hand-maintained list.)
//
//  SERVER-AUTHORED, APP NEVER RE-DERIVES (the Tours PROJECTION_CTE
//  discipline): every classification below — availability_state,
//  date_confidence, commitment_tier, tourable_in_person, reason — is
//  computed HERE, once. The renderer displays the decision; it never
//  reproduces the precedence client-side.
//
//  THE TWO-AXIS RULE THIS READ MUST NEVER BREAK:
//  `units.occupancy_status` is the CONTRACTED rent-roll axis. This read
//  reports it verbatim and NEVER reinterprets it. A unit on notice is
//  STILL 'occupied' — notice makes it FUTURE SUPPLY without touching the
//  contracted truth (see notice.js). availability_state is a DIFFERENT
//  axis derived alongside it, never a replacement for it.
//
//  PER-SPACE CLASSIFICATION (by-bed honesty): the projection emits one
//  row per SPACE. For a by-bed unit (two beds, one leased, one open) the
//  two beds MUST classify independently — so the space-level lease reality
//  (an active|commercial lease on THAT space) drives classification, while
//  units.occupancy_status is still reported verbatim at the unit level.
//  A notice event applies to the specific space its server-resolved
//  tenancy snapshot names (payload.space_id), never to sibling beds.
//
//  DERIVATION ORDER (documented deviation from the build brief): the brief
//  listed ready_now before committed_future with first-match-wins, which
//  would make committed_future unreachable (every vacant, not-turning unit
//  matches ready_now first) — and would advertise an already-leased-forward
//  unit as open supply, a false signal. The order below preserves every
//  definition and fixes the reachability:
//
//    unavailable       is_down OR operating_use in ('model','offline')
//    vacant_turning    space vacant AND a turnover status='in_progress'
//    committed_future  space vacant AND a pending future lease on the space
//    ready_now         space vacant (turn done or never needed)
//    on_notice         space occupied AND open notice_given ('scheduled')
//                      naming this space
//    unavailable       (fallback) space occupied, no open notice
//
//  HONEST BLANK BEATS CONFIDENT WRONG: where the building does not know a
//  date (no ready_date on an open turn), projected_ready_date is null and
//  date_confidence is 'unknown'. This read never fabricates certainty.
//
//  COMMITMENT TIERS — what exists today, honestly:
//    'deposit_paid_hard'    NOT EMITTED. No deposit-paid fact exists; Money
//                           is money-OUT only (money.js, locked scope).
//    'executed_deposit_due' NOT EMITTED. Depends on the un-built
//                           lease_applications ↔ leases bridge (see
//                           BRIDGE_AUDIT.md).
//    'applicant_demand'     Emitted best-effort: an OPEN lease_application
//                           (status in submitted | tenant_signed |
//                           lease_ready — the known-open states at source)
//                           referencing this unit_id. Unknown statuses are
//                           conservatively treated as NOT open.
//    'none'                 The default, and the honest value for most
//                           units until the deposit/bridge slices land.
//
//  PRESENTATION MATERIALS: no unit-media table exists at source (verified
//  July 7 2026 — no photos/floor_plan/video/matterport source anywhere in
//  the repo). Every unit therefore emits all-false. This is honest-blank,
//  not a bug; see BRIDGE_AUDIT.md. Never infer media from state.
//
//  CLASSIFICATION (delete-or-keep): this module is a Class 1 permanent
//  product primitive (the forward-supply read). DEFAULT_TURN_WINDOW_DAYS
//  below is a Class 2 temporary adapter inside it — see its comment.
//
//  Mount in server.js (ONE line, next to the noticeModule mount):
//    app.use("/", require("./availability")({ pool }));
// ════════════════════════════════════════════════════════════════════

// ── POLICY PLACEHOLDER — Class 2 temporary adapter ───────────────────
// The "normal turn window" (days between a resident vacating and the unit
// being ready) is OPERATING POLICY, not projection math. No per-property
// turn-window column exists at source today (verified: `properties` has no
// such field in any live query). Until a property-configured
// `properties.turn_window_days` (or equivalent) exists, this ONE named
// constant is the placeholder. REPLACEMENT CONDITION: a durable
// per-property policy field lands; the projection reads it; this constant
// is deleted. Do not scatter turn-day numbers anywhere else.
const DEFAULT_TURN_WINDOW_DAYS = 5;

module.exports = function availability(deps) {
  const express = require("express");
  const router = express.Router();

  const { pool } = deps;
  if (!pool) throw new Error("availability module requires a pool");

  // date helpers — plain YYYY-MM-DD strings in, plain strings out.
  function ymd(d) {
    if (!d) return null;
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  }
  function addDays(dateStr, days) {
    const dt = new Date(dateStr + "T00:00:00Z");
    if (isNaN(dt.getTime())) return null;
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  // ════════════════════════════════════════════════════════════════
  //  THE READ  —  GET /availability?property_id=<uuid>
  //  One row per space, classified server-side. Read-only.
  // ════════════════════════════════════════════════════════════════
  router.get("/availability", async (req, res) => {
    const { property_id } = req.query;
    if (!property_id) {
      return res.status(400).json({ error: "property_id is required" });
    }

    try {
      // ── one query pulls every fact the classification needs ──────
      // per SPACE: the unit's contracted axes, the space's own lease
      // reality (current + future via lateral, mirroring
      // management_read.js), the open turnover on the unit, the open
      // notice event naming THIS space, and open applicant demand on
      // the unit. All reads; no state is created or touched.
      const rows = (await pool.query(
        `select
            u.id                as unit_id,
            u.unit_number,
            u.occupancy_status,
            u.is_down,
            u.operating_use,
            s.id                as space_id,
            s.space_label,
            cur.id              as cur_lease_id,
            fut.id              as fut_lease_id,
            fut.start_date      as fut_start_date,
            tv.id               as turnover_id,
            tv.status           as turnover_status,
            tv.ready_date       as turnover_ready_date,
            nt.id               as notice_event_id,
            nt.effective_date   as notice_move_out_date,
            ap.id               as open_application_id
          from units u
          join spaces s on s.unit_id = u.id
          left join lateral (
            select l.id from leases l
             where l.space_id = s.id and l.lease_status in ('active','commercial')
             order by l.start_date desc nulls last limit 1
          ) cur on true
          left join lateral (
            select l.id, l.start_date from leases l
             where l.space_id = s.id and l.lease_status = 'pending'
             order by l.start_date asc nulls last limit 1
          ) fut on true
          left join lateral (
            select t.id, t.status, t.ready_date from turnovers t
             where t.unit_id = u.id and t.status in ('in_progress','ready')
             order by t.created_at desc limit 1
          ) tv on true
          left join lateral (
            select ue.id, ue.effective_date from unit_events ue
             where ue.unit_id = u.id
               and ue.event_type = 'notice_given'
               and ue.status = 'scheduled'
               and (
                 (ue.payload ->> 'space_id') is null
                 or (ue.payload ->> 'space_id') = s.id::text
               )
             order by ue.effective_date asc limit 1
          ) nt on true
          left join lateral (
            select la.id from lease_applications la
             where la.unit_id = u.id
               and la.status in ('submitted','tenant_signed','lease_ready')
             order by la.created_at desc nulls last limit 1
          ) ap on true
          where u.property_id = $1
          order by u.unit_number asc, s.created_at asc`,
        [property_id])).rows;

      if (!rows.length) {
        return res.json({
          property_id,
          count: 0,
          spaces: [],
          note: "No units/spaces for this property. Availability is derived from live inventory — nothing exists to project yet.",
        });
      }

      const spaces = rows.map(r => classifySpace(r));

      // small server-authored rollup so the reader sees the shape at a
      // glance — counts only, derived from the same classification.
      const summary = {};
      for (const sp of spaces) summary[sp.availability_state] = (summary[sp.availability_state] || 0) + 1;

      res.json({
        property_id,
        count: spaces.length,
        turn_window_days: DEFAULT_TURN_WINDOW_DAYS,
        turn_window_source: "default_placeholder", // becomes 'property_config' when the policy field lands
        summary,
        note: "Forward supply, derived live. occupancy_status is the contracted rent-roll axis and is reported verbatim — a unit on notice is still occupied until move-out. Dates carry honest confidence; 'unknown' means the building does not know, not that it is fine.",
        spaces,
      });
    } catch (e) {
      console.error("availability read error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── the classifier — one place, every branch, server-authored ─────
  function classifySpace(r) {
    const spaceOccupied = !!r.cur_lease_id; // space-level lease reality (by-bed honesty)
    const use = (r.operating_use || "").toLowerCase();
    const notSupply = r.is_down === true || use === "model" || use === "offline";
    const turnOpen = r.turnover_status === "in_progress";
    const turnReady = r.turnover_status === "ready";
    const hasNotice = !!r.notice_event_id;
    const noticeDate = ymd(r.notice_move_out_date);
    const turnReadyDate = ymd(r.turnover_ready_date);
    const futStart = ymd(r.fut_start_date);

    let availability_state, projected_ready_date, date_confidence, reason;

    if (notSupply) {
      availability_state = "unavailable";
      projected_ready_date = null;
      date_confidence = "unknown";
      reason = r.is_down === true
        ? "Down — not revenue supply until restored."
        : `In ${use} use — not revenue supply.`;
    } else if (!spaceOccupied && turnOpen) {
      availability_state = "vacant_turning";
      if (turnReadyDate) {
        projected_ready_date = turnReadyDate;
        date_confidence = "planned";
        reason = `Turn in progress — planned ready ${turnReadyDate}.`;
      } else {
        projected_ready_date = null;
        date_confidence = "unknown";
        reason = "Turn in progress — no ready date set yet. The building does not know when this will be ready.";
      }
    } else if (!spaceOccupied && r.fut_lease_id) {
      availability_state = "committed_future";
      projected_ready_date = turnReady && turnReadyDate ? turnReadyDate : today();
      date_confidence = "proven";
      reason = futStart
        ? `Ready, and already leased for a future move-in starting ${futStart} — not open supply.`
        : "Ready, and already leased for a future move-in — not open supply.";
    } else if (!spaceOccupied) {
      availability_state = "ready_now";
      projected_ready_date = turnReady && turnReadyDate ? turnReadyDate : today();
      date_confidence = "proven";
      reason = "Vacant and ready to lease now.";
    } else if (hasNotice) {
      availability_state = "on_notice";
      if (noticeDate) {
        projected_ready_date = addDays(noticeDate, DEFAULT_TURN_WINDOW_DAYS);
        date_confidence = "assumed";
        reason = `Occupied — current resident vacates ${noticeDate}. Projected ready ~${projected_ready_date} under the normal turn window (assumed until move-out).`;
      } else {
        projected_ready_date = null;
        date_confidence = "unknown";
        reason = "Occupied — resident has given notice but no vacate date is recorded. The building cannot project a ready date.";
      }
    } else {
      availability_state = "unavailable";
      projected_ready_date = null;
      date_confidence = "unknown";
      reason = "Occupied — no notice given. Not supply.";
    }

    // commitment tier — only what exists cleanly today (see header).
    // Hard tiers are NOT emitted: the deposit fact and the
    // application↔lease bridge do not exist yet (BRIDGE_AUDIT.md).
    let commitment_tier = "none";
    if (r.open_application_id) {
      commitment_tier = "applicant_demand";
      reason += " An open application references this unit.";
    } else {
      reason += " No commitment recorded (deposit and lease-bridge facts do not exist yet — honest none, not a gap in this unit).";
    }

    // tourable: a vacant, in-supply space can be walked; a resident in
    // place cannot be toured in person. Tourability NEVER gates
    // leaseability — on_notice is leaseable-forward with tourable=false.
    const tourable_in_person = !spaceOccupied && availability_state !== "unavailable";

    // presentation materials: no media source exists at source today.
    // All-false is the honest truth, never an inference from state.
    const presentation_materials = { photos: false, floor_plan: false, video: false, matterport: false };

    return {
      unit_id: r.unit_id,
      space_id: r.space_id,
      unit_number: r.unit_number,
      space_label: r.space_label,
      occupancy_status: r.occupancy_status, // contracted axis — verbatim, untouched
      availability_state,
      projected_ready_date,
      date_confidence,
      commitment_tier,
      tourable_in_person,
      presentation_materials,
      reason,
    };
  }

  return router;
};
