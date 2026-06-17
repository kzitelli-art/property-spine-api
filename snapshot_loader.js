// ============================================================
// snapshot_loader.js — GENERALIZED Historical Snapshot loader
//
// ONE loader for ALL properties, not six scripts. It handles both leasing
// models via per-property CONFIG:
//   • by UNIT  (Solo, UNO): one '(whole unit)' space per unit row
//   • by BED   (Skyline, Greenery, Nest, 1850): one space per bed row
//
// The schema invariant makes this clean: a lease attaches to a SPACE, never
// a unit. By-unit is just "one space per unit"; by-bed is "many spaces per
// unit." Same writer, same provenance, same anti-fabrication rules.
//
// WHAT VARIES BETWEEN PROPERTIES (captured in CONFIG, not in code forks):
//   • leasing_model: 'unit' | 'bed'
//   • column layout (which column index holds resident, balance, dates…)
//   • resident id format: 't00xxxx' (Solo) vs 's00xxxx'/'STU' (Skyline) —
//     handled by one permissive parser, no per-property logic needed
//   • non-revenue status keywords present: VACANT, MODEL, DOWN
//   • commercial rows (Solo's PLCB liquor store) → lease_status='commercial'
//
// ANTI-FABRICATION (the claim→proof wall — identical for every property):
//   • VACANT / MODEL / DOWN rows → unit + space, but NO person, NO lease.
//     The status is the truth; we record it, we don't invent a tenant.
//   • No resident name → no person. No lease dates → no lease.
//   • Every parsed row written to import_source_rows with its raw cells and
//     the records it produced — full traceability.
//   • Money NOT touched. Maintenance/leads NOT fabricated.
//
// Factory:
//   const snapshotLoader = require('./snapshot_loader');
//   app.use('/', snapshotLoader({ pool, upload }));
// ============================================================

// ── PER-PROPERTY CONFIG ───────────────────────────────────────────────
//   Each property's rent-roll shape. column maps are 0-based indices into
//   the row array produced by sheet_to_json(header:1). Where a property's
//   file embeds the rent roll in a PDF (Greenery/Nest/1850), a future
//   config will carry a different `parser` — the WRITER stays identical.
const CONFIGS = {
  skyline: {
    key: "skyline",
    property_key: "1417",
    property_match: ["skyline", "1417"],
    source_file: "Skyline RentRoll 2026 04 30.xlsx",
    source_as_of_date: "2026-04-30",
    leasing_model: "bed",
    confidence: "confirmed",
    badge: "HISTORICAL SNAPSHOT · Source: Skyline Rent Roll 04/30/2026",
    // by-bed layout: Unit | Room | Bed | UnitType | Resident | SqFt |
    //   Market | Actual | ResDeposit | OtherDeposit | MoveIn | LeaseFrom |
    //   LeaseTo | MoveOut | Balance
    cols: { unit:0, room:1, unit_type:3, resident:4, sqft:5, market:6,
            actual:7, deposit:8, other:9, move_in:10, lease_from:11,
            lease_to:12, move_out:13, balance:14 },
    unit_pattern: /^\d{3,4}-\d{2,3}$/,   // 1417-101
  },
  solo: {
    key: "solo",
    property_key: "4233-CHESTNUT",
    property_match: ["solo", "4233"],
    source_file: "4233_Chesnut_RentRoll_2026_03_31.xlsx",
    source_as_of_date: "2026-03-31",
    leasing_model: "unit",
    confidence: "confirmed",
    badge: "HISTORICAL SNAPSHOT · Source: Solo Rent Roll 03/31/2026",
    // by-unit layout: Unit | UnitType | SqFt | Resident(t#) | Name |
    //   Market | Actual | ResDeposit | OtherDeposit | MoveIn | LeaseEnd |
    //   MoveOut | Balance   (NOTE: Solo has no Room/Bed col, and a separate
    //   Name col after the resident id)
    cols: { unit:0, unit_type:1, sqft:2, resident_id:3, name:4, market:5,
            actual:6, deposit:7, other:8, move_in:9, lease_to:10,
            move_out:11, balance:12 },
    unit_pattern: /^\d{2,4}$/,           // 202, 4233 (comm)
    has_separate_name_col: true,         // resident id and name are separate cols
  },
};

// non-revenue / non-leasable status keywords (any property). These create a
// unit+space but never a person or lease — the status is recorded as truth.
const NON_REVENUE = /^(vacant|model|down)$/i;

module.exports = function snapshotLoader(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool, upload } = deps;
  if (!pool) throw new Error("snapshot_loader requires a pool");

  // ── shared helpers ────────────────────────────────────────────────────
  function num(v) {
    if (v == null || v === "") return null;
    const n = Number(String(v).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  function dt(v) {
    if (!v) return null;
    const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const [_, mo, da, yr] = m;
    return `${yr}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}`;
  }
  // permissive resident parser — handles BOTH "Name (s00xxx)" (Skyline) and
  // a separate id+name pair (Solo). Returns {name, resident_id, status}.
  function parseResident(residentCell, nameCell) {
    // status keyword in the resident cell? (VACANT/MODEL/DOWN)
    const rc = residentCell == null ? "" : String(residentCell).trim();
    if (NON_REVENUE.test(rc)) return { name: null, resident_id: null, status: rc.toUpperCase() };

    // Solo shape: resident cell is the id (t00xxx), name is a separate col
    if (nameCell != null && String(nameCell).trim() && !/^vacant|model|down$/i.test(String(nameCell))) {
      const id = /^[a-z]\d{4,}$/i.test(rc) ? rc : null;
      return { name: String(nameCell).trim(), resident_id: id, status: "occupied" };
    }
    // Skyline shape: "Name (s00xxx)" all in one cell
    const m = rc.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (m) return { name: m[1].trim(), resident_id: m[2].trim(), status: "occupied" };
    if (rc) return { name: rc, resident_id: null, status: "occupied" };
    return { name: null, resident_id: null, status: "vacant_blank" };
  }

  async function resolveProperty(client, cfg) {
    if (cfg.property_key) {
      const r = await client.query(
        "select id from properties where canonical_key = $1", [cfg.property_key]);
      if (r.rows.length) return r.rows[0].id;
    }
    for (const token of cfg.property_match) {
      const r = await client.query(
        `select id from properties
          where lower(name) like '%'||$1||'%' or lower(coalesce(address,'')) like '%'||$1||'%'
          order by created_at limit 1`, [token.toLowerCase()]);
      if (r.rows.length) return r.rows[0].id;
    }
    return null;
  }

  // ── THE WRITER (identical for every property) ─────────────────────────
  //   rows: normalized row objects (produced by the config's parser).
  //   Each row: { row_index, unit_number, room, unit_type, resident_raw,
  //     name, resident_id, status, sqft, market_rent, actual_rent,
  //     deposit, other, move_in, lease_from, lease_to, move_out, balance,
  //     section: 'current'|'future', is_commercial }
  async function loadSnapshot(cfg, rows, { dryRun = false } = {}) {
    if (!Array.isArray(rows) || !rows.length) return { error: "no_rows" };
    const client = await pool.connect();
    try {
      await client.query("begin");
      const propertyId = await resolveProperty(client, cfg);
      if (!propertyId) { await client.query("rollback"); return { error: "property_not_found", property: cfg.key }; }

      const batch = (await client.query(
        `insert into import_batches
           (property_id, source_type, source_file, source_as_of_date,
            leasing_model, confidence, status, notes)
         values ($1,'historical_snapshot',$2,$3,$4,$5,'parsed',$6) returning id`,
        [propertyId, cfg.source_file, cfg.source_as_of_date, cfg.leasing_model,
         cfg.confidence, `${cfg.key} ${cfg.leasing_model}-model rent roll, as of ${cfg.source_as_of_date}, historical snapshot.`]
      )).rows[0];
      const batchId = batch.id;
      const stamp = ["historical_snapshot", cfg.source_as_of_date, cfg.confidence];

      const unitCache = new Map();
      const counts = { units:0, spaces:0, persons:0, leases:0, vacant:0,
                       model:0, down:0, commercial:0, future:0, source_rows:0, skipped:0 };

      async function ensureUnit(unit_number, sqft, market) {
        if (unitCache.has(unit_number)) return unitCache.get(unit_number);
        const u = (await client.query(
          `insert into units (property_id, unit_number, square_feet, market_rent,
             import_batch_id, source_type, source_as_of_date, confidence)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [propertyId, unit_number, sqft, market, batchId, ...stamp])).rows[0];
        unitCache.set(unit_number, u.id);
        counts.units++;
        return u.id;
      }

      for (const r of rows) {
        if (r.skip) { counts.skipped++; continue; }
        counts.source_rows++;
        const isFuture = r.section === "future";
        if (isFuture) counts.future++;

        const status = (r.status || "occupied").toLowerCase();
        const nonRevenue = NON_REVENUE.test(status);
        if (status === "vacant" || status === "vacant_blank") counts.vacant++;
        else if (status === "model") counts.model++;
        else if (status === "down") counts.down++;

        // unit + space (always, even for vacant/model/down — the space exists)
        let unitId = null, spaceId = null;
        if (r.unit_number) {
          unitId = await ensureUnit(r.unit_number, num(r.sqft), num(r.market_rent));
          const label = cfg.leasing_model === "bed"
            ? ([r.room, r.resident_id].filter(Boolean).join(" · ") || "(bed)")
            : "(whole unit)";
          spaceId = (await client.query(
            `insert into spaces (unit_id, space_label, import_batch_id,
               source_type, source_as_of_date, confidence)
             values ($1,$2,$3,$4,$5,$6) returning id`,
            [unitId, label, batchId, ...stamp])).rows[0].id;
          counts.spaces++;
        }

        // person + lease only when occupied (or future) AND not non-revenue
        let personId = null, leaseId = null;
        if (!nonRevenue && r.name) {
          personId = (await client.query(
            `insert into persons (name, lifecycle_status, leasing_stage, source,
               import_batch_id, source_type, source_as_of_date, confidence)
             values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
            [r.name,
             isFuture ? "applicant" : "tenant",
             isFuture ? "future_resident" : "current_resident",
             "historical_snapshot", batchId, ...stamp])).rows[0].id;
          counts.persons++;

          if (spaceId && (dt(r.lease_from) || dt(r.lease_to))) {
            const leaseStatus = r.is_commercial ? "commercial" : (isFuture ? "pending" : "active");
            if (r.is_commercial) counts.commercial++;
            leaseId = (await client.query(
              `insert into leases (property_id, space_id, tenant_ids, rent, balance,
                 start_date, end_date, lease_status,
                 import_batch_id, source_type, source_as_of_date, confidence)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
              [propertyId, spaceId, [personId], num(r.actual_rent), num(r.balance) ?? 0,
               dt(r.lease_from), dt(r.lease_to), leaseStatus,
               batchId, ...stamp])).rows[0].id;
            counts.leases++;
          }
        }

        await client.query(
          `insert into import_source_rows (import_batch_id, row_index, raw,
             produced_unit_id, produced_space_id, produced_person_id, produced_lease_id, parse_note)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [batchId, r.row_index ?? null, JSON.stringify(r),
           unitId, spaceId, personId, leaseId,
           nonRevenue ? `${status.toUpperCase()} — no person/lease created`
                      : r.is_commercial ? "commercial lease"
                      : isFuture ? "future resident/applicant" : "current resident"]);
      }

      if (dryRun) {
        await client.query("rollback");
        return { dry_run: true, property: cfg.key, would_have: counts,
                 source_file: cfg.source_file, as_of: cfg.source_as_of_date };
      }
      await client.query("update import_batches set status='committed', updated_at=now() where id=$1", [batchId]);
      await client.query("commit");
      return {
        ok: true, property: cfg.key, import_batch_id: batchId, property_id: propertyId,
        source_type: "historical_snapshot", source_file: cfg.source_file,
        source_as_of_date: cfg.source_as_of_date, leasing_model: cfg.leasing_model,
        confidence: cfg.confidence, loaded: counts, badge: cfg.badge,
        not_loaded: {
          money: "not touched — separate Money snapshot track (workbooks, bank statements, AP aging, recs)",
          maintenance: "no work orders in a rent roll — not fabricated",
          leads: "no leasing pipeline in a rent roll — not fabricated",
        },
      };
    } catch (e) {
      await client.query("rollback");
      console.error(`${cfg.key} snapshot load error:`, e);
      return { error: "load_failed", detail: e.message };
    } finally {
      client.release();
    }
  }

  // ── PARSERS (one per file shape; both feed the same writer) ───────────
  function parseXlsx(cfg, buffer) {
    const XLSX = require("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
    const c = cfg.cols;
    const out = [];
    let section = "current", rowIndex = 0;
    const joined = (a) => a.map(x => x == null ? "" : String(x)).join(" ").toLowerCase();

    for (const raw of grid) {
      if (!Array.isArray(raw)) continue;
      const j = joined(raw);
      if (j.includes("future residents")) { section = "future"; continue; }
      if (j.includes("total:") || j.includes("summary groups") ||
          (j.includes("square") && j.includes("footage") && j.includes("occupancy"))) {
        section = "total"; continue;
      }
      if (section === "total") continue;
      // skip repeated header rows
      if (j.includes("unit") && j.includes("resident") && j.includes("market") &&
          !cfg.unit_pattern.test(String(raw[c.unit] ?? "").trim())) continue;

      const unitCell = raw[c.unit];
      const unitStr = unitCell == null ? "" : String(unitCell).trim();
      const hasUnit = cfg.unit_pattern.test(unitStr);
      const residentCell = raw[c.resident != null ? c.resident : c.resident_id];
      const nameCell = cfg.has_separate_name_col ? raw[c.name] : null;
      const residentStr = residentCell == null ? "" : String(residentCell).trim();

      // a data row needs a unit OR a resident/status
      if (!hasUnit && !residentStr) continue;

      rowIndex++;
      const pr = parseResident(residentCell, nameCell);
      const is_commercial = /comm/i.test(String(raw[c.unit_type] ?? "")) ||
                            /^\d{4}$/.test(unitStr) && /comm/i.test(j);

      out.push({
        row_index: rowIndex,
        unit_number: hasUnit ? unitStr : null,
        room: c.room != null ? (raw[c.room] != null ? String(raw[c.room]).trim() : null) : null,
        unit_type: raw[c.unit_type] != null ? String(raw[c.unit_type]).trim() : null,
        resident_raw: residentStr,
        name: pr.name,
        resident_id: pr.resident_id,
        status: pr.status,
        sqft: raw[c.sqft],
        market_rent: raw[c.market],
        actual_rent: raw[c.actual],
        deposit: raw[c.deposit],
        other: raw[c.other],
        move_in: raw[c.move_in],
        lease_from: c.lease_from != null ? raw[c.lease_from] : null,
        lease_to: raw[c.lease_to],
        move_out: raw[c.move_out],
        balance: raw[c.balance],
        section,
        is_commercial,
      });
    }
    return out;
  }

  // ── ENDPOINTS ─────────────────────────────────────────────────────────
  //   POST /snapshot/:property/upload   (multipart 'file' = the .xlsx)
  //   ?dryRun=1 previews counts without writing.
  if (upload) {
    router.post("/snapshot/:property/upload", upload.single("file"), async (req, res) => {
      const cfg = CONFIGS[String(req.params.property || "").toLowerCase()];
      if (!cfg) return res.status(404).json({ error: "unknown_property", known: Object.keys(CONFIGS) });
      if (cfg.parser && cfg.parser !== "xlsx")
        return res.status(400).json({ error: "non_xlsx_property", detail: `${cfg.key} uses ${cfg.parser}; not wired yet` });
      try {
        if (!req.file?.buffer) return res.status(400).json({ receipt: "No file. Send the .xlsx as form field 'file'." });
        const parsed = parseXlsx(cfg, req.file.buffer);
        const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
        const out = await loadSnapshot(cfg, parsed, { dryRun });
        if (out.error) return res.status(out.error === "property_not_found" ? 404 : 400).json(out);
        res.status(dryRun ? 200 : 201).json({ parsed_rows: parsed.length, ...out });
      } catch (e) {
        console.error("snapshot upload error:", e);
        res.status(500).json({ error: "upload_failed", detail: e.message });
      }
    });
  }

  // POST /snapshot/:property/load  body { rows:[...], dryRun? } — parsed rows directly
  router.post("/snapshot/:property/load", async (req, res) => {
    const cfg = CONFIGS[String(req.params.property || "").toLowerCase()];
    if (!cfg) return res.status(404).json({ error: "unknown_property", known: Object.keys(CONFIGS) });
    try {
      const { rows, dryRun } = req.body || {};
      const out = await loadSnapshot(cfg, rows, { dryRun: !!dryRun });
      if (out.error) return res.status(out.error === "property_not_found" ? 404 : 400).json(out);
      res.status(dryRun ? 200 : 201).json(out);
    } catch (e) {
      res.status(500).json({ error: "endpoint_failed", detail: e.message });
    }
  });

  // GET /snapshot/batches/:property_id — import batches for a property
  router.get("/snapshot/batches/:property_id", async (req, res) => {
    try {
      const r = await pool.query(
        `select id, source_type, source_file, source_as_of_date, leasing_model,
                confidence, status, loaded_at,
                (select count(*) from import_source_rows s where s.import_batch_id = b.id)::int as source_rows
           from import_batches b where property_id = $1 order by loaded_at desc`, [req.params.property_id]);
      res.json({ property_id: req.params.property_id, batches: r.rows });
    } catch (e) { res.status(500).json({ error: "batches_read_failed", detail: e.message }); }
  });

  // GET /snapshot/batch/:batch_id/rows — row-level audit trail
  router.get("/snapshot/batch/:batch_id/rows", async (req, res) => {
    try {
      const r = await pool.query(
        `select row_index, raw, produced_unit_id, produced_space_id,
                produced_person_id, produced_lease_id, parse_note
           from import_source_rows where import_batch_id = $1 order by row_index`, [req.params.batch_id]);
      res.json({ import_batch_id: req.params.batch_id, rows: r.rows });
    } catch (e) { res.status(500).json({ error: "rows_read_failed", detail: e.message }); }
  });

  router.helpers = { loadSnapshot, parseXlsx, parseResident, num, dt, CONFIGS };
  return router;
};
