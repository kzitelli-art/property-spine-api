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

const staffSessions = require("./staff_session_service.js");
const { spacePosition } = require("./space_position");

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

async function resolveProperty(client, cfg) {
  if (cfg.property_key) {
    const r = await client.query("select id from properties where canonical_key = $1", [cfg.property_key]);
    if (r.rows.length) return r.rows[0].id;
  }
  for (const token of cfg.property_match || []) {
    const r = await client.query(
      `select id from properties
        where lower(name) like '%'||$1||'%' or lower(coalesce(address,'')) like '%'||$1||'%'
        order by created_at limit 1`, [String(token).toLowerCase()]);
    if (r.rows.length) return r.rows[0].id;
  }
  return null;
}

async function loadSnapshot(pool, cfg, inputRows, options = {}) {
  const rows = (Array.isArray(inputRows) ? inputRows : []).map(normalizeRow).filter(r => r.unit_number);
  if (!rows.length) return { error: "no_rows" };
  const meta = snapshotMeta(cfg, options);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const propertyId = options.targetPropertyId || await resolveProperty(client, cfg);
    if (!propertyId) { await client.query("rollback"); return { error: "property_not_found", property: cfg.key }; }

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

async function readLatestSnapshot(pool, propertyId, asOf = null) {
  const batch = (await pool.query(
    `select id, source_type, source_file, source_as_of_date, leasing_model,
            confidence, status, loaded_at, notes
       from import_batches
      where property_id=$1 and status='committed' and source_type='historical_snapshot'
      order by source_as_of_date desc nulls last, loaded_at desc limit 1`,
    [propertyId]
  )).rows[0];
  if (!batch) return { property_id:propertyId, has_data:false, source:null, rows:[], availability:[],
                       receipt:"No sourced rent roll has been imported for this property." };

  const sourceRows = (await pool.query(
    `select row_index, raw, parse_note from import_source_rows
      where import_batch_id=$1 order by row_index`, [batch.id]
  )).rows;
  const rows = sourceRows.map((r,i) => normalizeRow(r.raw || {}, i));
  const effectiveAsOf = asOf || (batch.source_as_of_date ? String(batch.source_as_of_date).slice(0,10) : new Date().toISOString().slice(0,10));
  let positionStatus = "unavailable", positions = [];
  try {
    const sp = await spacePosition(pool, { property_id:propertyId, as_of:effectiveAsOf });
    positions = sp.positions || [];
    positionStatus = "ok";
  } catch (e) {
    console.error("rent-roll space-position overlay unavailable:", e.message);
  }
  const summary = summarizeRows(rows);
  const availability = availabilityProjection(rows, positions, effectiveAsOf);
  summary.uncommitted_vacant = availability.filter(a => a.current_status === "vacant" && !a.committed).length;
  summary.uncommitted_notice = availability.filter(a => a.current_status === "notice" && !a.committed).length;
  summary.marketable_now = availability.filter(a => a.marketable_now).length;

  return {
    property_id:propertyId,
    has_data:true,
    source:{
      import_batch_id:batch.id,
      type:batch.source_type,
      file:batch.source_file,
      as_of:effectiveAsOf,
      leasing_model:batch.leasing_model,
      confidence:batch.confidence,
      loaded_at:batch.loaded_at,
      truth_status:"sourced_snapshot",
    },
    position_status:positionStatus,
    summary,
    rows,
    availability,
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
        const out = await loadSnapshot(pool, cfg, parsed, { dryRun });
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
      const out = await loadSnapshot(pool, cfg, rows, { dryRun:!!dryRun });
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
    if (!Array.isArray(body.rows) || !body.rows.length) return res.status(400).json({ error:"rows_required" });
    if (body.rows.length > 5000) return res.status(413).json({ error:"too_many_rows" });
    const cfg = { ...CONFIGS.solo, leasing_model:body.leasing_model || "unit" };
    const out = await loadSnapshot(pool, cfg, body.rows, {
      targetPropertyId:req.operator.property_id,
      sourceFile:body.source_file || cfg.source_file,
      sourceAsOfDate:body.source_as_of_date || cfg.source_as_of_date,
      sourceLabel:body.source_label || cfg.badge,
      confidence:body.confidence || "confirmed",
      notes:`Session-scoped sourced rent-roll import by user ${req.operator.id}. QA activity remains separately classified; no Yardi write.`,
      dryRun:Boolean(body.dry_run),
    });
    if (out.error) return res.status(out.error === "property_not_found" ? 404 : 400).json(out);
    return res.status(body.dry_run ? 200 : (out.already_loaded ? 200 : 201)).json({
      receipt:out.already_loaded ? "This sourced rent roll was already loaded; no duplicate records were created." : "Sourced rent roll imported. Management and Leasing now read the same property-scoped projection.",
      ...out,
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
