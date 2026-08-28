// =============================================================
// leasing_intel.js — the claimed-side leasing read.
//
//   THESIS: the leasing log/tracker is where leasing truth is
//   recorded at the moment it happens (lease signed, renewal
//   decided). Yardi lags it. So the leasing log is the CLAIMED
//   side and Yardi is the PROVEN side; the gap is EXPOSURE.
//
//   This module does NOT model leasing events. It ingests the
//   living workbook (drop a file), applies a mapping PROVEN by
//   hand against the real Solo file (16 signed-not-in-Yardi /
//   $23,165/mo; 207 open; 0 renewals unresolved; 91.1% occ),
//   stores the computed payload as a snapshot, and serves it on
//   the same /leasing-dashboard the operator app already calls.
//
//   Two doors:
//     POST /properties/:id/leasing-log     (upload .xlsx -> parse -> store -> return payload)
//     GET  /properties/:id/leasing-dashboard  (serve snapshot if present; else next() -> live desk read)
//
//   Anti-corruption: numbers are computed from the ROW-LEVEL log,
//   not the workbook's self-reported summary tab. Where the two
//   disagree (e.g. the summary says 10 incomplete leases but the
//   rows show 16 not-in-Yardi) the board reports the row truth and
//   records the drift as a warning. A wrong confident value is
//   worse than an honest blank — anything unreadable is flagged,
//   not invented. Applications have NO rows in this workbook, so
//   they stay provisional (summary self-report) and never become
//   proven truth here.
// =============================================================

const express = require("express");
const XLSX = require("xlsx");

// ───────────────────────── parse helpers ─────────────────────────
function rowsOf(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true });
}
const truthy = (v) =>
  v === true || ["true", "yes", "y", "x", "1"].includes(String(v ?? "").trim().toLowerCase());
const numOrNull = (v) => (typeof v === "number" && isFinite(v) ? v : null);
function fmtDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  return null;
}
// last numeric value in a row (handles the workbook's inconsistent value columns)
function lastNum(row) {
  let n = null;
  for (const c of row || []) if (typeof c === "number" && isFinite(c)) n = c;
  return n;
}
// scan a sheet for the first row containing `sub` (case-insensitive) in any
// string cell; return the last numeric in that row. The workbook is label-keyed.
function findNum(rows, sub) {
  if (!rows) return null;
  const s = sub.toLowerCase();
  for (const r of rows) {
    if ((r || []).some((c) => typeof c === "string" && c.toLowerCase().includes(s))) {
      const n = lastNum(r);
      if (n != null) return n;
    }
  }
  return null;
}
// first numeric in a labeled row — for sheets (LSR, Daily Report) whose rows
// carry a second column to the right, so "last numeric" grabs the wrong value.
function firstNum(rows, sub) {
  if (!rows) return null;
  const s = sub.toLowerCase();
  for (const r of rows) {
    if ((r || []).some((c) => typeof c === "string" && c.toLowerCase().includes(s))) {
      for (const c of r || []) if (typeof c === "number" && isFinite(c)) return c;
    }
  }
  return null;
}
// label in col index 2 -> value in col index 3 (the 4233 Summary shape)
function labelVal(rows, label) {
  if (!rows) return null;
  const s = label.toLowerCase();
  for (const r of rows) {
    if (typeof r?.[2] === "string" && r[2].trim().toLowerCase() === s) return r[3];
  }
  return null;
}
const pct1 = (v) => (v == null ? null : ((v <= 1 ? v * 100 : v)).toFixed(1) + "%");
const usd = (n) => "$" + Number(n || 0).toLocaleString("en-US");
const cnt = (v) => (v == null ? null : { count: String(v) });

// ──────────────── the Solo mapping (PROVEN against the real file) ────────────────
function parseSoloWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const warnings = [];

  // 1) Leasing Tracker — the signed-this-cycle log + per-lease Yardi flag.
  let leased = 0, pending = 0, exposureRent = 0;
  const exposure = []; // signed but NOT in Yardi = live control exposure
  const lt = rowsOf(wb, "Leasing Tracker");
  if (!lt) warnings.push("Leasing Tracker sheet not found — Yardi exposure unavailable.");
  else {
    for (let i = 2; i < lt.length; i++) {
      const r = lt[i] || [];
      const name = r[0], status = r[1], unit = r[4], signed = r[5], rent = r[8], yardi = r[10];
      if (!name || !status) continue;
      const st = String(status).trim().toLowerCase();
      if (st === "leased") {
        leased++;
        if (!truthy(yardi)) {
          exposure.push({
            unit: unit == null ? "TBA" : String(unit),
            tenant: String(name).trim(),
            signed: fmtDate(signed),
            rent: numOrNull(rent),
          });
          if (typeof rent === "number") exposureRent += rent;
        }
      } else if (st === "pending") {
        pending++;
      }
    }
  }

  // 2) Rent Analysis — totals: units / pre-leased / remaining (open inventory).
  let totalUnits = null, preLeased = null, remaining = null;
  const ra = rowsOf(wb, "Rent Analysis");
  if (ra) {
    let u = 0, p = 0, rem = 0, seen = false;
    for (const r of ra) {
      // a per-unit-type row: a name in col1, a count in col2, not the TOTAL row
      if (typeof r?.[1] === "string" && r[1].trim() && !/total/i.test(r[1]) && typeof r?.[2] === "number" && r[2] > 0 && r[2] < 1000) {
        u += r[2]; p += (r[3] || 0); rem += (r[8] || 0); seen = true;
      }
    }
    if (seen) { totalUnits = u; preLeased = p; remaining = rem; }
  }
  if (remaining == null) warnings.push("Rent Analysis totals not found — open inventory unavailable.");

  // 3) Renewal Tracker — per-renewal status (row-level, not the summary count).
  let renewed = 0, canceled = 0, unresolved = 0, renewalRowsFound = false;
  const rt = rowsOf(wb, "Renewal Tracker");
  if (rt) {
    let h = -1, statusCol = -1, tenantCol = -1;
    for (let i = 0; i < rt.length; i++) {
      const row = (rt[i] || []).map((c) => String(c ?? "").trim().toLowerCase());
      if (row.includes("status") && row.includes("tenant name")) {
        h = i;
        statusCol = row.indexOf("status");
        tenantCol = row.indexOf("tenant name");
        break;
      }
    }
    if (h >= 0) {
      renewalRowsFound = true;
      for (let i = h + 1; i < rt.length; i++) {
        const r = rt[i] || [];
        if (!r[tenantCol]) continue;
        const st = String(r[statusCol] ?? "").trim().toLowerCase();
        if (st === "renewed") renewed++;
        else if (st === "canceled" || st === "cancelled") canceled++;
        else if (st === "proposal sent" || st === "") unresolved++;
      }
    } else warnings.push("Renewal Tracker header not found — renewal counts unavailable.");
  }
  if (canceled > 0)
    warnings.push(
      `${canceled} renewals marked "Canceled" carry proposal/"waiting for answers" comments — confirm with the team whether Canceled means declined-and-leaving or still-in-play.`
    );

  // 4) 4233 Summary — occupancy + lease-expiration rollover curve.
  const summ = rowsOf(wb, "4233 Summary");
  const occ = summ ? labelVal(summ, "Occupancy") : null; // 0.911
  const asOfDate = summ ? fmtDate(labelVal(summ, "Date")) : null;
  const roll = (m) => labelVal(summ, m);
  const rolloverParts = [];
  for (const m of ["Current Vacant", "June", "July", "Aug", "Sept"]) {
    const v = roll(m);
    if (typeof v === "number") rolloverParts.push(`${m} ${v}`);
  }

  // 5) LSR — current condition: vacant / ready / down / to-turn / leases-out.
  const lsr = rowsOf(wb, "LSR");
  const vacant = firstNum(lsr, "Current Vacancy");
  const ready = firstNum(lsr, "Ready to Rent");
  const down = firstNum(lsr, "Down Units");
  const toTurn = firstNum(lsr, "To Turn Over");
  const leasesOut = firstNum(lsr, "Leases Out for Sign");

  // 6) Daily Leasing Report — fall-cycle progress + activity (PROVISIONAL self-report).
  const dlr = rowsOf(wb, "Daily Leasing Report");
  const fallPre = firstNum(dlr, "Total Actual Fall Prelease"); // 0.757
  const goalPct = firstNum(dlr, "Total Goal Leases"); // 0.954
  const goalGap = firstNum(dlr, "Leases Remaining to achieve goal"); // 55
  const leads = firstNum(dlr, "Leads Total this Week"); // 28
  const leadsGoal = firstNum(dlr, "Leads Goal this Week"); // 55
  const tours = firstNum(dlr, "Total Tours"); // 12
  const guestCards = firstNum(dlr, "Total Guest Cards"); // 21
  const incApps = firstNum(dlr, "Total Incomplete Applications"); // 9 (provisional)
  const signedWk = firstNum(dlr, "Total Leases This Week"); // 7
  const weeklyTarget = firstNum(dlr, "This Weeks Target"); // 20
  const summaryIncLeases = firstNum(dlr, "Total Incomplete Leases"); // 10 (drifts from 16)

  // ---- cross-checks: the drift the gate exists to catch ----
  const exposureCount = exposure.length;
  if (summaryIncLeases != null && summaryIncLeases !== exposureCount)
    warnings.push(
      `Workbook drift: summary "Incomplete Leases" = ${summaryIncLeases}, but the row-level Yardi backlog = ${exposureCount}. Serving the row-level truth.`
    );
  if (incApps != null)
    warnings.push(
      `Applications (${incApps}) are a summary self-report — there is no per-application row table in this workbook (only ${pending} rows marked Pending). Provisional, not proven.`
    );

  const occStr = pct1(occ);
  const fallStr = pct1(fallPre);
  const goalStr = pct1(goalPct);

  // ──────────────── assemble the /leasing-dashboard payload ────────────────
  const payload = {
    demo: false,
    source: "Solo leasing log (.xlsx), parsed live",

    headline: {
      current_occupancy: cnt(occStr),

      exposed: cnt(remaining),                 // forward open inventory (NOT the goal gap)
      unassigned: cnt(remaining),

      yardi_control: cnt(exposureCount),       // signed but not in Yardi = the hero exposure
      incomplete_leases: cnt(exposureCount),
      proof_gates_open: cnt(exposureCount),
      followups_due: cnt(exposureCount),

      renewals_unresolved: cnt(unresolved),    // row-level; 0 when all decided

      applications_pending: cnt(incApps),      // PROVISIONAL (summary; no rows)
      stuck_pipeline: cnt(incApps),
      leases_out: cnt(leasesOut),

      future_rent_roll: cnt(fallStr),          // labeled "Fall Prelease"
      future_occupancy: cnt(fallStr),

      signed_this_week: cnt(signedWk),
      leads_this_week: cnt(leads),
      leads_goal: cnt(leadsGoal),
      tours_this_week: cnt(tours),
    },

    focus: {
      title: `${usd(exposureRent)}/mo of signed rent is not yet in Yardi.`,
      text: `${exposureCount} leases are signed but not assigned in Yardi — that is the live control exposure, by name and unit, below. The fall goal gap (${goalGap}) and weekly pace live one click down.`,
    },

    future_rent_roll: {
      current: occStr ? `${occStr} occupied today` : "occupancy unavailable",
      future: fallStr ? `${fallStr} fall pre-leased` : "fall prelease unavailable",
      gap: goalGap != null ? `${goalGap} leases needed to reach the ${goalStr || "fall"} goal` : "goal gap unavailable",
      period: "Fall 2026",
    },

    decide_now: [
      {
        kind: "yardi_exposure",
        title: `${exposureCount} signed leases not in Yardi — ${usd(exposureRent)}/mo unverified`,
        unit: "SOLO", unit_type: "Signed this cycle", person: "Leasing team",
        next_action: "Assign each in Yardi, or record why it is held",
        impact: `${usd(exposureRent)}/mo of signed rent is claimed but not proven in the system of record`,
        tone: "red",
        sop_basis: "Leasing Tracker carries a per-lease 'Assigned in Yardi?' flag — these are FALSE.",
        proof_steps: ["lease signed (done)", "final lease sent", "unit assigned in Yardi", "Yardi confirmed"],
      },
      {
        kind: "pace_gap",
        title: "Weekly pace vs target",
        unit: "SOLO", unit_type: "All units", person: "Leasing team",
        next_action: `Review ${signedWk} signed vs ${weeklyTarget} weekly target before changing price`,
        impact: `${goalGap} leases still needed to hit the fall goal`,
        tone: "brass",
        sop_basis: "Daily Leasing Report: weekly target, actual signed, fall prelease, remaining to goal.",
        proof_steps: ["signed leases reconciled", "weekly target checked", "traffic checked", "decision logged"],
      },
    ],

    future_inventory: [
      vacant != null && { status: "Vacant Now", unit: "Current vacancy", unit_type: `${vacant} vacant units`, available_date: "Now", rent: null, target_rent: null, days_exposed: null, next_action: "Vacant today — distinct from rent-ready", exposure_type: "current vacancy", workflow: "availability" },
      ready != null && { status: "Available Now", unit: "Ready units", unit_type: `${ready} rent-ready`, available_date: "Now", rent: null, target_rent: null, days_exposed: null, next_action: "Click into Availability before assigning", exposure_type: "rent-ready inventory", workflow: "availability" },
      down != null && { status: "Vacant / Not Ready", unit: "Down units", unit_type: `${down} down`, available_date: "TBD", rent: null, target_rent: null, days_exposed: null, next_action: "Not available until turn/repair gate closes", exposure_type: "blocked by condition", workflow: "turn" },
      toTurn != null && { status: "To Turn Over", unit: "Turn pipeline", unit_type: `${toTurn} to turn`, available_date: "TBD", rent: null, target_rent: null, days_exposed: null, next_action: "Set ready date and turn owner", exposure_type: "move-out to ready", workflow: "move-out handoff" },
      remaining != null && { status: "Not Yet Pre-Leased", unit: "Fall term", unit_type: `${remaining} units open`, available_date: "Fall 2026", rent: null, target_rent: null, days_exposed: null, next_action: "Future rent roll, not today's occupancy, drives assignment", exposure_type: "forward open inventory", workflow: "preleasing" },
      rolloverParts.length && { status: "Expiration Curve", unit: "Rollover", unit_type: rolloverParts.join(" · ") + " expiring", available_date: "by month", rent: null, target_rent: null, days_exposed: null, next_action: "July is the wall", exposure_type: "lease rollover", workflow: "preleasing" },
    ].filter(Boolean),

    proof_gates: [
      { kind: "yardi_proof", title: `${exposureCount} signed leases not in Yardi`, unit: `${usd(exposureRent)}/mo`, person: "Leasing team", next_action: "Assign each in Yardi or record the hold reason", tone: "red", sop_basis: `Per-lease 'Assigned in Yardi?' flag is the gate. Row-level = ${exposureCount}${summaryIncLeases != null ? ` (summary tab says ${summaryIncLeases})` : ""}.`, proof_steps: ["lease signed", "final lease sent", "unit assigned in Yardi", "Yardi confirmed"] },
      { kind: "renewal_proof", title: unresolved > 0 ? `${unresolved} renewals unresolved` : "Renewals all decided", unit: `${renewed} renewed · ${canceled} declined`, person: "Current residents", next_action: canceled > 0 ? "Declined renewals roll into open inventory — confirm the 'Canceled' comments" : "No outstanding renewal decisions", tone: unresolved > 0 ? "brass" : "blue", sop_basis: "Renewal Tracker status + Renewal-Signed date, row level.", proof_steps: ["offer sent", "answer logged", "new lease signed or unit released"] },
      { kind: "application_proof", title: `${incApps == null ? "?" : incApps} applications (provisional)`, unit: `${pending} signed-side rows`, person: "Applicants", next_action: "No per-application rows exist — provisional until a real source feeds it", tone: "blue", sop_basis: "Daily Leasing Report self-report; not row-level truth.", proof_steps: ["photo ID", "income verification", "screening reviewed"] },
    ],

    weekly_intel: {
      title: `SOLO Weekly Leasing Report${asOfDate ? " (as-of " + asOfDate + ")" : ""}`,
      summary: "The weekly self-report layer — one click down. These summary numbers can drift from the row-level log (e.g. Yardi backlog reported as " + (summaryIncLeases ?? "—") + ", actually " + exposureCount + ").",
      metrics: [
        occStr && { label: "Occupancy", value: occStr },
        fallStr && { label: "Fall prelease", value: fallStr },
        goalStr && { label: "Goal", value: goalStr },
        goalGap != null && { label: "Leases needed", value: String(goalGap) },
        signedWk != null && { label: "Signed this week", value: `${signedWk}${weeklyTarget != null ? " / " + weeklyTarget + " target" : ""}` },
        leads != null && { label: "Leads this week", value: `${leads}${leadsGoal != null ? " / " + leadsGoal + " goal" : ""}` },
        tours != null && { label: "Tours", value: String(tours) },
        guestCards != null && { label: "Guest cards", value: String(guestCards) },
      ].filter(Boolean),
    },

    // drill-down detail (the named exposure) — harmless if the UI ignores it
    exposure_detail: {
      count: exposureCount,
      monthly_rent_at_risk: exposureRent,
      monthly_rent_at_risk_label: usd(exposureRent),
      leases: exposure,
    },

    facts: {
      total_units: totalUnits, leased, pending,
      pre_leased: preLeased, remaining,
      renewed, canceled, renewals_unresolved: unresolved,
      vacant, ready, down, to_turn: toTurn, leases_out: leasesOut,
      occupancy_raw: occ, fall_prelease_raw: fallPre,
    },

    warnings,
  };

  const as_of = asOfDate || new Date().toISOString().slice(0, 10);
  return { payload, as_of, warnings };
}

// ───────────────────────── snapshot store ─────────────────────────
// One row per property — the latest computed leasing read. NOT an event
// model; a materialized read so GET works between uploads.
async function saveSnapshot(pool, propertyId, { payload, as_of, source_filename }) {
  await pool.query(
    `insert into leasing_snapshots (property_id, as_of, payload, source_filename, uploaded_at)
     values ($1, $2, $3, $4, now())
     on conflict (property_id) do update
        set as_of = excluded.as_of,
            payload = excluded.payload,
            source_filename = excluded.source_filename,
            uploaded_at = now()`,
    [propertyId, as_of, JSON.stringify(payload), source_filename || null]
  );
}
async function getSnapshot(pool, propertyId) {
  try {
    const { rows } = await pool.query(
      `select as_of, payload, source_filename, uploaded_at
         from leasing_snapshots where property_id = $1`,
      [propertyId]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return { as_of: r.as_of, payload: r.payload, source_filename: r.source_filename, uploaded_at: r.uploaded_at };
  } catch (e) {
    // table not migrated yet, etc. — fail soft so the desk read still works.
    if (e && e.code === "42P01") return null;
    throw e;
  }
}

// ───────────────────────── router ─────────────────────────
module.exports = function leasingIntelModule({ pool, upload }) {
  const router = express.Router();

  // Upload the living leasing log → parse → store → return the payload.
  router.post("/properties/:propertyId/leasing-log", upload.single("file"), async (req, res) => {
    try {
      const prop = (await pool.query("select id, name, address from properties where id=$1", [req.params.propertyId])).rows[0];
      if (!prop) return res.status(404).json({ receipt: "No property with that id." });
      if (!req.file || !req.file.buffer) return res.status(400).json({ receipt: "No file uploaded. Send the .xlsx as form field 'file'." });

      const { payload, as_of, warnings } = parseSoloWorkbook(req.file.buffer);
      await saveSnapshot(pool, prop.id, { payload, as_of, source_filename: req.file.originalname });

      res.json({
        receipt:
          `Parsed ${req.file.originalname} for ${prop.name || prop.address}. ` +
          `Exposure: ${payload.exposure_detail.count} signed leases not in Yardi (${payload.exposure_detail.monthly_rent_at_risk_label}/mo). ` +
          `Open inventory: ${payload.facts.remaining}. Renewals unresolved: ${payload.facts.renewals_unresolved}.`,
        property: { id: prop.id, name: prop.name, address: prop.address },
        as_of,
        warnings,
        payload,
      });
    } catch (e) {
      console.error("leasing-log:", e);
      res.status(500).json({ receipt: "Could not parse the leasing log.", error: e.message });
    }
  });

  // Serve the snapshot on the read the operator app already calls.
  // If no log has been uploaded, fall through to the existing desk read.
  router.get("/properties/:propertyId/leasing-dashboard", async (req, res, next) => {
    try {
      const snap = await getSnapshot(pool, req.params.propertyId);
      if (!snap) return next(); // -> desks.js buildLeasing
      const prop = (await pool.query("select id, name, address from properties where id=$1", [req.params.propertyId])).rows[0];
      res.json({
        property: prop ? { id: prop.id, name: prop.name, address: prop.address } : undefined,
        as_of: snap.as_of,
        source: snap.source_filename || "leasing log",
        ...snap.payload,
      });
    } catch (e) {
      console.error("leasing-dashboard (intel):", e);
      next(); // never block the desk read on an intel error
    }
  });

  return router;
};

// expose the pure mapping for local proving / tests
module.exports.parseSoloWorkbook = parseSoloWorkbook;
module.exports.getSnapshot = getSnapshot;
module.exports.saveSnapshot = saveSnapshot;
