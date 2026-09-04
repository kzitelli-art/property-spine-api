// document_ingest_routes.js — extracted VERBATIM from server.js (lines 2644-3123).
// Route paths and registration order are unchanged: server.js mounts this
// router at "/" at the exact position these routes were registered inline.
const express = require("express");
const staffSessions = require("../identity/staff_session_service.js"); // BRICK ONE: the ONE issuer/resolver/revoke

module.exports = function documentIngestRoutes({ pool, upload, runIngestAuto, fileToText }) {
  const router = express.Router();
// ── ingest from pasted TEXT ──
router.post("/properties/:propertyId/ingest", async (req, res) => {
  const { rent_roll_text } = req.body || {};
  if (!rent_roll_text) return res.status(400).json({ error: "rent_roll_text is required" });
  try {
    const prop = await pool.query("select id from properties where id=$1", [req.params.propertyId]);
    if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });
    const result = await runIngestAuto(req.params.propertyId, rent_roll_text, "rent_roll");
    res.json(result);
  } catch (e) {
    if (e.truncated) return res.status(413).json({ error: e.message, truncated: true });
    if (e.unparseable) return res.status(502).json({ error: e.message, raw: e.raw });
    res.status(500).json({ error: e.message });
  }
});

// ── ingest from an uploaded FILE (.xlsx/.xls/.csv/.pdf/.docx/.doc/.txt) ──
// The server reads any supported type to text, then runs the SAME pipeline.
// Multer runs first; we wrap it so an oversize file returns a clean 413 JSON
// instead of crashing the request with a 500 HTML page.
const uploadSingle = upload.single("file");
router.post("/properties/:propertyId/ingest-file", (req, res, next) => {
  uploadSingle(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "file too large — max 25 MB. If it's a big image-heavy PDF, the text-only content is what we need; try exporting/printing it to a smaller PDF, or paste the table text." });
      }
      return res.status(400).json({ error: "upload failed: " + err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file uploaded (field name must be 'file')" });
  try {
    const prop = await pool.query("select id from properties where id=$1", [req.params.propertyId]);
    if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });

    let text;
    try { text = await fileToText(req.file); }
    catch { return res.status(400).json({ error: "could not read file — supported: .xlsx .xls .csv .pdf .docx .doc .txt" }); }

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "file parsed but contained no readable text. If it is a scanned/photo PDF, OCR isn't supported yet — paste the table or upload an Excel/CSV." });
    }

    const result = await runIngestAuto(req.params.propertyId, text, "rent_roll_file");
    res.json({ ...result, source_filename: req.file.originalname });
  } catch (e) {
    if (e.truncated) return res.status(413).json({ error: e.message, truncated: true });
    if (e.unparseable) return res.status(502).json({ error: e.message, raw: e.raw });
    res.status(500).json({ error: e.message });
  }
});


// ── read a run's candidates back (for the review screen) ──
router.get("/ingest/:runId", async (req, res) => {
  try {
    const run = await pool.query("select * from ingest_runs where id=$1", [req.params.runId]);
    if (run.rows.length === 0) return res.status(404).json({ error: "run not found" });
    const cands = await pool.query(
      "select * from ingest_candidates where run_id=$1 order by created_at", [req.params.runId]
    );
    // leasing basis comes from the PROPERTY — one source of truth, never copied
    const prop = await pool.query("select leasing_basis from properties where id=$1", [run.rows[0].property_id]);
    const basis = prop.rows[0]?.leasing_basis || "unknown";
    const live = cands.rows.filter(c => ["pending", "ready_for_promotion", "approved"].includes(c.decision_status));
    const missingBeds = live.filter(c => c.bedrooms == null);
    res.json({
      ...run.rows[0],
      leasing_basis: basis,
      bed_check: {
        required: basis === "bed",
        rows_missing_beds: missingBeds.length,
        missing: missingBeds.map(c => ({ id: c.id, unit_number: c.unit_number })),
        note: basis === "bed"
          ? (missingBeds.length
              ? `this building leases BY THE BED — ${missingBeds.length} row(s) have no bed count, and promote will refuse them until filled (use the edit endpoint)`
              : "by-the-bed building, every row has a bed count — clear to promote")
          : "no bed requirement (basis is " + basis + ")",
      },
      candidates: cands.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  LEASING BASIS (migration 026) — how a building sells rent.
//  'unit' = rent attaches to the door; 'bed' = rent attaches to each
//  bedroom (student housing); 'unknown' = honest default.
// ════════════════════════════════════════════════════════════════════
router.post("/properties/:id/leasing-basis", async (req, res) => {
  const { leasing_basis } = req.body || {};
  if (!["unit", "bed", "unknown"].includes(leasing_basis))
    return res.status(400).json({ error: "leasing_basis must be 'unit', 'bed', or 'unknown'" });
  try {
    const r = await pool.query(
      "update properties set leasing_basis=$1 where id=$2 returning name, address, leasing_basis",
      [leasing_basis, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "property not found" });
    const p = r.rows[0];
    res.json({
      receipt: `${p.name || p.address} now leases by the ${leasing_basis === "unknown" ? "— basis unknown (no bed gate)" : leasing_basis}`,
      leasing_basis: p.leasing_basis,
      note: leasing_basis === "bed"
        ? "bed counts are now REQUIRED: promote will refuse units with blank bedrooms until they're filled (edit endpoint) or the basis changes"
        : "no bed requirement on promote",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
//  CANDIDATE EDIT — a human corrects a proposed row BEFORE it's real.
//  Human beats machine: edited fields flip to prov 'confirmed' with the
//  trail kept in ai_note. Only proposals can be edited — promoted rows
//  are real units (different ceremony), rejected rows are closed.
// ════════════════════════════════════════════════════════════════════
router.post("/ingest/:runId/candidates/:candidateId/edit", async (req, res) => {
  const allowed = ["unit_number", "bedrooms", "market_rent"];
  const edits = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if (Object.keys(edits).length === 0)
    return res.status(400).json({ error: `nothing to edit — send any of: ${allowed.join(", ")}` });
  try {
    const c = await pool.query(
      "select * from ingest_candidates where id=$1 and run_id=$2",
      [req.params.candidateId, req.params.runId]);
    if (c.rows.length === 0) return res.status(404).json({ error: "candidate not found in this run" });
    const row = c.rows[0];
    if (!["pending", "ready_for_promotion", "approved"].includes(row.decision_status))
      return res.status(409).json({ error: `this row is '${row.decision_status}' — ${row.decision_status === "promoted" ? "it's already a real unit; edit the unit, not the proposal" : "closed rows can't be edited"}` });
    const changes = Object.entries(edits)
      .map(([k, v]) => `${k}: ${row[k] ?? "—"} → ${v ?? "—"}`).join(", ");
    const r = await pool.query(
      `update ingest_candidates
          set unit_number = coalesce($1, unit_number),
              bedrooms    = $2,
              market_rent = $3,
              prov = 'confirmed',
              ai_note = coalesce(ai_note || ' | ', '') || $4
        where id=$5
        returning id, unit_number, bedrooms, market_rent, prov, decision_status`,
      [edits.unit_number ?? null,
       "bedrooms" in edits ? edits.bedrooms : row.bedrooms,
       "market_rent" in edits ? edits.market_rent : row.market_rent,
       `human edit (${changes})`, req.params.candidateId]);
    res.json({ receipt: `corrected — ${changes}. Marked confirmed (your word beats the machine's read).`, candidate: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
//  BED GROUPING — by-bed rolls list a ROW PER BED (101A, 101B, 101C).
//  The unit is 101; A/B/C are beds inside it. Ingest stays faithful to
//  the file (one candidate per row); this pass DETECTS the pattern and
//  PROPOSES the grouping — a human confirms, nothing merges silently.
//  Real case that forced it: Skyline roll read as 109 "units" that were
//  beds. (Spine model: unit = door, bed = space inside it.)
//
//  Conservative on purpose:
//   • base must end in a digit, exactly one trailing letter (101A ✓, PH-A ✗)
//   • needs ≥2 distinct letters on the same base
//   • if the base ALSO exists as its own row (101 and 101A) → AMBIGUOUS,
//     skipped and flagged — never guessed
//   • grouped rent = sum of bed rents only when EVERY bed has one;
//     otherwise null (an honest blank beats a wrong confident total)
//  Folded rows go to 'rejected' with a note (trail kept, like rc_pairings);
//  the grouped unit enters as a NEW candidate behind the same human gate.
// ════════════════════════════════════════════════════════════════════
function detectBedGroups(cands) {
  const reviewable = cands.filter(c =>
    ["pending", "ready_for_promotion"].includes(c.decision_status) && c.unit_number);
  const bases = {};
  for (const c of reviewable) {
    const m = String(c.unit_number).trim().match(/^(.*\d)\s*-?\s*([A-Za-z])$/);
    if (!m) continue;
    const base = m[1].trim(), letter = m[2].toUpperCase();
    bases[base] = bases[base] || {};
    if (!bases[base][letter]) bases[base][letter] = c;
  }
  const plain = new Set(reviewable
    .filter(c => !String(c.unit_number).trim().match(/^(.*\d)\s*-?\s*([A-Za-z])$/))
    .map(c => String(c.unit_number).trim()));
  const groups = [], ambiguous = [];
  for (const [base, byLetter] of Object.entries(bases)) {
    const letters = Object.keys(byLetter).sort();
    if (letters.length < 2) continue;
    if (plain.has(base)) {
      ambiguous.push({ base, letters, reason: `"${base}" also exists as its own row — can't tell unit from bed here; needs a human read of the roll` });
      continue;
    }
    const rows = letters.map(l => ({ letter: l, ...pickFields(byLetter[l]) }));
    const rents = rows.map(r => r.market_rent).filter(x => x != null);
    groups.push({
      base, letters, rows,
      proposed: {
        unit_number: base,
        bedrooms: rows.length,
        market_rent: rents.length === rows.length
          ? Number(rents.reduce((s, x) => s + Number(x), 0).toFixed(2)) : null,
      },
    });
  }
  groups.sort((a, b) => a.base.localeCompare(b.base, undefined, { numeric: true }));
  return { groups, ambiguous };
  function pickFields(c) {
    return { id: c.id, unit_number: c.unit_number, bedrooms: c.bedrooms, market_rent: c.market_rent, prov: c.prov };
  }
}

// READ-ONLY preview — identify is not commit
router.get("/ingest/:runId/bed-groups", async (req, res) => {
  try {
    const run = await pool.query("select id from ingest_runs where id=$1", [req.params.runId]);
    if (run.rows.length === 0) return res.status(404).json({ error: "run not found" });
    const cands = (await pool.query(
      "select * from ingest_candidates where run_id=$1", [req.params.runId])).rows;
    const { groups, ambiguous } = detectBedGroups(cands);
    return res.json({
      groups, ambiguous,
      rows_that_would_fold: groups.reduce((s, g) => s + g.rows.length, 0),
      units_that_would_result: groups.length,
      note: "READ-ONLY proposal. These rows look like BEDS of the same units (101A/101B/101C → unit 101 with 3 beds). Nothing changes until a human confirms via POST /ingest/:runId/group-bed-rows { confirm: true }.",
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// APPLY — human-confirmed. Folds bed rows (rejected, trail kept) and
// creates one grouped candidate per unit, still behind the approve gate.
router.post("/ingest/:runId/group-bed-rows", async (req, res) => {
  const { confirm, bases } = req.body || {};
  if (confirm !== true) {
    return res.status(400).json({ error: "confirm: true required — grouping is a human decision, never automatic" });
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const run = await client.query("select id, property_id from ingest_runs where id=$1 for update", [req.params.runId]);
    if (run.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "run not found" }); }
    const cands = (await client.query(
      "select * from ingest_candidates where run_id=$1 for update", [req.params.runId])).rows;
    let { groups } = detectBedGroups(cands);
    if (Array.isArray(bases) && bases.length) groups = groups.filter(g => bases.includes(g.base));
    if (groups.length === 0) {
      await client.query("rollback");
      return res.status(409).json({ error: "nothing to group — no bed-row pattern among reviewable candidates (already grouped, or this roll is by-unit)" });
    }
    const created = [];
    for (const g of groups) {
      for (const r of g.rows) {
        await client.query(
          `update ingest_candidates
              set decision_status='rejected',
                  ai_note = coalesce(ai_note || ' | ', '') || $1
            where id=$2 and decision_status in ('pending','ready_for_promotion')`,
          [`folded into unit ${g.base} as bed ${r.letter} (human-confirmed grouping)`, r.id]);
      }
      const perBed = g.rows.map(r => `${r.letter}${r.market_rent != null ? " $" + Number(r.market_rent).toFixed(2) : " (no rent)"}`).join(", ");
      const ins = await client.query(
        `insert into ingest_candidates
           (run_id, property_id, unit_number, bedrooms, market_rent, prov, ai_note, decision_status)
         values ($1,$2,$3,$4,$5,'assumed',$6,'ready_for_promotion')
         returning id, unit_number, bedrooms, market_rent`,
        [req.params.runId, run.rows[0].property_id, g.proposed.unit_number,
         g.proposed.bedrooms, g.proposed.market_rent,
         `grouped from ${g.rows.length} bed rows — per-bed: ${perBed}` +
         (g.proposed.market_rent == null ? "; unit rent left blank (a bed was missing one)" : "")]);
      created.push(ins.rows[0]);
    }
    await client.query("commit");
    return res.status(201).json({
      receipt: `${groups.reduce((s, g) => s + g.rows.length, 0)} bed rows folded into ${created.length} unit${created.length === 1 ? "" : "s"} — review and approve them like any other proposal`,
      units: created,
      note: "folded rows kept as rejected with a note (the trail); the grouped units are new proposals behind the same human gate, nothing promoted",
    });
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    console.error("group-bed-rows error", e);
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════════
//  PROMOTE — the explicit transition. An approved candidate becomes a real
//  unit, and we RECORD the transition on the candidate: promoted_unit_id,
//  promoted_at, promoted_by, decision_status='promoted'. This is the
//  "Completed Record" end of the loop, applied to ingestion.
//  Promotes only candidates whose decision_status='approved'. Pending/rejected
//  are skipped (a human must approve them first). The unique constraint on
//  units means a re-run that duplicates a number is caught, not silently doubled.
// ════════════════════════════════════════════════════════════════════
router.post("/ingest/:runId/promote", async (req, res) => {
  //  ── THE ACTOR COMES FROM AUTHENTICATION ──────────────────────────
  //  `promoted_by` used to be read from the body: whoever called this
  //  route decided who the record said had done it. Frozen ruling (PR #38):
  //  a body actor field is REJECTED, never ignored — silently dropping it
  //  lets a stale caller keep believing it is honoured.
  //
  //  The session is optional here rather than required, because this route
  //  predates staff sessions and gating it outright would break an unknown
  //  caller outside this repo. What it will not do any more is take the
  //  caller's word for who acted: with a session the human is recorded,
  //  without one the field stays honestly blank.
  if (req.body && req.body.promoted_by !== undefined) {
    return res.status(400).json({
      error: "body_actor_field_rejected", field: "promoted_by",
      receipt: "Who promoted these units comes from the signed-in session, not the request body.",
    });
  }
  try {
    //  Resolving the session is itself a database call. It sat outside this
    //  try, so a transient database error became an unhandled rejection
    //  rather than a 500 the caller can read.
    const promoter = await staffSessions.resolveStaffSession(pool, req.get("x-staff-session"));
    const promoted_by = promoter ? promoter.id : null;
    const run = await pool.query("select id, property_id, model_raw_output from ingest_runs where id=$1", [req.params.runId]);
    if (run.rows.length === 0) return res.status(404).json({ error: "run not found" });
    const propertyId = run.rows[0].property_id;

    const approved = await pool.query(
      "select * from ingest_candidates where run_id=$1 and decision_status='approved'",
      [req.params.runId]
    );

    // ── BY-THE-BED GATE (migration 026) ─────────────────────────────────
    // When the building leases by the bed, the bed count IS the revenue
    // unit. A by-bed unit with blank bedrooms can't bill rent — promoting
    // it would be a wrong confident record. Refuse, name the rows, point
    // at the fix (the candidate edit endpoint). Fail closed, fix inline.
    const basisRow = await pool.query("select leasing_basis from properties where id=$1", [propertyId]);
    if ((basisRow.rows[0]?.leasing_basis || "unknown") === "bed") {
      const noBeds = approved.rows.filter(c => c.bedrooms == null);
      if (noBeds.length) {
        return res.status(409).json({
          error: `this building leases BY THE BED — ${noBeds.length} approved unit(s) have no bed count: ${noBeds.map(c => c.unit_number).join(", ")}. Fill them in (POST /ingest/:runId/candidates/:candidateId/edit) or correct the leasing basis, then promote.`,
          missing_beds: noBeds.map(c => ({ id: c.id, unit_number: c.unit_number })),
        });
      }
    }

    // ── PORTFOLIO PROMOTION GUARDRAIL (precise, fail-closed) ───────────
    // Promotion inserts every unit under the ONE propertyId from the run (see
    // the units insert below). Correct for a single property; for a portfolio
    // it would collapse many subject buildings into one property record. Until
    // per-subject-property mapping exists (address as a first-class candidate
    // column + per-property promote), we block the UNSAFE condition only:
    // candidates that belong to more than one subject property.
    //
    // We do NOT block merely because the planner was used. We block on the real
    // signal — the count of DISTINCT "[address]" tags across approved
    // candidates — and we FAIL CLOSED:
    //   • exactly 1 distinct address  → safe, allow (all units = one property)
    //   • more than 1 distinct address → block (would collapse properties)
    //   • a planned run where we CANNOT confirm exactly one address → block
    //     (ambiguous; we won't promote what we can't prove is single-property)
    // A non-planned single-property run (one-pass, no tags) is unaffected.
    const rawOut = run.rows[0].model_raw_output || "";
    const isPlannedRun = /^\s*\{\s*"mode"\s*:\s*"planned"/.test(rawOut);
    const distinctAddrTags = new Set(
      approved.rows
        .map(c => (c.ai_note || "").match(/^\[([^\]]+)\]/))
        .filter(Boolean)
        .map(m => m[1].trim())
    );
    const addrCount = distinctAddrTags.size;

    // block if: more than one address, OR a planned run we can't confirm as
    // exactly-one-address (addrCount !== 1 means 0 = can't tell, or >1 = multi).
    const blockMultiAddress = addrCount > 1;
    const blockAmbiguousPlanned = isPlannedRun && addrCount !== 1;
    if (blockMultiAddress || blockAmbiguousPlanned) {
      return res.status(409).json({
        error: "Portfolio promotion is blocked until subject-property mapping is implemented. This run has units tied to multiple subject addresses, and promoting now would collapse them into one property.",
        detail: {
          distinct_subject_addresses: addrCount,
          planned_run: isPlannedRun,
          approved_candidates: approved.rows.length,
          reason: blockMultiAddress ? "multiple_subject_addresses" : "planned_run_address_count_unconfirmed",
        },
        what_you_can_do: "Staging and review work normally — candidates are saved and readable. Single-property runs still promote. Portfolio promotion will be enabled once each subject address maps to its own property.",
        blocked: true,
      });
    }
    // ───────────────────────────────────────────────────────────────────

    const promoted = [];
    const skipped = [];
    for (const c of approved.rows) {
      // Each candidate is its own transaction: the unit insert and the
      // candidate's promoted-status update commit together or not at all.
      // This keeps the audit trail and canonical state in sync — a unit can
      // never exist while its candidate still reads 'approved' (which would
      // let a re-run create the unit twice).
      const client = await pool.connect();
      try {
        await client.query("begin");
        const u = await client.query(
          `insert into units (property_id, unit_number, bedrooms, market_rent)
           values ($1,$2,$3,$4) returning *`,
          [propertyId, c.unit_number, c.bedrooms ?? null, c.market_rent ?? null]
        );
        const unit = u.rows[0];  // its space auto-creates via the trigger
        // record the transition on the candidate — explicit, not implied
        await client.query(
          `update ingest_candidates
             set decision_status='promoted', promoted_unit_id=$1,
                 promoted_at=now(), promoted_by=$2
           where id=$3`,
          [unit.id, promoted_by ?? null, c.id]
        );
        await client.query("commit");
        promoted.push({ candidate_id: c.id, unit });
      } catch (e) {
        await client.query("rollback");
        // duplicate unit_number (23505) or other — skip, don't fail the batch
        skipped.push({ candidate_id: c.id, unit_number: c.unit_number,
          reason: e.code === "23505" ? "unit already exists" : e.message });
      } finally {
        client.release();
      }
    }

    res.json({ promoted_count: promoted.length, promoted, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  BULK APPROVE — flip a run's pending candidates to 'approved' in one call,
//  so a human can clear a reviewed batch at once instead of one at a time.
//  This is still a recorded human decision: reviewed_by/reviewed_at are set.
//  It does NOT create units — the explicit /promote step still does that, so
//  the approve→promote separation (and its audit trail) stays intact.
//  Optional body: { candidate_ids: [...] } to approve only specific ones;
//  omit it to approve ALL pending candidates in the run.
// ════════════════════════════════════════════════════════════════════
router.post("/ingest/:runId/approve", async (req, res) => {
  //  Same rule as /promote above: the reviewer is the session, never the body.
  if (req.body && req.body.reviewed_by !== undefined) {
    return res.status(400).json({
      error: "body_actor_field_rejected", field: "reviewed_by",
      receipt: "Who reviewed these candidates comes from the signed-in session, not the request body.",
    });
  }
  const { candidate_ids } = req.body || {};
  try {
    //  Inside the try for the same reason as /promote above: resolving the
    //  session is a database call, and outside it had no handler at all.
    const reviewer = await staffSessions.resolveStaffSession(pool, req.get("x-staff-session"));
    const reviewed_by = reviewer ? reviewer.id : null;
    const run = await pool.query("select id from ingest_runs where id=$1", [req.params.runId]);
    if (run.rows.length === 0) return res.status(404).json({ error: "run not found" });

    let result;
    if (Array.isArray(candidate_ids) && candidate_ids.length) {
      // approve only the named candidates (that are still pending) in this run
      result = await pool.query(
        `update ingest_candidates
           set decision_status='approved', reviewed_by=$1, reviewed_at=now()
         where run_id=$2 and decision_status in ('pending','ready_for_promotion') and id = any($3::uuid[])
         returning id`,
        [reviewed_by ?? null, req.params.runId, candidate_ids]
      );
    } else {
      // approve ALL pending candidates in this run
      result = await pool.query(
        `update ingest_candidates
           set decision_status='approved', reviewed_by=$1, reviewed_at=now()
         where run_id=$2 and decision_status in ('pending','ready_for_promotion')
         returning id`,
        [reviewed_by ?? null, req.params.runId]
      );
    }

    res.json({
      approved_count: result.rows.length,
      note: "Approved (recorded as a human decision). Now POST /ingest/:runId/promote to create units.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
  return router;
}