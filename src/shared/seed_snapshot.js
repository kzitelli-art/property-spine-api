// ════════════════════════════════════════════════════════════════════
const personIngress = require("../identity/person_ingress.js"); // the ONE door a human enters Spine through
//  seed_snapshot.js — ONE-TIME historical snapshot seed (Skyline + Solo)
//
//  PURPOSE: get real portfolio data into the app for demo/feel — NOT the
//  intake machine (that's separate, later). This writes the actual rent-roll
//  data I already read, directly into Neon, labeled as historical_snapshot.
//
//  GUARDRAILS (all satisfied):
//   • everything labeled source_type='historical_snapshot'
//   • ONE import_batch_id per property/source
//   • IDEMPOTENT/RERUNNABLE — re-running deletes this property's prior
//     snapshot batch (by source_file) and reloads. Never touches other data.
//   • ROLLBACKABLE — delete the import_batch row; cascade clears its rows;
//     units/spaces/leases/persons stamped with that batch_id are removed via
//     the explicit rollback path (they FK with on delete set null, so we
//     delete-by-batch explicitly). See `rollback` below.
//   • does NOT overwrite unrelated live data — only ever deletes rows whose
//     import_batch_id belongs to THIS property's snapshot batch.
//   • CURRENT and FUTURE separated — future never counts as occupancy.
//   • by-bed (Skyline) / by-unit (Solo) both handled.
//   • NO fake maintenance, NO fake money transactions.
//
//  USAGE (run on Render, where the DB is reachable):
//    node seed_snapshot.js            → seeds both (idempotent)
//    node seed_snapshot.js skyline    → seeds only Skyline
//    node seed_snapshot.js solo       → seeds only Solo
//    node seed_snapshot.js rollback skyline   → removes Skyline's snapshot
//    node seed_snapshot.js rollback solo
//  Or expose via an admin endpoint (see seed_endpoint.js).
// ════════════════════════════════════════════════════════════════════

const { Pool } = require("pg");
const { resolvePropertyForImport } = require("../identity/property_resolution_service.js");

const DATASETS = {
  skyline: require("../../seeds/data_skyline.js"),
  solo: require("../../seeds/data_solo.js"),
};

const NON_REVENUE = /^(vacant|model|down)$/i;

function num(v){ if (v == null || v === "") return null; const n = Number(String(v).replace(/,/g,"").trim()); return Number.isFinite(n) ? n : null; }
function dt(v){ if (!v) return null; const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(!m) return null; const [_,mo,da,yr]=m; return `${yr}-${mo.padStart(2,"0")}-${da.padStart(2,"0")}`; }

//  Build 1A-2: this was the SECOND copy of the fuzzy resolver, with the
//  same `order by created_at limit 1` silent-first-match. Both now go
//  through the one contained resolver. See
//  src/identity/property_resolution_service.js for why a single text
//  match is a proposal and not an answer.
async function resolveProperty(client, cfg){
  const res = await resolvePropertyForImport(client, {
    canonical_key: cfg.property_key || null,
    match_tokens: cfg.property_match || [],
  });
  return res.status === "resolved" ? res.property_id : null;
}

// remove any prior snapshot batch for this property+source (idempotency/rollback)
async function deleteExistingBatch(client, propertyId, sourceFile){
  const batches = await client.query(
    "select id from import_batches where property_id=$1 and source_file=$2 and source_type='historical_snapshot'",
    [propertyId, sourceFile]);
  for (const b of batches.rows){
    const id = b.id;
    // delete dependent rows first (explicit, since units/etc FK on delete set null)
    await client.query("delete from leases where import_batch_id=$1", [id]);
    await client.query("delete from spaces where import_batch_id=$1", [id]);
    await client.query("delete from persons where import_batch_id=$1", [id]);
    await client.query("delete from units where import_batch_id=$1", [id]);
    await client.query("delete from import_source_rows where import_batch_id=$1", [id]);
    await client.query("delete from import_batches where id=$1", [id]);
  }
  return batches.rows.length;
}

async function seedOne(pool, key){
  const cfg = DATASETS[key];
  if (!cfg) throw new Error(`unknown dataset: ${key}`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const resolution = await resolvePropertyForImport(client, {
      canonical_key: cfg.property_key || null, match_tokens: cfg.property_match || [] });
    const propertyId = resolution.status === "resolved" ? resolution.property_id : null;
    if (!propertyId){
      await client.query("rollback");
      //  Say WHY. "not found" and "matched three buildings" are different
      //  facts, and only one of them is fixed by creating a property.
      return { error: resolution.status === "unresolved" ? "property_not_found" : "property_not_resolved",
               key, resolution_status: resolution.status,
               receipt: resolution.receipt, candidates: resolution.candidates };
    }

    const removed = await deleteExistingBatch(client, propertyId, cfg.source_file);

    const batch = (await client.query(
      `insert into import_batches (property_id, source_type, source_file, source_as_of_date, leasing_model, confidence, status, notes)
       values ($1,'historical_snapshot',$2,$3,$4,$5,'committed',$6) returning id`,
      [propertyId, cfg.source_file, cfg.source_as_of_date, cfg.leasing_model, cfg.confidence,
       `${key} ${cfg.leasing_model}-model snapshot seed, as of ${cfg.source_as_of_date}.`])).rows[0];
    const batchId = batch.id;
    const stamp = ["historical_snapshot", cfg.source_as_of_date, cfg.confidence];

    const unitCache = new Map();        // unit_number -> unit_id
    const spaceByUnit = new Map();      // unit_number -> [space_ids] (current beds, for future reuse)
    const counts = { units:0, beds_current:0, current_occupied:0, current_residents:0,
                     current_leases:0, vacant:0, model:0, down:0, commercial:0,
                     future_residents:0, future_leases:0 };

    async function ensureUnit(unit_number, sqft, market){
      if (unitCache.has(unit_number)) return unitCache.get(unit_number);
      const u = (await client.query(
        `insert into units (property_id, unit_number, square_feet, market_rent, import_batch_id, source_type, source_as_of_date, confidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [propertyId, unit_number, sqft, market, batchId, ...stamp])).rows[0];
      unitCache.set(unit_number, u.id); counts.units++; return u.id;
    }

    // normalize a raw record into named fields, by model
    function norm(rec, section){
      if (cfg.leasing_model === "bed"){
        const [unit, room, type, name, market, actual, deposit, from, to, balance] = rec;
        return { unit, room, type, name, market, actual, deposit, from, to, balance, section,
                 is_commercial:false };
      } else {
        const [unit, type, sqft, name, market, actual, deposit, from, to, balance] = rec;
        return { unit, room:null, type, sqft, name, market, actual, deposit, from, to, balance, section,
                 is_commercial: /comm/i.test(String(type||"")) };
      }
    }

    async function writeRow(rec, section){
      const r = norm(rec, section);
      const isFuture = section === "future";
      // status: name is null → vacant; "MODEL"/"DOWN" → non-revenue keyword
      const nameStr = r.name == null ? "" : String(r.name).trim();
      const isNonRev = NON_REVENUE.test(nameStr) || r.name == null;
      const statusWord = r.name == null ? "vacant" : (NON_REVENUE.test(nameStr) ? nameStr.toLowerCase() : "occupied");

      // unit
      const unitId = await ensureUnit(r.unit, num(r.sqft), num(r.market));

      // space — CURRENT creates a bed/space; FUTURE reuses existing space
      let spaceId = null;
      if (!isFuture){
        const label = cfg.leasing_model === "bed" ? (r.room || "(bed)") : "(whole unit)";
        spaceId = (await client.query(
          `insert into spaces (unit_id, space_label, import_batch_id, source_type, source_as_of_date, confidence)
           values ($1,$2,$3,$4,$5,$6) returning id`,
          [unitId, label, batchId, ...stamp])).rows[0].id;
        counts.beds_current++;
        const arr = spaceByUnit.get(r.unit) || []; arr.push(spaceId); spaceByUnit.set(r.unit, arr);
        if (statusWord === "vacant") counts.vacant++;
        else if (statusWord === "model") counts.model++;
        else if (statusWord === "down") counts.down++;
      } else {
        const arr = spaceByUnit.get(r.unit) || []; spaceId = arr.length ? arr[0] : null;
      }

      // person + lease — only real occupants (not vacant/MODEL/DOWN)
      let personId = null, leaseId = null;
      if (!isNonRev && nameStr){
        //  THE SEED GOES THROUGH THE SAME DOOR. §17: "Demo data may exist.
        //  Demo paths may not." A waiver here would be the leak three feet
        //  from the thing we just fixed — and the gate would have to carry an
        //  exception that quietly becomes the architecture. The authority is
        //  named honestly as what it is.
        const ingested = await personIngress.ingestPerson(client, {
          property_id: propertyId,
          channel: "rent_roll",
          authority: { actor: "seed_snapshot", basis: "QA/demo seed load" },
          evidence: {
            name: nameStr,
            source_record_id: r.resident_id || null,
            import_batch_id: batchId,
            source: "historical_snapshot",
            lifecycle_status: isFuture ? "applicant" : "tenant",
            leasing_stage: isFuture ? "future_resident" : "current_resident",
            normalized: r,
          },
        });
        personId = ingested.person_id || null;
        if (isFuture) counts.future_residents++; else counts.current_residents++;

        if (spaceId && (dt(r.from) || dt(r.to))){
          const leaseStatus = r.is_commercial ? "commercial" : (isFuture ? "pending" : "active");
          if (r.is_commercial) counts.commercial++;
          leaseId = (await client.query(
            `insert into leases (property_id, space_id, tenant_ids, rent, balance, start_date, end_date, lease_status, import_batch_id, source_type, source_as_of_date, confidence)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
            [propertyId, spaceId, [personId], num(r.actual), num(r.balance) ?? 0,
             dt(r.from), dt(r.to), leaseStatus, batchId, ...stamp])).rows[0].id;
          if (isFuture) counts.future_leases++; else { counts.current_leases++; counts.current_occupied++; }
        }
      }

      await client.query(
        `insert into import_source_rows (import_batch_id, raw, produced_unit_id, produced_space_id, produced_person_id, produced_lease_id, parse_note)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [batchId, JSON.stringify(r), unitId, spaceId, personId, leaseId,
         isNonRev ? `${statusWord.toUpperCase()} — no person/lease` : r.is_commercial ? "commercial lease" : isFuture ? "FUTURE (not current occupancy)" : "current resident"]);
    }

    for (const rec of cfg.CURRENT) await writeRow(rec, "current");
    for (const rec of (cfg.FUTURE||[])) await writeRow(rec, "future");

    counts.occupancy_pct = counts.beds_current ? Math.round((counts.current_occupied / counts.beds_current) * 1000)/10 : null;

    await client.query("commit");
    return { ok:true, key, import_batch_id:batchId, property_id:propertyId, removed_prior_batches:removed,
             source_file:cfg.source_file, source_as_of_date:cfg.source_as_of_date, leasing_model:cfg.leasing_model,
             badge:cfg.badge, counts };
  } catch(e){
    await client.query("rollback");
    return { error:"seed_failed", key, detail:e.message };
  } finally { client.release(); }
}

async function rollbackOne(pool, key){
  const cfg = DATASETS[key];
  if (!cfg) throw new Error(`unknown dataset: ${key}`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const resolution = await resolvePropertyForImport(client, {
      canonical_key: cfg.property_key || null, match_tokens: cfg.property_match || [] });
    const propertyId = resolution.status === "resolved" ? resolution.property_id : null;
    if (!propertyId){
      await client.query("rollback");
      return { error: resolution.status === "unresolved" ? "property_not_found" : "property_not_resolved",
               key, resolution_status: resolution.status,
               receipt: resolution.receipt, candidates: resolution.candidates };
    }
    const removed = await deleteExistingBatch(client, propertyId, cfg.source_file);
    await client.query("commit");
    return { ok:true, key, rolled_back_batches:removed };
  } catch(e){ await client.query("rollback"); return { error:"rollback_failed", key, detail:e.message }; }
  finally { client.release(); }
}

// CLI
async function main(){
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{ rejectUnauthorized:false } });
  const args = process.argv.slice(2);
  try {
    if (args[0] === "rollback"){
      const keys = args[1] ? [args[1]] : Object.keys(DATASETS);
      for (const k of keys) console.log(JSON.stringify(await rollbackOne(pool, k), null, 2));
    } else {
      const keys = args[0] ? [args[0]] : Object.keys(DATASETS);
      for (const k of keys) console.log(JSON.stringify(await seedOne(pool, k), null, 2));
    }
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { seedOne, rollbackOne, DATASETS };
