// ============================================================
// snapshot_loader.js — generalized sourced rent-roll import + read
//
// One import shape, one property-scoped projection. Production, Solo QA,
// Demo Building, and other properties use the same service path; only the
// server-derived property context and source data differ.
//
// Permanent primitives:
//   • import batch + raw source-row provenance
//   • inventory-first unit/space model
//   • current/future lease distinction
//   • session-scoped /operator/rent-roll read
//
// Temporary input adapter:
//   • normalized JSON rows generated from the June reporting package
// Replacement condition: direct parser for the canonical source export.
// ============================================================

const staffSessions = require("../identity/staff_session_service.js");
//  Build 1A-2: the ONE contained property resolver. Recognition proposes;
//  ambiguity refuses and names its candidates.
const { resolvePropertyForImport, resolutionError } = require("../identity/property_resolution_service.js");
//  Build 1A-2 (ruling): the fixture doors below inject synthetic rent
//  rolls from a CONFIG KEY. Authentication is not the question — where
//  synthetic data may land is. The canonical signed-in importer
//  (/operator/rent-roll/import) is deliberately NOT behind this.
const { syntheticTargetAllowed, syntheticRefusal } = require("./synthetic_data_perimeter.js");
const { spacePosition } = require("../tenancy/space_position");

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
    cols: { unit:0, room:1, unit_type:3, resident:4, sqft:5, market:6,
            actual:7, deposit:8, other:9, move_in:10, lease_from:11,
            lease_to:12, move_out:13, balance:14 },
    unit_pattern: /^\d{3,4}-\d{2,3}$/,
  },
  solo: {
    key: "solo",
    property_key: "4233-CHESTNUT",
    property_match: ["solo", "4233"],
    source_file: "4233 Chestnut - Monthly Report - 2026 06.pdf",
    source_as_of_date: "2026-06-30",
    leasing_model: "unit",
    confidence: "confirmed",
    badge: "SOURCED SNAPSHOT · Solo rent roll 06/30/2026",
    cols: { unit:0, unit_type:1, sqft:2, resident_id:3, name:4, market:5,
            actual:6, deposit:7, other:8, move_in:9, lease_to:10,
            move_out:11, balance:12 },
    unit_pattern: /^\d{2,4}$/,
    has_separate_name_col: true,
  },
};

const NON_REVENUE = /^(vacant|model|down|offline)$/i;
const OCCUPIED_STATUSES = new Set(["current", "occupied", "notice", "commercial"]);
const IMPORT_ROLES = new Set(["admin", "owner", "manager", "property_manager", "leasing_manager"]);

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function dt(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && Number.isFinite(v) && v > 20000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function cleanStatus(v, section) {
  const s = String(v || "").trim().toLowerCase();
  if (section === "future" || s === "future" || s === "pending") return "future";
  if (/model/.test(s)) return "model";
  if (/down|offline/.test(s)) return "down";
  if (/vacant|vacant_blank/.test(s)) return "vacant";
  if (/notice/.test(s)) return "notice";
  if (/commercial|comm/.test(s)) return "commercial";
  if (/current|occupied|active/.test(s)) return "current";
  return s || "current";
}

function normalizeRow(raw, rowIndex = 0) {
  const section = String(raw?.section || "current").toLowerCase() === "future" ? "future" : "current";
  const status = cleanStatus(raw?.status || raw?.resident_raw || raw?.resident_id, section);
  const unit = String(raw?.unit_number ?? raw?.unit ?? "").trim();
  const residentName = raw?.name ?? raw?.resident_name ?? raw?.resident ?? null;
  const nonRevenue = NON_REVENUE.test(status);
  return {
    row_index: raw?.row_index ?? rowIndex + 1,
    unit_number: unit || null,
    room: raw?.room == null ? null : String(raw.room).trim(),
    space_label: raw?.space_label == null ? null : String(raw.space_label).trim(),
    unit_type: raw?.unit_type ?? raw?.type ?? null,
    resident_raw: raw?.resident_raw ?? raw?.resident_id ?? residentName ?? status,
    name: nonRevenue ? null : (residentName == null ? null : String(residentName).trim()),
    resident_id: nonRevenue ? null : (raw?.resident_id == null ? null : String(raw.resident_id).trim()),
    status,
    sqft: num(raw?.sqft),
    market_rent: num(raw?.market_rent ?? raw?.market),
    actual_rent: num(raw?.actual_rent ?? raw?.rent),
    deposit: num(raw?.deposit),
    other: num(raw?.other ?? raw?.other_deposit),
    move_in: dt(raw?.move_in),
    lease_from: dt(raw?.lease_from ?? raw?.start_date ?? raw?.move_in),
    lease_to: dt(raw?.lease_to ?? raw?.lease_end ?? raw?.end_date),
    move_out: dt(raw?.move_out),
    balance: num(raw?.balance) ?? 0,
    section,
    is_commercial: Boolean(raw?.is_commercial) || status === "commercial" || /comm/i.test(String(raw?.unit_type ?? raw?.type ?? "")),
  };
}

function parseResident(residentCell, nameCell) {
  const rc = residentCell == null ? "" : String(residentCell).trim();
  if (NON_REVENUE.test(rc)) return { name: null, resident_id: null, status: cleanStatus(rc, "current") };
  if (nameCell != null && String(nameCell).trim() && !NON_REVENUE.test(String(nameCell))) {
    const id = /^[a-z]\d{4,}$/i.test(rc) ? rc : null;
    return { name: String(nameCell).trim(), resident_id: id, status: "current" };
  }
  const m = rc.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { name: m[1].trim(), resident_id: m[2].trim(), status: "current" };
  if (rc) return { name: rc, resident_id: null, status: "current" };
  return { name: null, resident_id: null, status: "vacant" };
}

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
    if (j.includes("unit") && j.includes("resident") && j.includes("market") &&
        !cfg.unit_pattern.test(String(raw[c.unit] ?? "").trim())) continue;

    const unitStr = raw[c.unit] == null ? "" : String(raw[c.unit]).trim();
    const hasUnit = cfg.unit_pattern.test(unitStr);
    const residentCell = raw[c.resident != null ? c.resident : c.resident_id];
    const nameCell = cfg.has_separate_name_col ? raw[c.name] : null;
    const residentStr = residentCell == null ? "" : String(residentCell).trim();
    if (!hasUnit && !residentStr) continue;

    rowIndex++;
    const pr = parseResident(residentCell, nameCell);
    out.push(normalizeRow({
      row_index: rowIndex,
      unit_number: hasUnit ? unitStr : null,
      room: c.room != null ? raw[c.room] : null,
      unit_type: raw[c.unit_type],
      resident_raw: residentStr,
      name: pr.name,
      resident_id: pr.resident_id,
      status: section === "future" ? "future" : pr.status,
      sqft: raw[c.sqft], market_rent: raw[c.market], actual_rent: raw[c.actual],
      deposit: raw[c.deposit], other: raw[c.other], move_in: raw[c.move_in],
      lease_from: c.lease_from != null ? raw[c.lease_from] : raw[c.move_in],
      lease_to: raw[c.lease_to], move_out: raw[c.move_out], balance: raw[c.balance],
      section,
      is_commercial: /comm/i.test(String(raw[c.unit_type] ?? "")) || (/^\d{4}$/.test(unitStr) && /comm/i.test(j)),
    }, rowIndex - 1));
  }
  return out;
}

function snapshotMeta(cfg, options) {
  return {
    source_file: options.sourceFile || cfg.source_file,
    source_as_of_date: options.sourceAsOfDate || cfg.source_as_of_date,
    leasing_model: options.leasingModel || cfg.leasing_model,
    confidence: options.confidence || cfg.confidence || "confirmed",
    source_label: options.sourceLabel || cfg.badge || null,
  };
}

function stableSpaceLabel(cfg, row) {
  if (cfg.leasing_model === "unit") return "(whole unit)";
  return row.space_label || row.room || "(bed)";
}

//  ── BUILD 1A-2: RECOGNITION MAY PROPOSE. IT MAY NOT CHOOSE. ─────────
//  This was a substring match on name OR address, `order by created_at
//  limit 1` — the oldest row wins, silently. Whatever it returned then
//  received an entire rent roll: units, spaces, leases, persons, dated
//  ledger evidence. A roll landing on the wrong building looked exactly
//  like a roll landing on the right one.
//
//  registry.js exists because that is not safe ("SOLO on Chestnut" means
//  both 4125 and 4233). Resolution now goes through the one contained
//  resolver, which resolves on identity and REFUSES on ambiguity, naming
//  what it saw. Every live caller already passes an explicit
//  targetPropertyId, so nothing that works today starts failing.
async function resolveProperty(client, cfg) {
  return resolvePropertyForImport(client, {
    canonical_key: cfg.property_key || null,
    match_tokens: cfg.property_match || [],
  });
}

//  The property a fixture CONFIG would resolve to, or null if resolution
//  was anything less than clean. Null is refused by the perimeter, so a
//  proposal or an ambiguity can never become a write target.
async function resolveConfiguredTarget(db, cfg) {
  const res = await resolvePropertyForImport(db, {
    canonical_key: cfg.property_key || null,
    match_tokens: cfg.property_match || [],
  });
  return res.status === "resolved" ? res.property_id : null;
}

async function loadSnapshot(pool, cfg, inputRows, options = {}) {
  const rows = (Array.isArray(inputRows) ? inputRows : []).map(normalizeRow).filter(r => r.unit_number);
  if (!rows.length) return { error: "no_rows" };
  const meta = snapshotMeta(cfg, options);
  const client = await pool.connect();
  try {
    await client.query("begin");
    let propertyId = options.targetPropertyId || null;
    if (!propertyId) {
      const res = await resolveProperty(client, cfg);
      if (res.status !== "resolved") {
        await client.query("rollback");
        return { ...resolutionError(res), property: cfg.key };
      }
      propertyId = res.property_id;
    }

    if (!options.force) {
      const prior = await client.query(
        `select id from import_batches
          where property_id=$1 and source_type='historical_snapshot'
            and source_file=$2 and source_as_of_date=$3 and status='committed'
          order by loaded_at desc limit 1`,
        [propertyId, meta.source_file, meta.source_as_of_date]
      );
      if (prior.rows.length) {
        await client.query("rollback");
        return { ok:true, idempotent:true, already_loaded:true, property_id:propertyId,
                 import_batch_id:prior.rows[0].id, source_file:meta.source_file,
                 source_as_of_date:meta.source_as_of_date, parsed_rows:rows.length };
      }
    }

    const batch = (await client.query(
      `insert into import_batches
         (property_id, source_type, source_file, source_as_of_date,
          leasing_model, confidence, status, notes)
       values ($1,'historical_snapshot',$2,$3,$4,$5,'parsed',$6) returning id`,
      [propertyId, meta.source_file, meta.source_as_of_date, meta.leasing_model,
       meta.confidence, options.notes || `${cfg.key} sourced rent roll; ${rows.length} normalized rows; ${meta.source_label || ""}`]
    )).rows[0];
    const batchId = batch.id;
    const stamp = ["historical_snapshot", meta.source_as_of_date, meta.confidence];
    const unitCache = new Map();
    const spaceCache = new Map();
    const counts = { units_created:0, units_reused:0, spaces_created:0, spaces_reused:0,
                     persons_created:0, leases_created:0, leases_reused:0,
                     current_rows:0, future_rows:0, vacant:0, model:0, down:0,
                     commercial:0, source_rows:0, skipped:0 };

    async function ensureUnit(row) {
      if (unitCache.has(row.unit_number)) return unitCache.get(row.unit_number);
      const existing = await client.query(
        "select id from units where property_id=$1 and unit_number=$2 limit 1",
        [propertyId, row.unit_number]
      );
      let id;
      if (existing.rows.length) {
        id = existing.rows[0].id;
        await client.query(
          `update units set square_feet=coalesce($3,square_feet), market_rent=coalesce($4,market_rent),
             import_batch_id=$5, source_type=$6, source_as_of_date=$7, confidence=$8
           where id=$1 and property_id=$2`,
          [id, propertyId, row.sqft, row.market_rent, batchId, ...stamp]
        );
        counts.units_reused++;
      } else {
        id = (await client.query(
          `insert into units (property_id, unit_number, square_feet, market_rent,
             import_batch_id, source_type, source_as_of_date, confidence)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [propertyId, row.unit_number, row.sqft, row.market_rent, batchId, ...stamp]
        )).rows[0].id;
        counts.units_created++;
      }
      unitCache.set(row.unit_number, id);
      return id;
    }

    async function ensureSpace(unitId, row) {
      const label = stableSpaceLabel(cfg, row);
      const cacheKey = `${unitId}|${label}`;
      if (spaceCache.has(cacheKey)) return spaceCache.get(cacheKey);
      const existing = await client.query(
        "select id from spaces where unit_id=$1 and space_label=$2 limit 1",
        [unitId, label]
      );
      let id;
      if (existing.rows.length) {
        id = existing.rows[0].id;
        await client.query(
          `update spaces set import_batch_id=$2, source_type=$3, source_as_of_date=$4, confidence=$5 where id=$1`,
          [id, batchId, ...stamp]
        );
        counts.spaces_reused++;
      } else {
        id = (await client.query(
          `insert into spaces (unit_id, space_label, import_batch_id, source_type, source_as_of_date, confidence)
           values ($1,$2,$3,$4,$5,$6) returning id`,
          [unitId, label, batchId, ...stamp]
        )).rows[0].id;
        counts.spaces_created++;
      }
      spaceCache.set(cacheKey, id);
      return id;
    }

    async function findLease(spaceId, row, leaseStatus) {
      if (!row.name) return null;
      const q = await client.query(
        `select l.id
           from leases l
           left join lateral (
             select p.name from persons p where p.id = any(l.tenant_ids) limit 1
           ) tp on true
          where l.property_id=$1 and l.space_id=$2 and l.lease_status=$3
            and coalesce(l.start_date::text,'')=coalesce($4::text,'')
            and coalesce(l.end_date::text,'')=coalesce($5::text,'')
            and lower(coalesce(tp.name,''))=lower($6)
          limit 1`,
        [propertyId, spaceId, leaseStatus, row.lease_from, row.lease_to, row.name]
      );
      return q.rows[0]?.id || null;
    }

    for (const row of rows) {
      counts.source_rows++;
      if (row.section === "future") counts.future_rows++; else counts.current_rows++;
      if (row.status === "vacant") counts.vacant++;
      if (row.status === "model") counts.model++;
      if (row.status === "down") counts.down++;
      if (row.is_commercial) counts.commercial++;

      const unitId = await ensureUnit(row);
      const spaceId = await ensureSpace(unitId, row);
      const nonRevenue = NON_REVENUE.test(row.status);
      let personId = null, leaseId = null;

      if (!nonRevenue && row.name && (row.lease_from || row.lease_to)) {
        const leaseStatus = row.is_commercial ? "commercial" : (row.section === "future" ? "pending" : "active");
        leaseId = await findLease(spaceId, row, leaseStatus);
        if (leaseId) {
          await client.query(
            `update leases set rent=$2, balance=$3, import_batch_id=$4, source_type=$5,
               source_as_of_date=$6, confidence=$7 where id=$1`,
            [leaseId, row.actual_rent, row.balance, batchId, ...stamp]
          );
          counts.leases_reused++;
        } else {
          personId = (await client.query(
            `insert into persons (name, lifecycle_status, leasing_stage, source,
               import_batch_id, source_type, source_as_of_date, confidence)
             values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
            [row.name, row.section === "future" ? "applicant" : "tenant",
             row.section === "future" ? "future_resident" : "current_resident",
             "historical_snapshot", batchId, ...stamp]
          )).rows[0].id;
          counts.persons_created++;
          leaseId = (await client.query(
            `insert into leases (property_id, space_id, tenant_ids, rent, balance,
               start_date, end_date, lease_status,
               import_batch_id, source_type, source_as_of_date, confidence)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
            [propertyId, spaceId, [personId], row.actual_rent, row.balance,
             row.lease_from, row.lease_to, leaseStatus, batchId, ...stamp]
          )).rows[0].id;
          counts.leases_created++;
        }
      }

      await client.query(
        `insert into import_source_rows (import_batch_id, row_index, raw,
           produced_unit_id, produced_space_id, produced_person_id, produced_lease_id, parse_note)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [batchId, row.row_index, JSON.stringify(row), unitId, spaceId, personId, leaseId,
         nonRevenue ? `${row.status.toUpperCase()} — inventory exists; no person or lease fabricated`
                    : row.section === "future" ? "future contractual intent"
                    : row.is_commercial ? "commercial current lease"
                    : "current resident row"]
      );
    }

    if (options.dryRun) {
      await client.query("rollback");
      return { dry_run:true, property:cfg.key, property_id:propertyId, would_have:counts,
               source_file:meta.source_file, source_as_of_date:meta.source_as_of_date };
    }

    await client.query("update import_batches set status='committed', updated_at=now() where id=$1", [batchId]);
    await client.query("commit");
    return { ok:true, property:cfg.key, property_id:propertyId, import_batch_id:batchId,
             source_type:"historical_snapshot", source_file:meta.source_file,
             source_as_of_date:meta.source_as_of_date, leasing_model:meta.leasing_model,
             confidence:meta.confidence, loaded:counts, badge:meta.source_label };
  } catch (e) {
    await client.query("rollback");
    console.error(`${cfg.key} snapshot load error:`, e);
    return { error:"load_failed", detail:e.message };
  } finally {
    client.release();
  }
}

function summarizeRows(rows) {
  const current = rows.filter(r => r.section !== "future");
  const future = rows.filter(r => r.section === "future");
  const occupied = current.filter(r => OCCUPIED_STATUSES.has(r.status));
  const vacant = current.filter(r => r.status === "vacant");
  const nonRevenue = current.filter(r => r.status === "model" || r.status === "down");
  const owed = current.filter(r => Number(r.balance) > 0);
  const credits = current.filter(r => Number(r.balance) < 0);
  const inventory = current.length;
  const revenueInventory = Math.max(0, inventory - nonRevenue.length);
  return {
    inventory,
    current_rows: current.length,
    future_rows: future.length,
    occupied: occupied.length,
    vacant: vacant.length,
    non_revenue: nonRevenue.length,
    model: current.filter(r => r.status === "model").length,
    down: current.filter(r => r.status === "down").length,
    current_occupancy_pct: inventory ? Math.round(occupied.length / inventory * 10000) / 100 : null,
    leasable_occupancy_pct: revenueInventory ? Math.round(occupied.length / revenueInventory * 10000) / 100 : null,
    future_commitments: future.length,
    gross_ar_owed: Math.round(owed.reduce((s,r)=>s+Number(r.balance||0),0)*100)/100,
    credits_prepaid: Math.round(Math.abs(credits.reduce((s,r)=>s+Number(r.balance||0),0))*100)/100,
    accounts_owing: owed.length,
  };
}

function availabilityProjection(rows, positions, asOf) {
  const currentByUnit = new Map();
  const futureByUnit = new Map();
  for (const row of rows) {
    if (!row.unit_number) continue;
    if (row.section === "future") {
      if (!futureByUnit.has(row.unit_number)) futureByUnit.set(row.unit_number, []);
      futureByUnit.get(row.unit_number).push(row);
    } else if (!currentByUnit.has(row.unit_number)) {
      currentByUnit.set(row.unit_number, row);
    }
  }
  const positionByUnit = new Map();
  for (const p of positions || []) if (!positionByUnit.has(String(p.unit_number))) positionByUnit.set(String(p.unit_number), p);

  const out = [];
  for (const [unit, cur] of currentByUnit.entries()) {
    const fut = futureByUnit.get(unit) || [];
    const pos = positionByUnit.get(unit) || null;
    const committed = fut.length > 0;
    const status = cur.status;
    const contractualOpenNow = status === "vacant" && !committed;
    const contractualOpenForward = status === "notice" && !committed;
    const nonRevenue = status === "model" || status === "down";
    const readiness = pos?.physical_readiness || "unknown";
    const possession = pos?.current_possession ? "possessed" : (pos ? "not_possessed" : "unknown");
    let state = "occupied";
    if (nonRevenue) state = `blocked_${status}`;
    else if (committed) state = "committed_future";
    else if (status === "vacant" && readiness === "ready") state = "ready_now";
    else if (status === "vacant") state = "vacant_readiness_unknown";
    else if (status === "notice") state = "on_notice_uncommitted";
    const availableFrom = status === "vacant" ? asOf : (cur.move_out || cur.lease_to || null);
    out.push({
      unit_number: unit,
      unit_type: cur.unit_type || null,
      current_status: status,
      current_resident: cur.name || null,
      market_rent: cur.market_rent,
      actual_rent: cur.actual_rent,
      lease_end: cur.lease_to,
      move_out: cur.move_out,
      future_commitments: fut.map(r => ({ resident_name:r.name, start_date:r.lease_from || r.move_in, end_date:r.lease_to, balance:r.balance })),
      committed,
      contractual_open_now: contractualOpenNow,
      contractual_open_forward: contractualOpenForward,
      physical_readiness: readiness,
      possession_status: possession,
      availability_state: state,
      available_from: availableFrom,
      marketable_now: contractualOpenNow && readiness === "ready" && possession !== "possessed",
      next_required_action: pos?.next_required_action || (state === "vacant_readiness_unknown" ? "confirm_physical_readiness" : null),
      position_reason: pos?.reason || null,
    });
  }
  return out.sort((a,b) => String(a.unit_number).localeCompare(String(b.unit_number), undefined, {numeric:true}));
}



async function loadLedgerSnapshot(pool, inputRows, options = {}) {
  //  ── EVIDENCE RECORDS WHAT ARRIVED, INCLUDING WHAT WE COULD NOT USE ──
  //  This used to be `.filter(r => r.unit_number)`, which DISCARDED any row
  //  the loader could not place. That is silent: the batch then claims to
  //  be the source, and a row the file genuinely contained is nowhere —
  //  so "no unit number on line 47" is unanswerable afterwards.
  //
  //  Both lists are kept. Usable rows produce units, spaces and positions
  //  exactly as before; unusable ones are still written as evidence, with
  //  a parse_note and no produced objects. Nothing about the placeable
  //  rows changes, which is why this is safe to do underneath the existing
  //  callers.
  //  `normalizeRow` returns a FIXED shape and drops every key it does not
  //  know — including `_source_cells`, the caller's original spreadsheet
  //  cells. Carrying it across explicitly is what lets evidence hold what
  //  the document actually said, not only our reading of it. (Without
  //  this, "which of your columns did we read as rent" is unanswerable
  //  the moment the page is reloaded.)
  const allRows = (Array.isArray(inputRows) ? inputRows : []).map((raw, i) => {
    const n = normalizeRow(raw, i);
    if (raw && raw._source_cells) n._source_cells = raw._source_cells;
    return n;
  });
  const rows     = allRows.filter(r => r.unit_number);
  const unusable = allRows.filter(r => !r.unit_number);
  if (!rows.length) return { error:"no_rows" };

  //  ── ONE TRANSACTION, WHEN THE CALLER NEEDS ONE ──────────────────────
  //  Activation stores an artifact, writes this batch and stages its
  //  proposals as a single act; a batch that survives a failed staging is
  //  evidence for a decision nobody ever made. When `options.client` is
  //  supplied the caller owns begin/commit and this manages neither.
  const borrowed = options.client || null;
  const client   = borrowed || await pool.connect();
  try {
    if (!borrowed) await client.query("begin");
    let propertyId = options.targetPropertyId || null;
    if (!propertyId) {
      if (!options.propertyConfig) {
        if (!borrowed) await client.query("rollback");
        return { error: "property_not_found", property: "session_scoped",
                 receipt: "No property was supplied and none could be derived from the session." };
      }
      const res = await resolveProperty(client, options.propertyConfig);
      if (res.status !== "resolved") {
        if (!borrowed) await client.query("rollback");
        return { ...resolutionError(res), property: "session_scoped" };
      }
      propertyId = res.property_id;
    }
    const sourceFile = options.sourceFile || "Rent roll ledger export";
    const sourceAsOfDate = dt(options.sourceAsOfDate);
    if (!sourceAsOfDate) { if (!borrowed) await client.query("rollback"); return { error:"valid_source_as_of_date_required" }; }
    const prior = await client.query(
      `select id from import_batches
        where property_id=$1 and source_type='rent_roll_ledger'
          and source_file=$2 and source_as_of_date=$3 and status='committed'
        order by loaded_at desc limit 1`, [propertyId, sourceFile, sourceAsOfDate]
    );
    if (prior.rows.length && !options.force) {
      if (!borrowed) await client.query("rollback");
      return { ok:true, idempotent:true, already_loaded:true, property_id:propertyId,
               import_batch_id:prior.rows[0].id, source_file:sourceFile,
               source_as_of_date:sourceAsOfDate, parsed_rows:rows.length };
    }
    const batch = (await client.query(
      `insert into import_batches
         (property_id, source_type, source_file, source_as_of_date,
          leasing_model, confidence, status, notes, source_artifact_id)
       values ($1,'rent_roll_ledger',$2,$3,$4,$5,'parsed',$6,$7) returning id`,
      [propertyId, sourceFile, sourceAsOfDate, options.leasingModel || "unit",
       options.confidence || "confirmed",
       options.notes || `Dated rent-roll ledger evidence; ${rows.length} normalized rows. No person or lease records fabricated.`,
       //  The retained file this batch was read from (migration 153/156).
       //  Null for every legacy caller, which is honest: they had only a
       //  filename, and a filename is not a file.
       options.sourceArtifactId || null]
    )).rows[0];
    const batchId=batch.id, unitCache=new Map(), spaceCache=new Map();
    const counts={source_rows:0,units_created:0,units_reused:0,spaces_created:0,spaces_reused:0,current_rows:0,future_rows:0};
    for (const row of rows) {
      counts.source_rows++; if(row.section==='future') counts.future_rows++; else counts.current_rows++;
      let unitId=unitCache.get(row.unit_number);
      if(!unitId){
        const q=await client.query("select id from units where property_id=$1 and unit_number=$2 limit 1",[propertyId,row.unit_number]);
        if(q.rows.length){ unitId=q.rows[0].id; counts.units_reused++; await client.query(
          `update units set square_feet=coalesce($3,square_feet),market_rent=coalesce($4,market_rent),
             import_batch_id=$5,source_type='rent_roll_ledger',source_as_of_date=$6,confidence=$7
           where id=$1 and property_id=$2`,[unitId,propertyId,row.sqft,row.market_rent,batchId,sourceAsOfDate,options.confidence||'confirmed']);
        }else{
          unitId=(await client.query(
            `insert into units (property_id,unit_number,square_feet,market_rent,import_batch_id,source_type,source_as_of_date,confidence)
             values ($1,$2,$3,$4,$5,'rent_roll_ledger',$6,$7) returning id`,
            [propertyId,row.unit_number,row.sqft,row.market_rent,batchId,sourceAsOfDate,options.confidence||'confirmed'])).rows[0].id; counts.units_created++;
        }
        unitCache.set(row.unit_number,unitId);
      }
      const label="(whole unit)", sk=`${unitId}|${label}`; let spaceId=spaceCache.get(sk);
      if(!spaceId){
        const q=await client.query("select id from spaces where unit_id=$1 and space_label=$2 limit 1",[unitId,label]);
        if(q.rows.length){spaceId=q.rows[0].id;counts.spaces_reused++;}
        else{spaceId=(await client.query(
          `insert into spaces (unit_id,space_label,import_batch_id,source_type,source_as_of_date,confidence)
           values ($1,$2,$3,'rent_roll_ledger',$4,$5) returning id`,
          [unitId,label,batchId,sourceAsOfDate,options.confidence||'confirmed'])).rows[0].id;counts.spaces_created++;}
        spaceCache.set(sk,spaceId);
      }
      await client.query(
        `insert into import_source_rows (import_batch_id,row_index,raw,produced_unit_id,produced_space_id,produced_person_id,produced_lease_id,parse_note)
         values ($1,$2,$3,$4,$5,null,null,$6)`,
        //  `raw` stays normalizeRow-shaped because the rent-roll read
        //  re-normalizes it. The ORIGINAL cells ride alongside under
        //  `_source_cells` — normalizeRow ignores keys it does not know, so
        //  the display is unaffected and the evidence stops being only our
        //  reading of the document.
        [batchId,row.row_index,JSON.stringify({ ...row, _source_cells: row._source_cells || null }),
         unitId,spaceId,row.section==='future'?'future ledger row — evidence only':'current ledger row — evidence only']
      );
    }

    //  ── ROWS THE SOURCE CONTAINED THAT WE COULD NOT PLACE ──────────────
    //  Written as evidence with no produced objects. They are not
    //  positions and must never be counted as any, but "line 47 had no
    //  unit number" is only answerable if line 47 is on record.
    for (const row of unusable) {
      counts.unusable_rows = (counts.unusable_rows || 0) + 1;
      await client.query(
        `insert into import_source_rows (import_batch_id,row_index,raw,produced_unit_id,produced_space_id,produced_person_id,produced_lease_id,parse_note)
         values ($1,$2,$3,null,null,null,null,$4)`,
        [batchId,row.row_index,JSON.stringify({ ...row, _source_cells: row._source_cells || null }),
         'unusable: no unit number — recorded as evidence, established as nothing']
      );
    }

    await client.query("update import_batches set status='committed',updated_at=now() where id=$1",[batchId]);
    if (!borrowed) await client.query("commit");
    return {ok:true,property_id:propertyId,import_batch_id:batchId,source_type:'rent_roll_ledger',source_file:sourceFile,source_as_of_date:sourceAsOfDate,loaded:counts};
  } catch(e){
    if (!borrowed) await client.query("rollback");
    console.error("rent-roll ledger load error:", e);
    //  A borrowed client belongs to a transaction this function did not
    //  open. Swallowing the error and returning a shape would let the
    //  caller commit a half-written batch; it is rethrown so the owner of
    //  the transaction decides.
    if (borrowed) throw e;
    return {error:"ledger_load_failed",detail:e.message};
  } finally { if (!borrowed) client.release(); }
}

function validateReconciliation(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok:false, errors:["reconciliation_document_required"], unit_rows:0, exceptions:0 };
  }
  if (!doc.property) errors.push("property_metadata_required");
  if (!dt(doc.as_of)) errors.push("valid_as_of_date_required");
  if (!Array.isArray(doc.unit_truth) || !doc.unit_truth.length) errors.push("unit_truth_required");
  const units = Array.isArray(doc.unit_truth) ? doc.unit_truth : [];
  if (units.length > 5000) errors.push("too_many_unit_truth_rows");
  const seen = new Set();
  for (const row of units) {
    const unit = String(row && row.Unit || "").trim();
    if (!unit) { errors.push("unit_number_required"); break; }
    if (seen.has(unit)) { errors.push(`duplicate_unit:${unit}`); break; }
    seen.add(unit);
  }
  const statedInventory = Number(doc.inventory && doc.inventory.residential_units);
  if (Number.isFinite(statedInventory) && units.length && statedInventory !== units.length) errors.push("inventory_unit_count_mismatch");
  const committed = Number(doc.september_1 && doc.september_1.committed_units);
  if (Number.isFinite(committed) && units.length && (committed < 0 || committed > units.length)) errors.push("invalid_september_1_commitment_count");
  if (Array.isArray(doc.projection_matrix) && units.length && doc.projection_matrix.length !== units.length) errors.push("projection_matrix_unit_count_mismatch");
  if (Array.isArray(doc.horizons)) {
    for (const h of doc.horizons) {
      if (!dt(h && h.date)) { errors.push("invalid_horizon_date"); break; }
    }
  }
  return { ok:errors.length === 0, errors, unit_rows:units.length,
           exceptions:Array.isArray(doc.exceptions) ? doc.exceptions.length : 0 };
}

function validReconciliation(doc) {
  return validateReconciliation(doc).ok;
}

function reconciliationRows(doc) {
  if (!validReconciliation(doc)) return [];
  return doc.unit_truth.map((u, i) => {
    const state = String(u["Current State"] || "").toLowerCase();
    const status = state === "vacant" ? "vacant" : state === "model" ? "model" :
      state === "down" ? "down" : state === "commercial" ? "commercial" :
      String(u["Expiration Disposition"] || "").toLowerCase() === "notice" ? "notice" : "current";
    return normalizeRow({
      row_index:i + 1,
      unit_number:u.Unit,
      unit_type:u["Unit Type"],
      sqft:u.SF,
      name:u["Current Resident"],
      resident_id:null,
      resident_raw:u["Current Resident"] || status,
      status,
      market_rent:null,
      actual_rent:u["Current Rent"],
      move_in:null,
      lease_from:null,
      lease_to:u["Current Lease End"],
      move_out:u["Expected Move-Out"],
      balance:0,
      section:"current",
      is_commercial:false,
    }, i);
  });
}

function reconciliationAvailability(doc, asOf) {
  if (!validReconciliation(doc)) return [];
  const asOfDate = dt(asOf) || dt(doc.as_of);
  return doc.unit_truth.map(u => {
    const unit = String(u.Unit || "");
    const currentState = String(u["Current State"] || "").toLowerCase();
    const position = String(u["Sep. 1 Position"] || "");
    const proof = String(u["Proof Level"] || "");
    const targetReady = dt(u["Target Ready"]);
    const expectedVacate = dt(u["Expected Vacate"] || u["Expected Move-Out"]);
    const committed = /signed|renewal|future lease|current/i.test(position) &&
      !/unresolved|uncovered|pipeline/i.test(position);
    const pipeline = /pipeline/i.test(position) || Boolean(u["Pipeline Status"]);
    const nonRevenue = currentState === "model" || currentState === "down";
    const vacantNow = currentState === "vacant";
    const readyNow = !targetReady || !asOfDate || targetReady <= asOfDate;
    const marketableNow = vacantNow && !committed && !pipeline && !nonRevenue && readyNow;
    let state = "occupied";
    if (nonRevenue) state = currentState;
    else if (pipeline) state = "pipeline_pending";
    else if (vacantNow && committed) state = "vacant_committed";
    else if (vacantNow && marketableNow) state = "vacant_marketable";
    else if (vacantNow) state = "vacant_readiness_pending";
    else if (String(u["Expiration Disposition"] || "").toLowerCase() === "notice" && !committed) state = "notice_uncommitted";
    else if (String(u["Expiration Disposition"] || "").toLowerCase() === "unresolved") state = "renewal_unresolved";
    return {
      unit_number:unit,
      unit_type:u["Unit Type"] || null,
      current_status:currentState || "unknown",
      current_resident:u["Current Resident"] || null,
      market_rent:null,
      actual_rent:Number(u["Current Rent"] || 0),
      lease_end:dt(u["Current Lease End"]),
      move_out:expectedVacate,
      future_commitments:committed ? [{
        resident_name:u["Sep. 1 Resident"] || u["Current Resident"] || null,
        start_date:dt(u["Term Start"]),
        end_date:dt(u["Term End"]),
        rent:Number(u["Sep. 1 Rent"] || 0),
        proof_level:proof || null,
      }] : [],
      committed,
      contractual_open_now:vacantNow && !committed,
      contractual_open_forward:/notice/i.test(String(u["Expiration Disposition"] || "")) && !committed,
      physical_readiness:u["Readiness / Turn"] || (targetReady ? (readyNow ? "ready" : "scheduled") : "unknown"),
      possession_status:vacantNow ? "possessed" : "occupied",
      availability_state:state,
      available_from:targetReady || expectedVacate || null,
      marketable_now:marketableNow,
      next_required_action:u["Next Required Action"] || null,
      position_reason:position || null,
      proof_level:proof || null,
      exception:u["Exception / Reconciliation Note"] || null,
    };
  }).sort((a,b) => String(a.unit_number).localeCompare(String(b.unit_number), undefined, {numeric:true}));
}

async function readLatestReconciliation(pool, propertyId) {
  const batch = (await pool.query(
    `select id, source_type, source_file, source_as_of_date, leasing_model,
            confidence, status, loaded_at, notes
       from import_batches
      where property_id=$1 and status='committed' and source_type='rent_roll_reconciliation'
      order by source_as_of_date desc nulls last, loaded_at desc limit 1`,
    [propertyId]
  )).rows[0];
  if (!batch) return null;
  const row = (await pool.query(
    `select raw from import_source_rows
      where import_batch_id=$1 and parse_note='rent_roll_truth_reconciliation_document'
      order by row_index limit 1`, [batch.id]
  )).rows[0];
  const raw = row && row.raw;
  const document = raw && raw.payload ? raw.payload : raw;
  if (!validReconciliation(document)) return null;
  return { batch, document };
}

async function loadReconciliation(pool, document, options = {}) {
  if (!validReconciliation(document)) return { error:"invalid_reconciliation_document" };
  const client = await pool.connect();
  try {
    await client.query("begin");
    let propertyId = options.targetPropertyId || null;
    if (!propertyId) {
      if (!options.propertyConfig) {
        await client.query("rollback");
        return { error: "property_not_found", property: "session_scoped",
                 receipt: "No property was supplied and none could be derived from the session." };
      }
      const res = await resolveProperty(client, options.propertyConfig);
      if (res.status !== "resolved") {
        await client.query("rollback");
        return { ...resolutionError(res), property: "session_scoped" };
      }
      propertyId = res.property_id;
    }
    const sourceFile = options.sourceFile || `Rent-roll truth reconciliation ${document.as_of}.json`;
    const sourceAsOfDate = dt(options.sourceAsOfDate || document.as_of);
    if (!sourceAsOfDate) { await client.query("rollback"); return { error:"valid_source_as_of_date_required" }; }
    const prior = await client.query(
      `select id from import_batches
        where property_id=$1 and source_type='rent_roll_reconciliation'
          and source_file=$2 and source_as_of_date=$3 and status='committed'
        order by loaded_at desc limit 1`,
      [propertyId, sourceFile, sourceAsOfDate]
    );
    if (prior.rows.length && !options.force) {
      await client.query("rollback");
      return { ok:true, idempotent:true, already_loaded:true, property_id:propertyId,
               import_batch_id:prior.rows[0].id, source_file:sourceFile,
               source_as_of_date:sourceAsOfDate, unit_rows:document.unit_truth.length };
    }
    const summary = document.september_1 || {};
    const batch = (await client.query(
      `insert into import_batches
         (property_id, source_type, source_file, source_as_of_date,
          leasing_model, confidence, status, notes)
       values ($1,'rent_roll_reconciliation',$2,$3,'unit',$5,'parsed',$4) returning id`,
      [propertyId, sourceFile, sourceAsOfDate,
       `Reconciled unit timeline; ${document.unit_truth.length} units; September 1 committed ${summary.committed_units || 0}; imported by ${options.actorId || "operator"}.`,
       options.confidence || "manually_reviewed"]
    )).rows[0];
    await client.query(
      `insert into import_source_rows
         (import_batch_id, row_index, raw, produced_unit_id, produced_space_id,
          produced_person_id, produced_lease_id, parse_note)
       values ($1,1,$2,null,null,null,null,'rent_roll_truth_reconciliation_document')`,
      [batch.id, JSON.stringify({ kind:"rent_roll_truth_reconciliation", payload:document })]
    );
    await client.query("update import_batches set status='committed', updated_at=now() where id=$1", [batch.id]);
    await client.query("commit");
    return { ok:true, property_id:propertyId, import_batch_id:batch.id,
             source_type:"rent_roll_reconciliation", source_file:sourceFile,
             source_as_of_date:sourceAsOfDate, unit_rows:document.unit_truth.length,
             exceptions:Array.isArray(document.exceptions) ? document.exceptions.length : 0 };
  } catch (e) {
    await client.query("rollback");
    console.error("rent-roll reconciliation load error:", e);
    return { error:"reconciliation_load_failed", detail:e.message };
  } finally {
    client.release();
  }
}


async function readLatestSnapshot(pool, propertyId, asOf = null) {
  const reconciliation = await readLatestReconciliation(pool, propertyId);
  const batch = (await pool.query(
    `select id, source_type, source_file, source_as_of_date, leasing_model,
            confidence, status, loaded_at, notes
       from import_batches
      where property_id=$1 and status='committed' and source_type in ('rent_roll_ledger','historical_snapshot')
      order by case when source_type='rent_roll_ledger' then 0 else 1 end, source_as_of_date desc nulls last, loaded_at desc limit 1`,
    [propertyId]
  )).rows[0];
  if (!batch && !reconciliation) return { property_id:propertyId, has_data:false, source:null, rows:[], availability:[],
                       receipt:"No sourced rent roll has been imported for this property." };

  let rows = [];
  if (batch) {
    const sourceRows = (await pool.query(
      `select row_index, raw, parse_note from import_source_rows
        where import_batch_id=$1 order by row_index`, [batch.id]
    )).rows;
    //  Evidence holds every row the source contained, including ones that
    //  could not be placed (no unit number). Those are evidence, not
    //  positions: showing them here would put blank lines in a rent roll
    //  and inflate every count computed from it. They remain readable
    //  through the batch's source rows, which is where they belong.
    rows = sourceRows.map((r,i) => normalizeRow(r.raw || {}, i)).filter(r => r.unit_number);
  } else if (reconciliation) {
    rows = reconciliationRows(reconciliation.document);
  }

  const doc = reconciliation && reconciliation.document;
  const effectiveAsOf = dt(asOf) || (doc && dt(doc.as_of)) ||
    (batch && batch.source_as_of_date ? dt(batch.source_as_of_date) : new Date().toISOString().slice(0,10));
  let positionStatus = "unavailable", positions = [];
  try {
    const sp = await spacePosition(pool, { property_id:propertyId, as_of:effectiveAsOf });
    positions = sp.positions || [];
    positionStatus = "ok";
  } catch (e) {
    console.error("rent-roll space-position overlay unavailable:", e.message);
  }

  // ── THE PERSON→RENT-ROLL BRIDGE (per-row canonical overlay) ──────────
  if (positions.length > 0) {
    const byUnit = new Map();
    for (const p of positions) {
      const key = String(p.unit_number || "").trim();
      if (!key) continue;
      if (!byUnit.has(key)) byUnit.set(key, []);
      byUnit.get(key).push(p);
    }
    for (const row of rows) {
      const key = String(row.unit_number || "").trim();
      const unitPositions = key ? (byUnit.get(key) || []) : [];
      // a unit earns an overlay only when canonical truth exists on it
      const bearing = unitPositions.filter(p =>
        p.current_lease_position || p.future_lease_position || p.current_possession);
      if (bearing.length === 0) continue;
      const pos = bearing[0]; // by-unit model: one space per unit; extras noted below
      const cur = pos.current_lease_position || null;
      const fwd = pos.future_lease_position || null;

      // disagreement is surfaced, never resolved silently
      const conflicts = [];
      if (cur && cur.rent != null && row.actual_rent != null &&
          Math.abs(Number(cur.rent) - Number(row.actual_rent)) > 0.005) {
        conflicts.push({ field: "rent", reconciliation: Number(row.actual_rent), canonical: Number(cur.rent) });
      }
      if (cur && (row.status === "vacant" || row.status === "model" || row.status === "down")) {
        conflicts.push({ field: "status", reconciliation: row.status, canonical: "current_lease_present" });
      }
      if (!cur && pos.current_possession && row.status === "vacant") {
        conflicts.push({ field: "status", reconciliation: "vacant", canonical: "possession_without_current_lease" });
      }

      row.canonical = {
        as_of: effectiveAsOf,
        space_id: pos.space_id,
        current: cur,                                 // lease_id · dates · rent · tenants[]
        forward: fwd,                                 // lease intent only — NEVER current occupancy
        possession: pos.current_possession || null,   // { since } from the effective move_in event
        availability_state: pos.availability_state,
        next_required_action: pos.next_required_action || null,
        reason: pos.reason || null,
        conflicts,
        additional_spaces: bearing.length > 1 ? bearing.length - 1 : 0,
      };
      // the app's person-keyed doorways key on person_id; current tenant
      // wins, forward tenant otherwise. Reconciliation-only rows keep null.
      const firstTenant =
        (cur && cur.tenants && cur.tenants[0]) ||
        (fwd && fwd.tenants && fwd.tenants[0]) || null;
      if (firstTenant && row.person_id == null) row.person_id = firstTenant.person_id;
      if (firstTenant && firstTenant.name && row.name == null) row.name = firstTenant.name;
    }
  }

  const summary = summarizeRows(rows);
  let availability = availabilityProjection(rows, positions, effectiveAsOf);
  if (doc) {
    const inv = doc.inventory || {};
    summary.inventory = Number(inv.residential_units || summary.inventory || 0);
    summary.current_rows = summary.inventory;
    summary.occupied = Number(inv.current_occupied || 0);
    summary.vacant = Number(inv.current_vacant || 0);
    summary.model = Number(inv.model || 0);
    summary.down = Number(inv.down || 0);
    summary.non_revenue = summary.model + summary.down;
    summary.current_occupancy_pct = inv.current_occupancy_pct == null ? null : Math.round(Number(inv.current_occupancy_pct) * 10000) / 100;
    const revenueInventory = Math.max(0, summary.inventory - summary.non_revenue);
    summary.leasable_occupancy_pct = revenueInventory ? Math.round(summary.occupied / revenueInventory * 10000) / 100 : null;
    summary.reconciled = true;
    summary.reconciliation_as_of = dt(doc.as_of);
    summary.ledger_cut = dt(doc.ledger_cut);
    const commercialRows = rows.filter(r => r.section !== "future" && r.is_commercial);
    const commercialOccupied = commercialRows.filter(r => OCCUPIED_STATUSES.has(r.status));
    const commercialCurrentRent = commercialOccupied.reduce((n,r) => n + Number(r.actual_rent || 0), 0);
    summary.residential_inventory = summary.inventory;
    summary.commercial_spaces = commercialRows.length;
    summary.total_property_positions = summary.inventory + commercialRows.length;
    summary.residential_occupied = summary.occupied;
    summary.commercial_occupied = commercialOccupied.length;
    summary.total_occupied_positions = summary.occupied + commercialOccupied.length;
    summary.current_contract_rent_residential = Number(doc.september_1 && doc.september_1.current_occupied_monthly_rent || 0);
    summary.current_contract_rent_commercial = commercialCurrentRent;
    summary.current_contract_rent_property = summary.current_contract_rent_residential + commercialCurrentRent;
    const sep = doc.september_1 || null;
    summary.september_1 = sep ? {
      ...sep,
      commercial_committed_spaces:commercialOccupied.length,
      commercial_scheduled_contract_rent:commercialCurrentRent,
      property_scheduled_gross_contract_rent:Number(sep.scheduled_gross_contract_rent || 0) + commercialCurrentRent,
    } : null;
    availability = reconciliationAvailability(doc, effectiveAsOf);
  }
  summary.canonical_rows = rows.filter(r => r.canonical).length;
  summary.canonical_forward_rows = rows.filter(r => r.canonical && r.canonical.forward).length;
  summary.canonical_conflict_rows = rows.filter(r => r.canonical && r.canonical.conflicts.length > 0).length;
  summary.uncommitted_vacant = availability.filter(a => a.current_status === "vacant" && !a.committed).length;
  summary.uncommitted_notice = availability.filter(a => a.availability_state === "notice_uncommitted").length;
  summary.marketable_now = availability.filter(a => a.marketable_now).length;

  const source = doc ? {
      import_batch_id:reconciliation.batch.id,
      type:reconciliation.batch.source_type,
      file:reconciliation.batch.source_file,
      as_of:dt(doc.as_of),
      ledger_cut:dt(doc.ledger_cut),
      leasing_model:"unit",
      confidence:reconciliation.batch.confidence || "manually_reviewed",
      loaded_at:reconciliation.batch.loaded_at,
      truth_status:"reconciled_unit_timeline",
      baseline_import_batch_id:batch ? batch.id : null,
      baseline_file:batch ? batch.source_file : null,
      baseline_as_of:batch && batch.source_as_of_date ? dt(batch.source_as_of_date) : null,
    } : {
      import_batch_id:batch.id,
      type:batch.source_type,
      file:batch.source_file,
      as_of:effectiveAsOf,
      leasing_model:batch.leasing_model,
      confidence:batch.confidence,
      loaded_at:batch.loaded_at,
      truth_status:"sourced_snapshot",
    };

  return {
    property_id:propertyId,
    has_data:true,
    source,
    position_status:positionStatus,
    summary,
    rows,
    availability,
    reconciliation:doc || null,
  };
}

module.exports = function snapshotLoader(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool, upload } = deps;
  if (!pool) throw new Error("snapshot_loader requires a pool");

  async function resolveOperator(req) {
    return staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
  }
  async function requireOperator(req, res, next) {
    try {
      const op = await resolveOperator(req);
      if (!op) return res.status(401).json({ error:"No valid operator session. Sign in." });
      req.operator = op;
      next();
    } catch (e) {
      console.error("rent-roll session resolution failed:", e.message);
      return res.status(500).json({ error:"session resolution failed" });
    }
  }

  if (upload) {
    router.post("/snapshot/:property/upload", upload.single("file"), async (req, res) => {
      const cfg = CONFIGS[String(req.params.property || "").toLowerCase()];
      if (!cfg) return res.status(404).json({ error:"unknown_property", known:Object.keys(CONFIGS) });
      try {
        if (!req.file?.buffer) return res.status(400).json({ receipt:"No file. Send the .xlsx as form field 'file'." });
        const parsed = parseXlsx(cfg, req.file.buffer);
        const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
        //  Resolve, then ask the perimeter, then pass the target EXPLICITLY
        //  so the loader never re-resolves. A fixture may only land on a
        //  configured demo/QA property.
        const target = await resolveConfiguredTarget(pool, cfg);
        const check = syntheticTargetAllowed(target);
        if (!check.allowed) return res.status(403).json({ ...syntheticRefusal(check), dataset: cfg.key });
        const out = await loadSnapshot(pool, cfg, parsed, { dryRun, targetPropertyId: target });
        if (out.error) return res.status(out.error === "property_not_found" ? 404 : 400).json(out);
        return res.status(dryRun ? 200 : 201).json({ parsed_rows:parsed.length, ...out });
      } catch (e) {
        console.error("snapshot upload error:", e);
        return res.status(500).json({ error:"upload_failed", detail:e.message });
      }
    });
  }

  router.post("/snapshot/:property/load", async (req, res) => {
    const cfg = CONFIGS[String(req.params.property || "").toLowerCase()];
    if (!cfg) return res.status(404).json({ error:"unknown_property", known:Object.keys(CONFIGS) });
    try {
      const { rows, dryRun } = req.body || {};
      const target = await resolveConfiguredTarget(pool, cfg);
      const check = syntheticTargetAllowed(target);
      if (!check.allowed) return res.status(403).json({ ...syntheticRefusal(check), dataset: cfg.key });
      const out = await loadSnapshot(pool, cfg, rows, { dryRun:!!dryRun, targetPropertyId: target });
      if (out.error) return res.status(out.error === "property_not_found" ? 404 : 400).json(out);
      return res.status(dryRun ? 200 : 201).json(out);
    } catch (e) {
      return res.status(500).json({ error:"endpoint_failed", detail:e.message });
    }
  });

  // Canonical signed-in import: property authority comes only from the session.
  // No client property id is accepted. This imports sourced baseline truth; it does
  // not write to Yardi or dispatch communications.
  router.post("/operator/rent-roll/import", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const role = String(req.operator.role || "").toLowerCase();
    if (!IMPORT_ROLES.has(role)) return res.status(403).json({ error:"Your role cannot import a rent roll." });
    const body = req.body || {};
    const reconciliation = body.reconciliation || (validReconciliation(body) ? body : null);
    const hasRows = Array.isArray(body.rows) && body.rows.length > 0;
    if (!hasRows && !reconciliation) return res.status(400).json({ error:"rows_or_reconciliation_required" });
    if (hasRows && body.rows.length > 5000) return res.status(413).json({ error:"too_many_rows" });
    const sourceAsOfDate = hasRows ? dt(body.baseline_source_as_of_date || body.ledger_cut || body.source_as_of_date) : null;
    if (hasRows && !sourceAsOfDate) return res.status(400).json({ error:"valid_baseline_source_as_of_date_required" });
    const reconciliationCheck = reconciliation ? validateReconciliation(reconciliation) :
      { ok:true, errors:[], unit_rows:0, exceptions:0 };
    if (!reconciliationCheck.ok) return res.status(400).json({
      error:"invalid_reconciliation_document", details:reconciliationCheck.errors,
    });
    if (body.dry_run) return res.status(200).json({
      ok:true,
      receipt:"Rent-roll truth package validated; no records were committed.",
      validated:{
        baseline_rows:hasRows ? body.rows.length : 0,
        baseline_source_as_of_date:sourceAsOfDate,
        reconciliation_units:reconciliationCheck.unit_rows,
        reconciliation_exceptions:reconciliationCheck.exceptions,
      },
    });

    let baselineOut = null, reconciliationOut = null;
    if (hasRows) {
      // The operator import records dated ledger evidence only. It deliberately does
      // not manufacture durable people or canonical leases from names in a report.
      // Identity and lease objects enter through their own governed services.
      baselineOut = await loadLedgerSnapshot(pool, body.rows, {
        targetPropertyId:req.operator.property_id,
        sourceFile:body.baseline_source_file || body.source_file || "Rent roll ledger export",
        sourceAsOfDate:body.baseline_source_as_of_date || body.ledger_cut || body.source_as_of_date,
        leasingModel:body.leasing_model || "unit",
        confidence:body.confidence || "confirmed",
        notes:`Session-scoped dated ledger evidence imported by user ${req.operator.id}. No person or lease records fabricated; no Yardi write.`,
        force:Boolean(body.force),
      });
      if (baselineOut.error) return res.status(baselineOut.error === "property_not_found" ? 404 : 400).json(baselineOut);
    }
    if (reconciliation) {
      reconciliationOut = await loadReconciliation(pool, reconciliation, {
        targetPropertyId:req.operator.property_id,
        sourceFile:body.source_file || `Rent-roll truth reconciliation ${reconciliation.as_of}.json`,
        sourceAsOfDate:body.source_as_of_date || reconciliation.as_of,
        actorId:req.operator.id,
        force:Boolean(body.force),
      });
      if (reconciliationOut.error) return res.status(reconciliationOut.error === "property_not_found" ? 404 : 400).json(reconciliationOut);
    }
    const alreadyLoaded = Boolean((!baselineOut || baselineOut.already_loaded) && (!reconciliationOut || reconciliationOut.already_loaded));
    return res.status(alreadyLoaded ? 200 : 201).json({
      receipt:alreadyLoaded ? "This rent-roll truth package was already loaded; no duplicate records were created." :
        "Rent-roll baseline and reconciled unit timeline imported. Management and Leasing now read one dated truth projection.",
      ok:true,
      baseline:baselineOut,
      reconciliation:reconciliationOut,
    });
  });

  // Canonical signed-in read: one source for current roll, forward roll,
  // delinquency, and Leasing availability. Live empty/failure stays honest.
  router.get("/operator/rent-roll", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      return res.json(await readLatestSnapshot(pool, req.operator.property_id, req.query.as_of || null));
    } catch (e) {
      console.error("operator rent-roll read failed:", e);
      return res.status(500).json({ error:"rent_roll_unavailable", receipt:"The sourced rent roll could not be read. Retry; no fixture was substituted." });
    }
  });

  router.get("/snapshot/batches/:property_id", async (req, res) => {
    try {
      const r = await pool.query(
        `select id, source_type, source_file, source_as_of_date, leasing_model,
                confidence, status, loaded_at,
                (select count(*) from import_source_rows s where s.import_batch_id=b.id)::int as source_rows
           from import_batches b where property_id=$1 order by loaded_at desc`, [req.params.property_id]);
      return res.json({ property_id:req.params.property_id, batches:r.rows });
    } catch (e) { return res.status(500).json({ error:"batches_read_failed", detail:e.message }); }
  });

  router.get("/snapshot/batch/:batch_id/rows", async (req, res) => {
    try {
      const r = await pool.query(
        `select row_index, raw, produced_unit_id, produced_space_id,
                produced_person_id, produced_lease_id, parse_note
           from import_source_rows where import_batch_id=$1 order by row_index`, [req.params.batch_id]);
      return res.json({ import_batch_id:req.params.batch_id, rows:r.rows });
    } catch (e) { return res.status(500).json({ error:"rows_read_failed", detail:e.message }); }
  });

  router.helpers = {
    loadSnapshot:(cfg, rows, options)=>loadSnapshot(pool, cfg, rows, options),
    readLatestSnapshot:(propertyId, asOf)=>readLatestSnapshot(pool, propertyId, asOf),
    parseXlsx, parseResident, normalizeRow, summarizeRows, availabilityProjection,
    loadLedgerSnapshot, loadReconciliation, readLatestReconciliation, reconciliationRows, reconciliationAvailability, validateReconciliation, validReconciliation,
    num, dt, CONFIGS,
  };
  return router;
};

module.exports.CONFIGS = CONFIGS;
module.exports.normalizeRow = normalizeRow;
module.exports.summarizeRows = summarizeRows;
module.exports.availabilityProjection = availabilityProjection;
module.exports.loadSnapshot = loadSnapshot;
module.exports.readLatestSnapshot = readLatestSnapshot;
module.exports.loadLedgerSnapshot = loadLedgerSnapshot;
module.exports.loadReconciliation = loadReconciliation;
module.exports.readLatestReconciliation = readLatestReconciliation;
module.exports.reconciliationAvailability = reconciliationAvailability;
module.exports.validateReconciliation = validateReconciliation;
module.exports.validReconciliation = validReconciliation;

module.exports.reconciliationRows = reconciliationRows;
