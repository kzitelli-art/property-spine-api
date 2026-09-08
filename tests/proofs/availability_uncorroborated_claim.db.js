/* ════════════════════════════════════════════════════════════════════
   availability_uncorroborated_claim.db.js — AN ACCEPTED OPENING CLAIM
   THAT SAYS OCCUPIED, WITH NO OPERATIVE LEASE, IS A CLAIM AND NOT AN OFFER.

   Two modes on one fixture:
     PROOF_EXPECT_DEFECT=1   witness — run with PROOF_BUSINESS_ROOT at the
                             parent (3df9ed9): the uncorroborated bed is
                             offered marketable_now and listed by the
                             application selector.
     (unset)                 successor — the same bed reads `occupied`
                             with reason opening_claim_occupied_uncorroborated
                             and is not an application target.

   FIXTURE CLASSIFICATION. The uncorroborated shape is built from a
   directly promoted opening claim. The CURRENT confirmation writer
   creates a lease when it confirms an occupied row (section 0 exercises
   that and shows evidence_state 'confirmed'), so this shape is retained
   data from older promotions or direct status writes, not something a
   fresh confirmation produces. Nothing here reinterprets the claim as
   vacancy or edits the historical source row.

   Controls kept on the same property: a confirmed vacancy (offered), a
   native operative lease (occupied via spanning_lease), a pending future
   commitment (successor_pending), a contested bed, an uncorroborated bed
   on a DOWN unit (down wins), an uncorroborated bed on a unit with a
   pending initial walk (occupied, not readiness_unknown), a position with
   no claim at all (occupancy_unknown), and a maintenance-only seat (403).
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const activation = require(path.join(root, "src/onboarding/activation_service.js"));
const artifacts = require(path.join(root, "src/onboarding/source_artifact_service.js"));
const deals = require(path.join(root, "src/onboarding/deal_service.js"));
const sessions = require(path.join(root, "src/identity/staff_session_service.js"));
const { readTenancyStanding } = require(path.join(root, "src/tenancy/tenancy_position_read.js"));
const { unitRentRoll } = require(path.join(root, "src/surfaces/rent_roll_unit_view.js"));
const { currentRentRoll } = require(path.join(root, "src/surfaces/rent_roll_canonical.js"));
const { resolveApplicationTarget } = require(path.join(root, "src/applications/application_target_authority.js"));

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const AS_OF = "2026-07-31";
const api = process.env.E2E_API_BASE || null;
if (!api) { console.error("This proof exercises HTTP doors; set E2E_API_BASE (owned server)."); process.exit(1); }
const OPERATOR_KEY = process.env.PROOF_OPERATOR_KEY || "e2e-key";
const evidence = { mode: parent ? "positive_defect_witness" : "successor", calls: [] };
const rung = (name, how) => { if (!evidence.calls.find((c) => c.name === name)) evidence.calls.push({ name, how }); };

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  try {
    const tag = `uncorroborated-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const mkUser = async (name, key) => {
      const person = await one("insert into persons(name) values($1) returning id", [name]);
      return one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
        values($1,$2,'org_admin',$3,$4,true,'active','human_staff') returning id`, [name, `${tag}-${key}@example.test`, org.id, person.id]);
    };
    const operator = await mkUser("Synthetic Claim Operator", "op");
    const maintOnly = await mkUser("Synthetic Maintenance Only", "maint");
    const resident = async (n) => (await one("insert into persons(name) values($1) returning id", [`Synthetic Resident ${n}`])).id;
    const http = async (name, token, url, { method = "GET", body = null, key = null } = {}) => {
      rung(name, "HTTP");
      const headers = {}; if (token) headers["x-staff-session"] = token; if (key) headers["x-operator-key"] = key;
      let payload; if (method !== "GET") { headers["content-type"] = "application/json"; payload = JSON.stringify(body || {}); }
      const r = await fetch(api + url, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
      let json = null; try { json = await r.json(); } catch (_) { json = null; }
      return { status: r.status, body: json };
    };
    const session = async (userId, propertyId) => {
      const c = await pool.connect();
      try { await c.query("begin"); const t = (await sessions.issueStaffSession(c, { userId, propertyId, purpose: "sms_otp" })).session_token; await c.query("commit"); return t; } finally { c.release(); }
    };
    async function property(name) {
      const deal = await deals.createDeal(pool, { user_id: operator.id, deal_name: `${tag}-${name}`, creation_source: "deal_setup_console" });
      const p = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id", [`${tag}-${name}`, org.id]);
      await deals.addProperty(pool, { user_id: operator.id, deal_intake_id: deal.id, property_id: p.id });
      for (const [u, mods] of [[operator, "{management,leasing,maintenance}"], [maintOnly, "{maintenance}"]]) {
        await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Proof Seat',$3,true)", [p.id, u.id, mods]);
      }
      return { id: p.id, deal: deal.id, name, token: await session(operator.id, p.id), maintToken: await session(maintOnly.id, p.id) };
    }

    // ── 0. WHAT THE CURRENT CONFIRMATION WRITER PRODUCES FOR AN OCCUPIED ROW ──
    //  Retained-source activation ingest → confirm. Shows the shape a fresh
    //  confirmation leaves behind, so the fixture below is classified honestly.
    const W = await property("writer");
    {
      const csv = "Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n101,Room1,Synthetic Resident W,900,850,2026-01-01,2027-12-31\n";
      await pool.query("insert into units(property_id,unit_number) values($1,'101')", [W.id]);
      const u = await one("select id from units where property_id=$1 and unit_number='101'", [W.id]);
      await pool.query("update spaces set space_label='Room1', position_kind='bed', use_type='residential' where unit_id=$1", [u.id]);
      const act = (await activation.openActivation(pool, { user_id: operator.id, deal_intake_id: W.deal, property_id: W.id })).activation;
      const artifact = await artifacts.store(pool, { scope_type: "property", scope_id: W.id, filename: "writer.csv", mimetype: "text/csv", buffer: Buffer.from(csv), uploaded_by_user_id: operator.id, source_as_of_date: AS_OF });
      await activation.ingestRentRoll(pool, { user_id: operator.id, deal_intake_id: W.deal, property_id: W.id, activation_id: act.id, source_artifact_id: artifact.id, source_as_of_date: AS_OF });
      const proposals = (await activation.readActivation(pool, { user_id: operator.id, activation_id: act.id })).proposals;
      let confirmed = null; try { confirmed = await activation.confirmProposal(pool, { user_id: operator.id, proposed_id: proposals[0].id }); } catch (e) { confirmed = { error: String(e.publicMessage || e.message) }; }
      await activation.establishOpeningPosition(pool, { user_id: operator.id, activation_id: act.id });
      rung("activation ingest/confirm/establish (writer classification)", "service");
      const leases = (await one("select count(*)::int as n from leases where property_id=$1", [W.id])).n;
      const canon = await currentRentRoll(pool, { property_id: W.id, as_of: AS_OF });
      const row = canon.rows.find((r) => r.unit_number === "101");
      evidence.writer = { confirmed: confirmed && !confirmed.error ? { lease_id: confirmed.lease_id } : confirmed, leases, evidence_state: row && row.evidence_state, tenancy_state: row && row.tenancy_state };
      ok("0 (fixture classification): the CURRENT confirmation writer confirms an occupied row by creating a lease — evidence_state 'confirmed', tenancy 'contractually_occupied'; the uncorroborated shape below is therefore retained data, not a fresh confirmation",
        leases === 1 && row && row.evidence_state === "confirmed" && row.tenancy_state === "contractually_occupied", JSON.stringify(evidence.writer));
    }

    // ── THE FIXTURE (direct rows — the retained historical shape) ──────
    const P = await property("claims");
    const units = {}, spaces = {};
    for (const n of ["301", "302", "303", "304", "305", "306"]) {
      const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [P.id, n]); units[n] = u.id;
      const placeholder = await one("select id from spaces where unit_id=$1", [u.id]);
      spaces[`${n}|Room1`] = (await one("update spaces set space_label='Room1', position_kind='bed', use_type='residential' where id=$1 returning id", [placeholder.id])).id;
      spaces[`${n}|Room2`] = (await one("insert into spaces(unit_id,space_label,position_kind,use_type) values($1,'Room2','bed','residential') returning id", [u.id])).id;
    }
    const lease = (key, rent, from, to, status = "active") => one("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,$4,$5,$6,$7) returning id", [P.id, spaces[key], [null], rent, from, to, status]);
    const rA = await resident("A"), rC1 = await resident("C1"), rC2 = await resident("C2"), rF = await resident("F");
    await pool.query("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,850,'2026-01-01','2027-12-31','active')", [P.id, spaces["301|Room1"], [rA]]);
    await pool.query("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,700,'2026-01-01','2027-12-31','active')", [P.id, spaces["303|Room1"], [rC1]]);
    await pool.query("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,750,'2026-03-01','2027-02-28','active')", [P.id, spaces["303|Room1"], [rC2]]);
    await pool.query("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,900,'2026-09-01','2027-08-31','pending')", [P.id, spaces["304|Room2"], [rF]]);
    void lease;
    const occupiedClaim = (n, name) => ({ status: "current", is_vacant: false, tenant_name: name, actual_rent: 800, start_date: "2026-01-01", end_date: "2027-12-31" });
    const CLAIMS = {
      "301|Room1": occupiedClaim("301", "Synthetic Resident A"),          // occupied WITH lease → confirmed
      "301|Room2": { status: "vacant", is_vacant: true },                  // confirmed vacancy
      "302|Room1": occupiedClaim("302", "Synthetic Resident D"),          // UNCORROBORATED on a unit that will be DOWN
      "302|Room2": { status: "vacant", is_vacant: true },
      "303|Room1": occupiedClaim("303", "Synthetic Resident C1"),         // contested (two leases)
      "303|Room2": occupiedClaim("303", "Synthetic Resident E"),          // UNCORROBORATED — the defect shape, no other overlay
      "304|Room1": { status: "vacant", is_vacant: true },                  // confirmed vacancy
      "304|Room2": { status: "vacant", is_vacant: true },                  // vacant claim + pending future lease → committed
      "305|Room1": { status: "vacant", is_vacant: true },
      // 305|Room2: NO claim at all → occupancy_unknown
      "306|Room1": occupiedClaim("306", "Synthetic Resident G"),          // UNCORROBORATED on a unit with a pending initial walk
      "306|Room2": { status: "vacant", is_vacant: true },
    };
    const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
      values($1,'rent_roll_ledger','claims.csv',$2,'bed','confirmed','committed') returning id`, [P.id, AS_OF]);
    const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
      values($1,$2,'activated',$3,$4,$5) returning id`, [P.deal, P.id, AS_OF, batch.id, operator.id]);
    let i = 0;
    for (const [key, c] of Object.entries(CLAIMS)) {
      const [n, label] = key.split("|"); i += 1;
      const claim = { section: "current", unit_number: n, space_label: label, ...c };
      const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
        values($1,$2,$3,'synthetic: confirmed row',$4,$5) returning id`, [batch.id, i, JSON.stringify(claim), units[n], spaces[key]]);
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`, [act.id, P.id, key, JSON.stringify(claim), ev.id, String(operator.id)]);
    }
    await one(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
      positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
      values($1,$2,$3,$4,$5,11,1,11,$6,'platform_role:super_admin','established') returning id`, [P.id, P.deal, act.id, batch.id, AS_OF, operator.id]);
    //  Down on 302 (uncorroborated bed under a hold); pending initial walk on 306.
    const down = await http("units/:id/down", null, `/units/${units["302"]}/down`, { method: "POST", key: OPERATOR_KEY, body: { down_reason: "hvac", down_blocker: "synthetic hold" } });
    await pool.query("insert into obligations(property_id,unit_id,module,type,status,label) values($1,$2,'maintenance','initial_unit_walk','open','walk 306')", [P.id, units["306"]]);

    // ── LEASE SNAPSHOT BEFORE ANY READ ───────────────────────────────
    //  Every column of every lease row on the property, ordered by id, so a
    //  changed rent, date, status, tenant, or a replaced row is detected —
    //  not only the count.
    const leaseRows = async () => (await pool.query("select * from leases where property_id=$1 order by id", [P.id])).rows;
    const leasesBefore = await leaseRows();

    // ── READS ────────────────────────────────────────────────────────
    const av = await http("availability-canonical", P.token, `/operator/leasing/availability-canonical?as_of=${AS_OF}`);
    const lu = await http("leaseable-units", P.token, `/operator/leasing/leaseable-units`);
    const refused = await http("availability-canonical (maintenance-only seat)", P.maintToken, `/operator/leasing/availability-canonical?as_of=${AS_OF}`);
    rung("resolveApplicationTarget", "service");
    const target = await resolveApplicationTarget(pool, { property_id: P.id, unit_id: units["303"], space_id: spaces["303|Room2"] });
    rung("readTenancyStanding", "service"); const standing = await readTenancyStanding(pool, { property_id: P.id, as_of: AS_OF });
    rung("unitRentRoll", "service"); const rr = await unitRentRoll(pool, { property_id: P.id, as_of: AS_OF });
    rung("currentRentRoll", "service"); const canon = await currentRentRoll(pool, { property_id: P.id, as_of: AS_OF });
    const row = (k) => { const [u, l] = k.split("|"); return (av.body.rows || []).find((r) => r.unit_number === u && r.space_label === l) || {}; };
    const targets = (lu.body && lu.body.eligible_targets || []).map((t) => `${t.unit_number}|${t.space_label}`).sort();
    const bucket = (k) => { const [u, l] = k.split("|"); const un = (rr.units || []).find((x) => x.unit_number === u); return un && (un.positions.find((p) => p.label === l) || {}).bucket; };
    const canonRow = (k) => { const [u, l] = k.split("|"); return (canon.rows || []).find((r) => r.unit_number === u && r.space_label === l) || {}; };
    const shape = (k) => { const r = row(k); return { state: r.marketing_state, reason: r.blocking_reason, evidence: r.evidence_state, tenancy: r.tenancy_state, basis_type: r.basis_type, available_from: r.available_from, blocking_fact: r.blocking_fact }; };
    const S = Object.fromEntries(["301|Room1", "301|Room2", "302|Room1", "303|Room1", "303|Room2", "304|Room1", "304|Room2", "305|Room2", "306|Room1", "306|Room2"].map((k) => [k, shape(k)]));
    evidence.rows = S; evidence.targets = targets; evidence.target_303_room2 = { offerable: target.offerable === true, refusal_code: target.refusal_code || null, refusal_reason: target.refusal_reason || null };
    evidence.standing = { occupied: standing.position.occupied, open: standing.position.open, needs_review: standing.position.needs_review, rentable_positions: standing.position.rentable_positions };
    evidence.rent_roll_bucket_303_room2 = bucket("303|Room2"); evidence.canonical_303_room2 = { tenancy_state: canonRow("303|Room2").tenancy_state, evidence_state: canonRow("303|Room2").evidence_state };
    evidence.headline = av.body.headline; evidence.states = av.body.states; evidence.down = down.status; evidence.entitlement_refusal = refused.status;
    for (const [k, v] of Object.entries(S)) console.log(`  ${k}: ${JSON.stringify(v)}`);
    console.log(`  targets: ${JSON.stringify(targets)}  303|Room2 target: ${JSON.stringify(evidence.target_303_room2)}  standing: ${JSON.stringify(evidence.standing)}  bucket: ${evidence.rent_roll_bucket_303_room2}  canonical: ${JSON.stringify(evidence.canonical_303_room2)}`);

    ok("reads: availability 200, leaseable-units 200, down accepted 201", av.status === 200 && lu.status === 200 && down.status === 201, JSON.stringify([av.status, lu.status, down.status]));
    ok("the dated position already classifies 303 Room2 as evidence 'uncorroborated', tenancy 'unresolved', basis opening_claim_occupied — the same fields the availability read receives", S["303|Room2"].evidence === "uncorroborated" && S["303|Room2"].tenancy === "unresolved" && S["303|Room2"].basis_type === "opening_claim_occupied", JSON.stringify(S["303|Room2"]));
    if (parent) {
      ok("(defect) 303 Room2 — source says occupied, Spine holds no lease — is offered marketable_now over HTTP", S["303|Room2"].state === "marketable_now", JSON.stringify(S["303|Room2"]));
      ok("(defect) the application selector lists 303 Room2 as an eligible target over HTTP", targets.includes("303|Room2"), JSON.stringify(targets));
      ok("(defect) the application authority says 303 Room2 is offerable", evidence.target_303_room2.offerable === true, JSON.stringify(evidence.target_303_room2));
      ok("(parent, observed) the uncorroborated bed on the unit with a pending walk reads readiness_unknown — a readiness overlay, not the occupancy fact, is what held it", S["306|Room1"].state === "readiness_unknown", JSON.stringify(S["306|Room1"]));
      ok("(parent) states: marketable 4 includes the uncorroborated bed; occupied counts only the lease; the unit-level walk holds both 306 beds as readiness_unknown", av.body.states.marketable_now === 4 && av.body.states.occupied === 1 && av.body.states.readiness_unknown === 2, JSON.stringify(av.body.states));
    } else {
      ok("303 Room2 reads 'occupied' with reason opening_claim_occupied_uncorroborated, no available_from, blocking fact named", S["303|Room2"].state === "occupied" && S["303|Room2"].reason === "opening_claim_occupied_uncorroborated" && S["303|Room2"].available_from === null && S["303|Room2"].blocking_fact === "opening_claim_occupied_uncorroborated", JSON.stringify(S["303|Room2"]));
      ok("the application selector no longer lists 303 Room2; it still lists the confirmed vacancies 301 Room2, 304 Room1 and 305 Room1", !targets.includes("303|Room2") && targets.join("|") === "301|Room2|304|Room1|305|Room1", JSON.stringify(targets));
      ok("the application authority refuses 303 Room2 with not_offerable", evidence.target_303_room2.offerable === false && evidence.target_303_room2.refusal_code === "not_offerable", JSON.stringify(evidence.target_303_room2));
      ok("the uncorroborated bed on a unit with a pending initial walk (306 Room1) reads occupied, not readiness_unknown", S["306|Room1"].state === "occupied" && S["306|Room1"].reason === "opening_claim_occupied_uncorroborated", JSON.stringify(S["306|Room1"]));
      ok("states: occupied 3 (one lease, two uncorroborated claims; the down one counts as down), marketable 3 (confirmed vacancies not under a hold or a pending walk), readiness_unknown 1 (306 Room2 only — the walk no longer masks 306 Room1)", av.body.states.occupied === 3 && av.body.states.marketable_now === 3 && av.body.states.down === 2 && av.body.states.readiness_unknown === 1, JSON.stringify(av.body.states));
    }
    //  Controls, both modes.
    ok("control: confirmed vacancy 301 Room2 is marketable_now", S["301|Room2"].state === "marketable_now");
    ok("control: native operative lease 301 Room1 is occupied via spanning_lease, evidence 'confirmed'", S["301|Room1"].state === "occupied" && S["301|Room1"].reason === "spanning_lease" && S["301|Room1"].evidence === "confirmed");
    ok("control: pending future commitment 304 Room2 is successor_pending (not offered, not occupied)", S["304|Room2"].state === "successor_pending", JSON.stringify(S["304|Room2"]));
    ok("control: contested 303 Room1 stays contested", S["303|Room1"].state === "contested");
    ok("control: uncorroborated bed on a DOWN unit reads down — the hold precedes the claim", S["302|Room1"].state === "down" && S["302|Room1"].evidence === "uncorroborated", JSON.stringify(S["302|Room1"]));
    ok("control: a position with no claim at all is occupancy_unknown", S["305|Room2"].state === "occupancy_unknown");
    ok("control: 304 Room1 stays marketable_now (physical readiness untouched)", S["304|Room1"].state === "marketable_now");
    ok("control: a maintenance-only seat is refused 403 at the availability read", refused.status === 403);
    ok("reconciliation: unit Rent Roll buckets 303 Room2 'occupied'; standing counts it occupied; the canonical rent roll keeps 'unresolved' on its contractual axis — the claim supports occupancy, nothing supports an offer, and no measure was forced to agree",
      bucket("303|Room2") === "occupied" && standing.position.occupied === 4 && canonRow("303|Room2").tenancy_state === "unresolved" && canonRow("303|Room2").evidence_state === "uncorroborated", JSON.stringify([bucket("303|Room2"), evidence.standing, evidence.canonical_303_room2]));
    const leasesAfter = await leaseRows();
    evidence.lease_rows = { before: leasesBefore.length, after: leasesAfter.length, identical: JSON.stringify(leasesBefore) === JSON.stringify(leasesAfter) };
    ok("no lease row was created, replaced or changed by any read — 4 rows before, 4 after, every column of every row identical", leasesBefore.length === 4 && leasesAfter.length === 4 && evidence.lease_rows.identical, JSON.stringify(evidence.lease_rows));

    if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `availability-uncorroborated-claim-${parent ? "witness" : "successor"}.json`), JSON.stringify(evidence, null, 2));
  } finally { await pool.end(); }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
