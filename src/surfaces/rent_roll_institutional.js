// ════════════════════════════════════════════════════════════════════
//  rent_roll_institutional.js — THE FORMAL AS-OF RENT ROLL
//
//  The second presentation of ONE canonical read. Operating Rent Roll and
//  Institutional Rent Roll are not two systems and not two calculations:
//  both call currentRentRoll(), and this module only reshapes.
//
//    Operating      searchable, exception-aware, continues into the
//                   Person Card.
//    Institutional  a formal as-of schedule an owner, lender, asset
//                   manager or buyer would recognise, plus export.
//
//  ONE ROW PER CANONICAL RENTABLE POSITION — 283 positions, never the 386
//  imported source rows. The Yardi schedule gave us the recognisable column
//  SHAPE; it is not runtime authority and its totals never blend into ours.
//
//  NO CALCULATION HERE. Every total is passed through from the canonical
//  response. Print and CSV read this same object, so the printed page, the
//  CSV and the operating page cannot disagree.
//
//  HONEST BLANKS, NEVER BACKFILLED FROM THE SPREADSHEET:
//   · unit_type      — 'Not configured' until a reviewed mapping receipt
//                      creates governed property_unit_types rows.
//   · security_deposit — BLANK. The imported column's meaning is not yet
//                      governed (required vs held vs dated ledger balance),
//                      and the evidence points at 'held as of the source
//                      date' rather than contractual economics. Writing it
//                      into a field that reads as contractual would make a
//                      guess permanent. The claims survive as evidence.
//   · market_rent    — absent from the schedule entirely. It is a source
//                      claim, not authorised pricing and not contractual
//                      economics.
//
//  WRITES NOTHING.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { currentRentRoll } = require("./rent_roll_canonical");
const { rentRollBuckets } = require("../tenancy/dated_positions");

const NOT_CONFIGURED = "Not configured";

// The institutional column order. Print, CSV and the JSON rows all use this
// one definition, so a column can never appear in one output and not another.
const COLUMNS = [
  { key: "position",          label: "Unit / Bed" },
  { key: "unit_type",         label: "Unit Type" },
  { key: "square_feet",       label: "Sq Ft" },
  { key: "resident",          label: "Resident" },
  { key: "lease_start",       label: "Lease Start" },
  { key: "lease_expiration",  label: "Lease Expiration" },
  { key: "monthly_rent",      label: "Monthly Contractual Rent" },
  { key: "security_deposit",  label: "Security Deposit" },
  { key: "current_balance",   label: "Current Balance" },
  { key: "balance_as_of",     label: "Balance As Of" },
  { key: "notice_state",      label: "Notice" },
  { key: "successor_state",   label: "Future Lease" },
  { key: "status",            label: "Status" },
];

// Dates arrive as either an ISO string or a pg Date. String(date).slice(0,10)
// on a Date yields "Wed Jul 22" — a locale string, not a date — which is
// exactly the kind of thing that reads as fine until a lender opens the CSV.
//
// The fix for that locale string was toISOString(), which is correct for a
// timestamp and wrong for a `date` column, where node-pg builds the Date at
// LOCAL midnight. So the helper carried the same latent off-by-one.
//
// ⚠ SAY WHAT WAS MEASURED. On the observed path it never fired: the lease
// dates reaching institutionalRow arrive from dated_positions as STRINGS, so
// they take the slice branch, and Lease Start / Lease Expiration were
// byte-identical under TZ=UTC and TZ=Europe/Berlin BOTH before and after this
// change. What moved under Berlin was the canonical reader's contested-claim
// dates (2026-01-01 read back as 2025-12-31). This change therefore disarms a
// trap rather than repairing an observed wrong value — any future caller
// handing this helper a real Date gets the recorded day. One module owns the
// rule, with the measurement as its test.
const { dateColumnToIsoOrBlank: ymd } = require("../shared/date_column");

// Occupancy / exception state in language an owner or lender reads without a
// glossary. The canonical axes stay available in the raw rows beneath.
/*  ── THE BUCKET IS THE WORD; QUALIFIERS ARE APPENDED, NEVER SUBSTITUTED ──
 *
 *  Two rules meet here and the earlier versions each kept only one.
 *
 *  RULE A — the operating Rent Roll and this formal schedule must not
 *  disagree about WHICH bucket a position is in. The axis-only chain this
 *  function used to be re-derived the word from tenancy_state, so the print
 *  page could call a needs-review or activation-pending position "Occupied"
 *  while the operating table correctly separated it. The bucket is decided
 *  once, server-side, in rentRollBucketOf; it is the base of every status
 *  here and is never recomputed.
 *
 *  RULE B — the bucket deliberately does NOT carry everything a lender
 *  reads, and THIS SCHEDULE HAS NO OTHER COLUMN FOR ANY OF IT (COLUMNS
 *  above is the whole list). Returning `bucket_label` alone therefore lost
 *  four facts outright, on the one surface that travels to a lender.
 *
 *  So: the bucket supplies the word, and each fact the bucket cannot
 *  express is appended to it. The base word still matches the operating
 *  table character for character, which is what Rule A actually asked for
 *  — a refinement is not a disagreement.  */
function statusLabel(r) {
  //  THE PRIOR QUESTION, answered first and separately: no basis is not a
  //  fifth tenancy state, so it gets no bucket and no qualifier.
  if (r.bucket == null) return "Occupancy Unconfirmed";
  const base = r.bucket_label;
  const qualifiers = [];

  /*  (1) `occupied` IS ONE BUCKET OVER TWO FACTS. rentRollBucketOf returns
   *  it both for `tenancy_state === "contractually_occupied"` and for
   *  `basis_type === "opening_claim_occupied"` — and its own comment on the
   *  second says: *"Occupied" must never secretly mean "a canonical lease
   *  exists"*. Without this line every accepted-occupancy bed with no
   *  established rent, term or legal right prints as plain "Occupied".
   *
   *  ⚠ THE DISCRIMINATOR IS contractual_terms_state, NOT tenancy_state.
   *  Both would separate the same rows today, but only this one is derived
   *  from the SAME `current_lease_position` that decides the bucket's first
   *  branch — so the split is exact by construction rather than by two
   *  independently-computed sets happening to coincide.  */
  if (r.bucket === "occupied" && r.contractual_terms_state === "not_established") {
    qualifiers.push("terms not established");
  }

  /*  (2) ECONOMICS. A spanning lease whose amount cannot support a
   *  contractual claim leaves Monthly Contractual Rent blank. Without this
   *  the row is "Occupied" beside an empty rent cell, and nothing on the
   *  page says whether that means unavailable or simply not yet typed.  */
  if (r.bucket === "occupied" && r.economics_state === "unavailable") {
    qualifiers.push("rent unavailable");
  }

  /*  (3) CONTESTED. Needs Review has several causes; overlapping lease
   *  claims are the one a lender must not read as a data-entry backlog.  */
  if (r.bucket === "needs_review" && r.tenancy_state === "contested") {
    qualifiers.push("overlapping leases");
  }

  /*  (4) DOWN. rentRollBucketOf does not read `is_down` AT ALL — a down,
   *  vacant bed buckets as `open` and printed as a bare "Open": offered as
   *  available to lease, on the one surface a lender reads. Down is a
   *  physical hold and not a tenancy fact, which is precisely why it
   *  belongs here as a qualifier and not in the bucket.  */
  if (r.is_down) qualifiers.push("unit down");

  return qualifiers.length ? `${base} — ${qualifiers.join(" · ")}` : base;
}

function institutionalRow(r) {
  const bed = r.space_label && !/whole\s*unit/i.test(r.space_label) ? ` · ${r.space_label}` : "";
  // A recorded amount is a contractual figure in this report only when the
  // canonical economics axis has established it.  Keep zero and negative
  // amounts when they are established; this guard is about authority and
  // finiteness, not a positivity heuristic.
  const recordedRent = r.current_rent;
  const contractualRent = r.economics_state === "available" && recordedRent != null &&
    Number.isFinite(Number(recordedRent)) ? Number(recordedRent) : "";
  return {
    space_id: r.space_id,
    unit_id: r.unit_id,
    position: `${r.unit_number || ""}${bed}`,
    position_kind: r.position_kind,
    // Governed classification only. A source code is provenance, not a type.
    unit_type: r.unit_type || NOT_CONFIGURED,
    square_feet: r.square_feet == null ? "" : r.square_feet,
    resident: r.resident && r.resident.name ? r.resident.name : (r.lease ? "Resident not linked" : ""),
    person_id: r.resident ? r.resident.person_id : null,
    lease_start: r.lease ? ymd(r.lease.start_date) : "",
    lease_expiration: r.lease ? ymd(r.lease.end_date) : "",
    monthly_rent: contractualRent,
    // Deliberately blank — see the header. The reconciliation section says why.
    security_deposit: "",
    current_balance: r.balance == null ? "" : Number(r.balance),
    balance_as_of: r.balance_as_of ? ymd(r.balance_as_of) : "",
    notice_state: r.notice_state === "on_notice" ? "On notice" : "",
    successor_state: r.successor_state === "locked" ? "Locked"
      : r.successor_state === "pending" ? "Pending" : "",
    status: statusLabel(r),
    // canonical axes retained for the drill-down; not printed columns
    _axes: {
      tenancy_state: r.tenancy_state, evidence_state: r.evidence_state,
      economics_state: r.economics_state, proof_basis: r.proof_basis,
      conflict_state: r.conflict_state, imported_occupancy_claim: r.imported_occupancy_claim,
    },
  };
}

async function institutionalRentRoll(pool, { property_id, as_of = null } = {}) {
  const rr = await currentRentRoll(pool, { property_id, as_of });
  const prop = (await pool.query("select name, display_name from properties where id=$1", [property_id])).rows[0] || {};

  const rows = rr.rows.map(institutionalRow);
  const t = rr.totals;
  // `currentRentRoll` carries the same bucket on every row that the unit-first
  // operating reader relays. Tally that already-decided field; do not infer
  // occupancy from tenancy_state or subtract exceptions in this presentation.
  const buckets = rentRollBuckets(rr.rows);

  return {
    report: {
      title: "Rent Roll",
      property_id,
      property_name: prop.display_name || prop.name || null,
      as_of: rr.as_of,
      generated_at: new Date().toISOString(),
      basis: "canonical_property_positions",
      note: "One row per canonical rentable position. Totals are server-authored and identical to the operating Rent Roll.",
    },

    columns: COLUMNS,
    rows,

    // PASSED THROUGH, never recomputed.
    totals: {
      total_positions: t.inventory,
      /*  ⚠ THIS KEY'S NAME IS A CLAIM, AND IT MUST STAY TRUE.
       *
       *  It briefly read `buckets.occupied / buckets.total`. Both halves
       *  moved, in opposite directions, under a name that says CONFIRMED
       *  CONTRACTUAL: the numerator gained every accepted opening claim
       *  with no lease (the `occupied` bucket counts those on purpose), and
       *  the denominator gained back the down and contested positions the
       *  canonical reader excludes on purpose. On a real portfolio where a
       *  small minority of positions carry trusted rent economics, that
       *  reports the claim-backed population to a lender as contractually
       *  confirmed.
       *
       *  The canonical reader already computes this correctly and says so
       *  in its own comment ("LANGUAGE: this is CONFIRMED contractual
       *  occupancy"). Pass it through — the header three lines above says
       *  PASSED THROUGH, never recomputed, and this is what that means.
       *  The bucket counts live below, under names that say `positions_`.  */
      confirmed_contractual_occupancy: t.confirmed_contractual_occupancy.occupied,
      occupancy_denominator: t.confirmed_contractual_occupancy.of_leasable_resolved,
      //  Named, not silent: a ratio with a narrower denominator has to say
      //  what it left out, or the next reader re-derives a different one.
      occupancy_excluded_down: t.confirmed_contractual_occupancy.excluded_from_denominator.down,
      occupancy_excluded_contested: t.confirmed_contractual_occupancy.excluded_from_denominator.contested,
      /*  THE OPERATING BUCKET, over EVERY position, under a name that says
       *  so. This is deliberately NOT the same number as the contractual
       *  numerator above whenever an accepted opening claim exists, and the
       *  two are reported side by side so the gap is visible rather than
       *  collapsed into whichever one a surface happened to pick.  */
      positions_occupied_all_bases: buckets.occupied,
      positions_occupied_terms_not_established:
        t.confirmed_contractual_occupancy.reported_beside.occupied_terms_not_established,
      trusted_monthly_contractual_rent: t.contractual_rent_trusted,
      positions_contributing_rent: t.positions_contributing_rent,
      contested_rent_excluded: t.contractual_rent_excluded_contested,
      positions_economics_unavailable: t.occupied_without_known_rent,
      positions_conflicting_evidence: rr.exceptions.evidence_disagrees,
      positions_contested: rr.exceptions.contested,
      positions_activation_pending: buckets.activation_pending,
      positions_open: buckets.open,
      positions_needs_review: buckets.needs_review,
      positions_occupancy_unconfirmed: buckets.not_established,
      positions_down: t.down,
      proof_basis: rr.proof_summary,
    },

    // VISIBLE AND SEPARATE — recognisable schedule above, Spine's stronger
    // truth beneath it. Not fine print, and not an audit screen replacing the
    // report an owner expects.
    reconciliation: {
      statements: [
        t.contractual_rent_trusted == null
          ? "Trusted monthly contractual rent is unavailable: no position has a trusted contractual amount."
          : `Trusted monthly contractual rent: $${Number(t.contractual_rent_trusted).toLocaleString()} from ${t.positions_contributing_rent} positions.`,
        `Contested rent claims excluded: $${Number(t.contractual_rent_excluded_contested).toLocaleString()} across ${rr.exceptions.contested} positions with overlapping lease claims.`,
        `${t.occupied_without_known_rent} occupied position(s) have unavailable contractual economics and contribute no rent.`,
        `${rr.exceptions.evidence_disagrees} position(s) have conflicting occupancy evidence between the opening source and canonical lease records.`,
        `Contractual proof basis: ${rr.proof_summary.native_verified} verified in Spine, ${rr.proof_summary.confirmed_opening_import} confirmed opening truth.`,
        "Security deposit is not shown: opening-source deposit claims exist but have not yet been mapped to a governed deposit meaning (required versus held).",
        "Unit classifications have not yet been configured.",
      ],
      contested_claims: rr.contested_claims,
      opening_truth: rr.opening_truth,
    },
  };
}

// CSV FROM THE SAME OBJECT — same columns, same order, same values. The CSV
// cannot disagree with the printed page because neither computes anything.
function institutionalCsv(report) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  lines.push(esc(report.report.title) + " — " + esc(report.report.property_name || ""));
  lines.push("As of," + esc(report.report.as_of) + ",Generated," + esc(report.report.generated_at));
  lines.push("");
  lines.push(report.columns.map((c) => esc(c.label)).join(","));
  for (const r of report.rows) lines.push(report.columns.map((c) => esc(r[c.key])).join(","));
  lines.push("");
  lines.push("TOTALS");
  const t = report.totals;
  lines.push("Total canonical rentable positions," + t.total_positions);
  /*  THE CSV IS THE ARTEFACT THAT TRAVELS. It carried the occupancy ratio
   *  and nothing that qualified it — not what the denominator excluded, and
   *  not one of the four bucket counts the JSON had gained. A lender opening
   *  this file saw one number and no way to tell what it was over. Every
   *  total in the JSON is emitted here, one label and one value per line,
   *  so the export cannot be a narrower story than the response.  */
  lines.push("Confirmed contractual occupancy," + t.confirmed_contractual_occupancy + " of " + t.occupancy_denominator);
  lines.push("Excluded from that denominator — down," + t.occupancy_excluded_down);
  lines.push("Excluded from that denominator — contested," + t.occupancy_excluded_contested);
  lines.push("Positions occupied on any recorded basis," + t.positions_occupied_all_bases);
  lines.push("...of those, terms not established," + t.positions_occupied_terms_not_established);
  lines.push("Positions pending activation," + t.positions_activation_pending);
  lines.push("Positions open," + t.positions_open);
  lines.push("Positions needing review," + t.positions_needs_review);
  lines.push("Positions with occupancy unconfirmed," + t.positions_occupancy_unconfirmed);
  lines.push("Positions down," + t.positions_down);
  lines.push("Trusted monthly contractual rent," + (t.trusted_monthly_contractual_rent == null ? "" : t.trusted_monthly_contractual_rent));
  lines.push("Positions contributing known rent," + t.positions_contributing_rent);
  lines.push("Contested rent excluded," + t.contested_rent_excluded);
  lines.push("Positions with unavailable economics," + t.positions_economics_unavailable);
  lines.push("Positions with conflicting occupancy evidence," + t.positions_conflicting_evidence);
  lines.push("");
  lines.push("RECONCILIATION");
  for (const s of report.reconciliation.statements) lines.push(esc(s));
  return lines.join("\n");
}

module.exports = { institutionalRentRoll, institutionalCsv, COLUMNS, NOT_CONFIGURED };
