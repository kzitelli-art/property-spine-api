#!/usr/bin/env node
"use strict";

/* Real HTTP proof for the retained-source -> reviewed canonical-home seam.
 * Fixture SQL creates actor/inventory shapes only. Every source preview,
 * decision, apply, confirmation and repeated-source operation crosses the
 * mounted Deal Setup routes on the fenced server. */

const http = require("node:http");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");
const boundary = require("../e2e/proof_boundary.js");
const { materializeRentableSpaces } = require("../../src/tenancy/inventory_materialization.js");

const DB_URL = receipt.harnessConnectionString();
boundary.manifest();
const BASE = new URL(process.env.E2E_API_BASE || "http://127.0.0.1:3352");
const pool = new Pool({ connectionString: DB_URL, ssl: false });
const TAG = `SHIR_${process.pid}_${crypto.randomBytes(3).toString("hex")}`;
let passed = 0, failed = 0;
function ok(label, condition, detail = "") {
  if (condition) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
}

function request(method, pathname, token, body, rawHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { "x-staff-session": token, "x-proof-run": process.env.PROOF_RUN_NONCE || "",
      ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}), ...rawHeaders };
    const req = http.request({ hostname: BASE.hostname, port: BASE.port, method, path: pathname, headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject); if (bytes) req.write(bytes); req.end();
  });
}

function multipart(filename, csv, asOf) {
  const mark = `----spine-${crypto.randomBytes(8).toString("hex")}`;
  return { bytes: Buffer.concat([
    Buffer.from(`--${mark}\r\nContent-Disposition: form-data; name="source_as_of_date"\r\n\r\n${asOf}\r\n`),
    Buffer.from(`--${mark}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(csv), Buffer.from(`\r\n--${mark}--\r\n`),
  ]), type: `multipart/form-data; boundary=${mark}` };
}

async function upload(deal, property, token, filename, csv, asOf = "2026-09-13") {
  const mp = multipart(filename, csv, asOf);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: BASE.hostname, port: BASE.port, method: "POST",
      path: `/deal-setup/deals/${deal}/properties/${property}/source`, headers: {
        "x-staff-session": token, "x-proof-run": process.env.PROOF_RUN_NONCE || "",
        "content-type": mp.type, "content-length": mp.bytes.length,
      } }, res => { const chunks=[]; res.on("data",c=>chunks.push(c)); res.on("end",()=>{
        const text=Buffer.concat(chunks).toString("utf8"); let body=null; try{body=JSON.parse(text);}catch{body={text};}
        resolve({status:res.statusCode,body}); }); });
    req.on("error",reject); req.end(mp.bytes);
  });
}

async function counts(property) {
  return (await pool.query(
    `select p.leasing_basis,
            (select count(*)::int from units u where u.property_id=p.id) units,
            (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=p.id) spaces,
            (select count(*)::int from import_batches b where b.property_id=p.id) batches
       from properties p where p.id=$1`, [property])).rows[0];
}

async function makeProperty(deal, token, name) {
  const r = await request("POST", `/deal-setup/deals/${deal}/properties/new`, token, { name });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  return r.body.property.id;
}

async function open(deal, property, token) {
  const r = await request("POST", `/deal-setup/deals/${deal}/properties/${property}/activation`, token, {});
  if (![200,201].includes(r.status)) throw new Error(JSON.stringify(r));
  return r.body.activation.id;
}

const csv = rows => ["Unit,Room,Resident,Status,Market Rent,Actual Rent",
  ...rows.map(r => `${r[0]},${r[1]},VACANT,VACANT,${r[2] || 900},`)].join("\n");

(async () => {
  receipt.begin(__filename, { url: DB_URL, expected: 54 });
  await boundary.assertDatabase();
  const org = (await pool.query(`insert into organizations(name,slug) values($1,$2) returning id`,
    [TAG, TAG.toLowerCase()])).rows[0].id;
  const person = (await pool.query(`insert into persons(name) values($1) returning id`, [TAG])).rows[0].id;
  const user = (await pool.query(
    `insert into users(name,email,platform_role,organization_id,is_active,status,person_id)
     values($1,$2,'org_admin',$3,true,'active',$4) returning id`,
    [TAG, `${TAG}@example.test`, org, person])).rows[0].id;
  const seat = (await pool.query(`insert into properties(name,canonical_key,organization_id) values($1,$2,$3) returning id`,
    [`${TAG} seat`, `${TAG}-SEAT`, org])).rows[0].id;
  await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active)
                    values($1,$2,'review',array['leasing','management'],true)`, [seat,user]);
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(`insert into staff_sessions(user_id,property_id,token,token_digest,issuance_purpose,expires_at)
                    values($1,$2,null,$3,'bootstrap_invite',now()+interval '4 hours')`,
    [user,seat,crypto.createHash("sha256").update(token).digest("hex")]);
  const madeDeal = await request("POST", "/deal-setup/deals", token, { deal_name: TAG });
  const deal = madeDeal.body.deal.id;
  ok("H1 real mounted Deal Setup creates the proof deal", madeDeal.status === 201);

  // Greenery contract shape: 171 retained parents each have the provisional
  // whole-unit space. The source reviews 105 beds under 64 of those parents.
  const greenery=await makeProperty(deal,token,`${TAG} greenery-shape`);
  await pool.query(`insert into units(property_id,unit_number)
    select $1,'1325-'||lpad(g::text,3,'0') from generate_series(1,171) g`,[greenery]);
  const originalPlaceholders=(await pool.query(`select u.id unit_id,u.unit_number,s.id space_id
    from units u join spaces s on s.unit_id=u.id and s.space_label='(whole unit)'
    where u.property_id=$1 order by u.unit_number`,[greenery])).rows;
  const greeneryRows=[];
  for(let n=1;n<=64;n++){
    greeneryRows.push([`1325-${String(n).padStart(3,"0")}`,"Room1",900+n]);
    if(n<=41) greeneryRows.push([`1325-${String(n).padStart(3,"0")}`,"Room2",950+n]);
  }
  const greeneryCsv=csv(greeneryRows), greeneryAct=await open(deal,greenery,token);
  const greeneryUp=await upload(deal,greenery,token,"greenery-shape.csv",greeneryCsv);
  const greeneryBefore=await counts(greenery);
  const greeneryPreview=await request("POST",`/deal-setup/activations/${greeneryAct}/preview-source`,token,
    {source_artifact_id:greeneryUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"});
  ok("G1 171-parent preview is read-only",greeneryPreview.status===200&&JSON.stringify(await counts(greenery))===JSON.stringify(greeneryBefore));
  ok("G2 all 105 reviewed beds propose the existing-parent child-set action",greeneryPreview.body.identities.length===105&&greeneryPreview.body.identities.every(x=>x.suggested_decision&&x.suggested_decision.action==="create_children"));
  const greeneryApply=await request("POST",`/deal-setup/activations/${greeneryAct}/read-source`,token,{
    source_artifact_id:greeneryUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",
    source_token:greeneryPreview.body.source_token,inventory_decisions:greeneryPreview.body.identities.map(x=>({key:x.key,...x.suggested_decision}))});
  const greeneryAfter=await counts(greenery);
  ok("G3 reviewed source yields 105 beds under 64 existing parents and no new units",greeneryApply.status===201&&greeneryAfter.units===171&&greeneryAfter.spaces===212,`${greeneryApply.status} ${JSON.stringify(greeneryAfter)}`);
  const preserved=(await pool.query(`select count(*)::int n from (values ${originalPlaceholders.slice(0,64).map((_,i)=>`($${i+1}::uuid)`).join(",")}) v(id)
    join spaces s on s.id=v.id where s.space_label<>'(whole unit)'`,originalPlaceholders.slice(0,64).map(x=>x.space_id))).rows[0].n;
  ok("G4 pristine placeholders keep their IDs when becoming first approved beds",preserved===64,`preserved=${preserved}`);
  const untouched=(await pool.query(`select count(*)::int n from units u join spaces s on s.unit_id=u.id
    where u.property_id=$1 and u.unit_number>'1325-064' and s.space_label='(whole unit)'
      and not exists(select 1 from proposed_records d where d.property_id=$1 and d.target_type='inventory_identity' and d.selected_unit_id=u.id)`,[greenery])).rows[0].n;
  ok("G5 107 source-unreferenced identities remain untouched and undecided",untouched===107,`untouched=${untouched}`);

  // Existing-inventory shape: exact text is a candidate; prefix text is not.
  const existing = await makeProperty(deal, token, `${TAG} existing`);
  const unit = (await pool.query(`insert into units(property_id,unit_number) values($1,'HOME-01') returning id`, [existing])).rows[0].id;
  await materializeRentableSpaces(pool, { unit_id: unit, labels: ["A","B"], kind: "bed" });
  const prefix = (await pool.query(`insert into units(property_id,unit_number) values($1,'HOME-010') returning id`, [existing])).rows[0].id;
  await materializeRentableSpaces(pool, { unit_id: prefix, labels: ["A"], kind: "bed" });
  const retired = (await pool.query(`insert into units(property_id,unit_number) values($1,'RETIRED-01') returning id`, [existing])).rows[0].id;
  await materializeRentableSpaces(pool, { unit_id: retired, labels: ["R"], kind: "bed" });
  await pool.query(`insert into inventory_retirements(unit_id,property_id,retired_by_system,reason_code,
      superseded_rationale,original_unit_number) values($1,$2,'source-home-proof',
      'superseded_by_corrected_inventory_grain','Proof-only retired candidate remains history.', 'RETIRED-01')`, [retired,existing]);
  for (const label of ["DUP-01","dup-01"]) {
    const d=(await pool.query(`insert into units(property_id,unit_number) values($1,$2) returning id`,[existing,label])).rows[0].id;
    await materializeRentableSpaces(pool,{unit_id:d,labels:["D"],kind:"bed"});
  }
  const existingAct = await open(deal, existing, token);
  const existingCsv = csv([["HOME-01","A",900],["HOME","B",925],["RETIRED-01","R",930],["DuP-01","D",940]]);
  const existingUp = await upload(deal, existing, token, "existing-shape.csv", existingCsv);
  const beforePreview = await counts(existing);
  const preview = await request("POST", `/deal-setup/activations/${existingAct}/preview-source`, token,
    { source_artifact_id: existingUp.body.artifact.id, source_as_of_date:"2026-09-13", leasing_basis:"bed" });
  const afterPreview = await counts(existing);
  ok("H2 preview succeeds from retained bytes", preview.status === 200 && preview.body.rows_read === 4, JSON.stringify(preview.body).slice(0,200));
  ok("H3 preview performs no operating writes, including leasing basis", JSON.stringify(beforePreview) === JSON.stringify(afterPreview), `${JSON.stringify(beforePreview)} -> ${JSON.stringify(afterPreview)}`);
  const exact = preview.body.identities.find(x=>x.source.unit_number==="HOME-01");
  const noPrefix = preview.body.identities.find(x=>x.source.unit_number==="HOME");
  const retiredOnly = preview.body.identities.find(x=>x.source.unit_number==="RETIRED-01");
  const ambiguous = preview.body.identities.find(x=>x.source.unit_number==="DuP-01");
  ok("H4 exact text is shown with canonical hierarchy as a suggestion", exact.exact_candidates.length===1 && exact.suggested_decision.space_id);
  ok("H5 prefix text is unfamiliar and never auto-selected", noPrefix.status==="unfamiliar" && !noPrefix.suggested_decision);
  ok("H6 retired-only text is truthful and not selected", retiredOnly.status==="retired_only" && !retiredOnly.suggested_decision);
  ok("H7 duplicate exact identities are ambiguous and not selected", ambiguous.status==="ambiguous_exact_match" && !ambiguous.suggested_decision);
  const noDecisions = await request("POST", `/deal-setup/activations/${existingAct}/read-source`, token,
    { source_artifact_id:existingUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",
      source_token:preview.body.source_token,inventory_decisions:[] });
  ok("H8 apply without explicit grouped decisions refuses", noDecisions.status===422 && noDecisions.body.reason==="inventory_identity_decision_required", JSON.stringify(noDecisions.body));
  ok("H9 refused apply leaves inventory and basis unchanged", JSON.stringify(await counts(existing))===JSON.stringify(beforePreview));

  // Use a smaller corrected source for the apply; every current group has a decision.
  const mappedAct = existingAct;
  const mappedCsv = csv([["HOME-01","A",900],["HOME","B",925]]);
  const mappedUp = await upload(deal, existing, token, "existing-mapped.csv", mappedCsv);
  const mappedPreview = await request("POST", `/deal-setup/activations/${mappedAct}/preview-source`, token,
    {source_artifact_id:mappedUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"});
  const srcA=mappedPreview.body.identities.find(x=>x.source.unit_number==="HOME-01");
  const srcB=mappedPreview.body.identities.find(x=>x.source.unit_number==="HOME");
  const home= mappedPreview.body.available_units.find(x=>x.id===unit);
  const bedB=home.spaces.find(x=>x.label==="B");
  const inventoryBeforeApply=await counts(existing);
  const applied=await request("POST",`/deal-setup/activations/${mappedAct}/read-source`,token,{
    source_artifact_id:mappedUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",
    source_token:mappedPreview.body.source_token,inventory_decisions:[
      {key:srcA.key,...srcA.suggested_decision},
      {key:srcB.key,action:"select_existing",unit_id:unit,space_id:bedB.id,fingerprint:bedB.fingerprint},
    ]});
  ok("H10 explicit existing-target apply succeeds",applied.status===201,JSON.stringify(applied.body).slice(0,220));
  const inventoryAfterApply=await counts(existing);
  ok("H11 existing canonical units and spaces are retained without additions",inventoryAfterApply.units===inventoryBeforeApply.units&&inventoryAfterApply.spaces===inventoryBeforeApply.spaces);
  const attached=(await pool.query(`select pr.id,pr.normalized_json,isr.raw,isr.produced_unit_id,isr.produced_space_id,
      d.selected_unit_id,d.selected_space_id,d.payload_json
      from proposed_records pr join import_source_rows isr on isr.id=pr.import_source_row_id
      join proposed_records d on d.id=pr.inventory_identity_decision_id
      where pr.activation_id=$1 and pr.target_type='lease' order by isr.row_index`,[mappedAct])).rows;
  ok("H12 original source cells and normalized source labels remain unchanged",attached[1].raw._source_cells.Unit==="HOME"&&attached[1].normalized_json.unit_number==="HOME"&&attached[1].payload_json.source_claim.unit_number==="HOME");
  ok("H13 evidence, lease proposal and decision share the approved durable IDs",attached[1].produced_unit_id===unit&&attached[1].produced_space_id===bedB.id&&attached[1].selected_unit_id===unit&&attached[1].selected_space_id===bedB.id);
  await pool.query(`insert into units(property_id,unit_number) values($1,'UNRELATED')`,[existing]);
  const confirmA=await request("POST",`/deal-setup/proposals/${attached[0].id}/confirm`,token,{});
  ok("H14 unrelated inventory change does not invalidate confirmation",confirmA.status===200&&confirmA.body.vacant===true,JSON.stringify(confirmA.body));
  await pool.query(`update spaces set space_label='B-DRIFT' where id=$1`,[bedB.id]);
  const confirmDrift=await request("POST",`/deal-setup/proposals/${attached[1].id}/confirm`,token,{});
  ok("H15 selected target/hierarchy drift refuses confirmation",confirmDrift.status===409&&confirmDrift.body.reason==="inventory_identity_target_changed",JSON.stringify(confirmDrift.body));
  ok("H16 confirmation never created a replacement from source label",(await counts(existing)).units===inventoryAfterApply.units+1);

  // Fresh unfamiliar shape: one reviewed parent, two reviewed rooms.
  const fresh=await makeProperty(deal,token,`${TAG} fresh`), freshAct=await open(deal,fresh,token);
  const freshCsv=csv([["FRESH-01","A",800],["FRESH-01","B",825]]);
  const freshUp=await upload(deal,fresh,token,"fresh-shape.csv",freshCsv);
  const freshPreview=await request("POST",`/deal-setup/activations/${freshAct}/preview-source`,token,
    {source_artifact_id:freshUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"});
  ok("H17 unfamiliar fresh source proposes explicit new decisions",freshPreview.body.identities.every(x=>x.suggested_decision&&x.suggested_decision.action==="create_new"));
  ok("H18 fresh preview leaves zero units and unknown basis",(await counts(fresh)).units===0&&(await counts(fresh)).leasing_basis==="unknown");
  await pool.query(`insert into units(property_id,unit_number) values($1,'UNRELATED')`,[fresh]);
  const freshApplied=await request("POST",`/deal-setup/activations/${freshAct}/read-source`,token,{
    source_artifact_id:freshUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",
    source_token:freshPreview.body.source_token,inventory_decisions:freshPreview.body.identities.map(x=>({key:x.key,...x.suggested_decision}))});
  ok("H19 unrelated new inventory does not stale scoped new-target review",freshApplied.status===201,JSON.stringify(freshApplied.body).slice(0,180));
  const freshShape=await counts(fresh);
  ok("H20 two source rooms group under one approved new parent",freshShape.units===2&&freshShape.spaces===3&&freshShape.leasing_basis==="bed",JSON.stringify(freshShape));
  const freshRead=await request("GET",`/deal-setup/activations/${freshAct}`,token);
  const freshRows=freshRead.body.proposals;
  const freshConfirm=await request("POST",`/deal-setup/proposals/${freshRows[0].id}/confirm`,token,{});
  ok("H21 fresh reviewed attachment confirms vacancy",freshConfirm.status===200&&freshConfirm.body.vacant===true);
  const established=await request("POST",`/deal-setup/activations/${freshAct}/establish`,token,{});
  ok("H22 fresh reviewed source can establish its bounded position",established.status===201);

  // Same bytes: explicit decision reuse, fresh evidence lineage, no inventory.
  const repeatAct=await open(deal,fresh,token);
  const repeatUp=await upload(deal,fresh,token,"fresh-shape.csv",freshCsv);
  const repeatPreview=await request("POST",`/deal-setup/activations/${repeatAct}/preview-source`,token,
    {source_artifact_id:repeatUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"});
  ok("H23 exact repeat offers the earlier reviewed mapping",repeatPreview.body.identities.every(x=>x.suggested_decision&&x.suggested_decision.action==="reuse"));
  const repeatBefore=await counts(fresh);
  const repeatApply=await request("POST",`/deal-setup/activations/${repeatAct}/read-source`,token,{
    source_artifact_id:repeatUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",
    source_token:repeatPreview.body.source_token,inventory_decisions:repeatPreview.body.identities.map(x=>({key:x.key,...x.suggested_decision}))});
  ok("H24 exact repeat explicitly reuses reviewed decisions",repeatApply.status===201,JSON.stringify(repeatApply.body).slice(0,180));
  const repeatAfter=await counts(fresh);
  ok("H25 repeat preserves inventory while recording a new evidence batch",repeatAfter.units===repeatBefore.units&&repeatAfter.spaces===repeatBefore.spaces&&repeatAfter.batches===repeatBefore.batches+1);
  const cross=(await pool.query(`select count(*)::int n from proposed_records l join proposed_records d on d.id=l.inventory_identity_decision_id
      where l.activation_id=$1 and d.activation_id<>l.activation_id`,[repeatAct])).rows[0].n;
  ok("H26 repeated proposals carry cross-activation durable decision lineage",cross===2,`cross=${cross}`);

  // Source parent text can differ from the retained canonical parent. A
  // person chooses the current parent and approves its complete source room
  // set; no offline prefix rewrite is part of the contract.
  const parentMapped=await makeProperty(deal,token,`${TAG} selected-parent`);
  const parentUnit=(await pool.query(`insert into units(property_id,unit_number) values($1,'1325-101') returning id`,[parentMapped])).rows[0].id;
  const originalPlaceholder=(await pool.query(`select id from spaces where unit_id=$1`,[parentUnit])).rows[0].id;
  const parentAct=await open(deal,parentMapped,token), parentCsv=csv([["101","Room1",900],["101","Room2",925]]);
  const parentUp=await upload(deal,parentMapped,token,"raw-parent.csv",parentCsv);
  const parentPreview=await request("POST",`/deal-setup/activations/${parentAct}/preview-source`,token,
    {source_artifact_id:parentUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"});
  const parentChoice=parentPreview.body.available_units.find(candidate=>candidate.id===parentUnit);
  ok("H27 mismatched raw parent can explicitly choose a current canonical parent",parentPreview.status===200&&parentChoice.parent_choice_fingerprint&&parentPreview.body.identities.every(x=>x.source.unit_number==="101"));
  const parentApply=await request("POST",`/deal-setup/activations/${parentAct}/read-source`,token,{
    source_artifact_id:parentUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",
    source_token:parentPreview.body.source_token,inventory_decisions:parentPreview.body.identities.map(x=>({
      key:x.key,action:"create_children",unit_id:parentUnit,fingerprint:parentChoice.parent_choice_fingerprint}))});
  const parentRows=(await pool.query(`select s.id,s.space_label,isr.raw,d.selected_unit_id from import_source_rows isr
    join proposed_records l on l.import_source_row_id=isr.id and l.target_type='lease'
    join proposed_records d on d.id=l.inventory_identity_decision_id
    join spaces s on s.id=d.selected_space_id where l.activation_id=$1 order by isr.row_index`,[parentAct])).rows;
  ok("H28 selected parent consumes its pristine placeholder and creates the complete child set",parentApply.status===201&&parentRows.length===2&&parentRows[0].id===originalPlaceholder&&parentRows.map(x=>x.space_label).join("|")==="Room1|Room2");
  ok("H29 mismatched source parent remains raw evidence while every decision binds the chosen parent",parentRows.every(x=>x.raw._source_cells.Unit==="101"&&x.selected_unit_id===parentUnit));

  // A later explicit mapping for identical bytes supersedes earlier reuse.
  const corrected=await makeProperty(deal,token,`${TAG} corrected-reuse`);
  const correctedUnit=(await pool.query(`insert into units(property_id,unit_number) values($1,'CANON') returning id`,[corrected])).rows[0].id;
  await materializeRentableSpaces(pool,{unit_id:correctedUnit,labels:["A","B"],kind:"bed"});
  const correctedSpaces=(await pool.query(`select id,space_label from spaces where unit_id=$1`,[correctedUnit])).rows;
  const correctedCsv=csv([["RAW","A",850]]), correctedUp=await upload(deal,corrected,token,"corrected.csv",correctedCsv);
  async function correctedRound(spaceLabel){
    const act=await open(deal,corrected,token);
    const preview=await request("POST",`/deal-setup/activations/${act}/preview-source`,token,
      {source_artifact_id:correctedUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"});
    const available=preview.body.available_units.find(x=>x.id===correctedUnit).spaces.find(x=>x.label===spaceLabel);
    const apply=await request("POST",`/deal-setup/activations/${act}/read-source`,token,{
      source_artifact_id:correctedUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",source_token:preview.body.source_token,
      inventory_decisions:preview.body.identities.map(x=>({key:x.key,action:"select_existing",unit_id:correctedUnit,space_id:available.id,fingerprint:available.fingerprint}))});
    if(apply.status!==201) throw new Error(`corrected ${spaceLabel} apply: ${JSON.stringify(apply)}`);
    const rows=(await request("GET",`/deal-setup/activations/${act}`,token)).body.proposals;
    await request("POST",`/deal-setup/proposals/${rows[0].id}/confirm`,token,{});
    await request("POST",`/deal-setup/activations/${act}/establish`,token,{});
    const decision=(await pool.query(`select id from proposed_records where activation_id=$1 and target_type='inventory_identity'`,[act])).rows[0].id;
    return {act,preview,apply,decision,available};
  }
  const mappedA=await correctedRound("A"), mappedB=await correctedRound("B");
  ok("H30 identical source bytes can receive a later explicit corrected target",mappedA.apply.status===201&&mappedB.apply.status===201&&mappedA.decision!==mappedB.decision);
  const correctedAct=await open(deal,corrected,token);
  const correctedPreview=await request("POST",`/deal-setup/activations/${correctedAct}/preview-source`,token,
    {source_artifact_id:correctedUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"});
  ok("H31 repeat preview offers only the newest reviewed mapping",correctedPreview.body.identities[0].suggested_decision.decision_id===mappedB.decision);
  const oldReuse=await request("POST",`/deal-setup/activations/${correctedAct}/read-source`,token,{
    source_artifact_id:correctedUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",source_token:correctedPreview.body.source_token,
    inventory_decisions:[{key:correctedPreview.body.identities[0].key,action:"reuse",decision_id:mappedA.decision,fingerprint:mappedA.available.fingerprint}]});
  ok("H32 an older mapping cannot be revived after the correction",oldReuse.status===409&&oldReuse.body.reason==="reused_inventory_review_superseded",JSON.stringify(oldReuse.body));

  // Disjoint source activations on one property serialize the basis write and
  // both finish without a shared-lock upgrade deadlock.
  const parallel=await makeProperty(deal,token,`${TAG} parallel`);
  const parallelActs=(await pool.query(`insert into activations(deal_id,property_id,status,opened_by_user_id)
    values($1,$2,'open',$3),($1,$2,'open',$3) returning id`,[deal,parallel,user])).rows;
  const parallelUps=await Promise.all([upload(deal,parallel,token,"parallel-x.csv",csv([["PX","A",700]])),upload(deal,parallel,token,"parallel-y.csv",csv([["PY","A",700]]))]);
  const parallelPreviews=await Promise.all(parallelActs.map((a,i)=>request("POST",`/deal-setup/activations/${a.id}/preview-source`,token,
    {source_artifact_id:parallelUps[i].body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"})));
  const parallelResults=await Promise.all(parallelActs.map((a,i)=>request("POST",`/deal-setup/activations/${a.id}/read-source`,token,{
    source_artifact_id:parallelUps[i].body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",source_token:parallelPreviews[i].body.source_token,
    inventory_decisions:parallelPreviews[i].body.identities.map(x=>({key:x.key,...x.suggested_decision}))})));
  ok("H33 same-property disjoint applies serialize and both complete",parallelResults.every(x=>x.status===201),JSON.stringify(parallelResults.map(x=>x.status)));
  ok("H34 serialized applies retain both disjoint homes at the reviewed bed basis",(await counts(parallel)).units===2&&(await counts(parallel)).spaces===2&&(await counts(parallel)).leasing_basis==="bed");

  // Historical staged claims are never retroactively labelled as reviewed.
  // The explicit restart keeps their artifact, batch and proposal as history.
  const legacy=await makeProperty(deal,token,`${TAG} historical-unbound`), legacyAct=await open(deal,legacy,token);
  const legacyCsv=csv([["LEGACY","A",700]]), legacyUp=await upload(deal,legacy,token,"legacy-unbound.csv",legacyCsv);
  const legacyBatch=(await pool.query(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status,source_artifact_id)
    values($1,'rent_roll_ledger','legacy-unbound.csv','2026-09-13','bed','extracted','committed',$2) returning id`,[legacy,legacyUp.body.artifact.id])).rows[0].id;
  const legacyRow=(await pool.query(`insert into import_source_rows(import_batch_id,row_index,raw) values($1,2,$2) returning id`,[legacyBatch,{_source_cells:{Unit:"LEGACY",Room:"A"}}])).rows[0].id;
  await pool.query(`update activations set import_batch_id=$2,source_artifact_id=$3,source_as_of_date='2026-09-13' where id=$1`,[legacyAct,legacyBatch,legacyUp.body.artifact.id]);
  await pool.query(`insert into proposed_records(activation_id,property_id,target_type,natural_key,status,payload_json,normalized_json,import_source_row_id)
    values($1,$2,'lease','LEGACY|A','staged','{}',$3,$4)`,[legacyAct,legacy,{unit_number:"LEGACY",space_label:"A"},legacyRow]);
  const legacyRead=await request("GET",`/deal-setup/activations/${legacyAct}`,token);
  ok("H35 historical unbound claims are identified and never offered invented review",legacyRead.status===200&&legacyRead.body.source_home_review_required===1&&!legacyRead.body.proposals[0].home_identity_review);
  const restarted=await request("POST",`/deal-setup/activations/${legacyAct}/restart-source-review`,token,{});
  const oldState=(await pool.query(`select status,source_artifact_id,import_batch_id from activations where id=$1`,[legacyAct])).rows[0];
  ok("H36 restart abandons only the old setup and preserves its source and evidence lineage",restarted.status===201&&oldState.status==="abandoned"&&oldState.source_artifact_id===legacyUp.body.artifact.id&&oldState.import_batch_id===legacyBatch);
  const restartedPreview=await request("POST",`/deal-setup/activations/${restarted.body.activation.id}/preview-source`,token,{
    source_artifact_id:restarted.body.retained_source.artifact_id,source_as_of_date:"2026-09-13",leasing_basis:"unit"});
  ok("H37 retained bytes open a fresh explicit review without changing historical proposal",restartedPreview.status===200&&(await pool.query(`select status from proposed_records where activation_id=$1`,[legacyAct])).rows[0].status==="staged");

  // Exact target collision after preview stales only that proposed new home.
  const stale=await makeProperty(deal,token,`${TAG} stale`), staleAct=await open(deal,stale,token);
  const staleCsv=csv([["STALE-01","A",700]]), staleUp=await upload(deal,stale,token,"stale.csv",staleCsv);
  const stalePreview=await request("POST",`/deal-setup/activations/${staleAct}/preview-source`,token,
    {source_artifact_id:staleUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"});
  await pool.query(`insert into units(property_id,unit_number) values($1,'STALE-01')`,[stale]);
  const staleApply=await request("POST",`/deal-setup/activations/${staleAct}/read-source`,token,{
    source_artifact_id:staleUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",
    source_token:stalePreview.body.source_token,inventory_decisions:stalePreview.body.identities.map(x=>({key:x.key,...x.suggested_decision}))});
  ok("H27 meaningful new-target collision drift refuses apply",staleApply.status===409&&["inventory_target_changed","new_inventory_collision"].includes(staleApply.body.reason),JSON.stringify(staleApply.body));
  ok("H28 stale apply leaves leasing basis unchanged and creates no second unit",(await counts(stale)).leasing_basis==="unknown"&&(await counts(stale)).units===1);

  // Authority removed after preview: no basis, batch or inventory write.
  const auth=await makeProperty(deal,token,`${TAG} authority`), authAct=await open(deal,auth,token);
  const authCsv=csv([["AUTH-01","A",700]]), authUp=await upload(deal,auth,token,"authority.csv",authCsv);
  const authPreview=await request("POST",`/deal-setup/activations/${authAct}/preview-source`,token,
    {source_artifact_id:authUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"});
  // Org admins derive scope from their organization, so use a member for the
  // revocation proof while keeping every business call on HTTP.
  const member=(await pool.query(`insert into users(name,email,platform_role,organization_id,is_active,status,person_id)
    values($1,$2,'member',$3,true,'active',$4) returning id`,[`${TAG} member`,`${TAG}.member@example.test`,org,person])).rows[0].id;
  await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active)
    values($1,$2,'review',array['leasing'],true)`,[auth,member]);
  await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active)
    values($1,$2,'session seat',array['management'],true)`,[seat,member]);
  const mtok=crypto.randomBytes(32).toString("base64url");
  await pool.query(`insert into staff_sessions(user_id,property_id,token,token_digest,issuance_purpose,expires_at)
    values($1,$2,null,$3,'bootstrap_invite',now()+interval '4 hours')`,[member,seat,crypto.createHash("sha256").update(mtok).digest("hex")]);
  const memberPreview=await request("POST",`/deal-setup/activations/${authAct}/preview-source`,mtok,
    {source_artifact_id:authUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed"});
  await pool.query(`update property_team_assignments set active=false where property_id=$1 and user_id=$2`,[auth,member]);
  const authApply=await request("POST",`/deal-setup/activations/${authAct}/read-source`,mtok,{
    source_artifact_id:authUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",
    source_token:memberPreview.body.source_token,inventory_decisions:memberPreview.body.identities.map(x=>({key:x.key,...x.suggested_decision}))});
  ok("H29 authority lost after review refuses apply",authApply.status===403&&authApply.body.reason==="property_setup_access_required",JSON.stringify(authApply.body));
  const authState=await counts(auth);
  ok("H30 authority refusal leaves basis, batch and inventory untouched",authState.leasing_basis==="unknown"&&authState.units===0&&authState.batches===0,JSON.stringify(authState));

  // Hard race: apply waits on the exact source-label advisory lock. Revocation
  // commits during that wait, so only a post-wait authority read can refuse.
  await pool.query(`update property_team_assignments set active=true where property_id=$1 and user_id=$2`,[auth,member]);
  const blocker=await pool.connect();
  await blocker.query("begin");
  await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`source-home:${auth}:auth-01`]);
  const waitingApply=request("POST",`/deal-setup/activations/${authAct}/read-source`,mtok,{
    source_artifact_id:authUp.body.artifact.id,source_as_of_date:"2026-09-13",leasing_basis:"bed",
    source_token:memberPreview.body.source_token,inventory_decisions:memberPreview.body.identities.map(x=>({key:x.key,...x.suggested_decision}))});
  await new Promise(resolve=>setTimeout(resolve,150));
  await pool.query(`update property_team_assignments set active=false where property_id=$1 and user_id=$2`,[auth,member]);
  await blocker.query("commit"); blocker.release();
  const waitedApply=await waitingApply;
  ok("H31 apply revalidates authority after a blocking inventory wait",waitedApply.status===403&&waitedApply.body.reason==="property_setup_access_required",JSON.stringify(waitedApply.body));
  ok("H32 raced apply leaves no basis, batch or inventory residue",JSON.stringify(await counts(auth))===JSON.stringify(authState));

  // Confirmation has the same ordering: target lock wait, then authority.
  await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active)
    values($1,$2,'review',array['leasing'],true) on conflict(property_id,user_id) do update set active=true`,[fresh,member]);
  const repeatProposal=(await pool.query(`select pr.id,d.selected_space_id from proposed_records pr
    join proposed_records d on d.id=pr.inventory_identity_decision_id
    where pr.activation_id=$1 and pr.target_type='lease' and pr.status='staged' order by pr.created_at limit 1`,[repeatAct])).rows[0];
  const confirmBlocker=await pool.connect(); await confirmBlocker.query("begin");
  await confirmBlocker.query("select id from spaces where id=$1 for update",[repeatProposal.selected_space_id]);
  const waitingConfirm=request("POST",`/deal-setup/proposals/${repeatProposal.id}/confirm`,mtok,{});
  await new Promise(resolve=>setTimeout(resolve,150));
  await pool.query(`update property_team_assignments set active=false where property_id=$1 and user_id=$2`,[fresh,member]);
  await confirmBlocker.query("commit"); confirmBlocker.release();
  const waitedConfirm=await waitingConfirm;
  ok("H33 confirmation revalidates authority after its target-lock wait",waitedConfirm.status===403&&waitedConfirm.body.reason==="property_setup_access_required",JSON.stringify(waitedConfirm.body));
  ok("H34 raced confirmation leaves the proposal unpromoted",(await pool.query(`select status from proposed_records where id=$1`,[repeatProposal.id])).rows[0].status==="staged");

  // Database shape makes malformed institutional decisions impossible.
  let malformed=null;
  try { await pool.query(`insert into proposed_records(activation_id,property_id,target_type,natural_key,status,
      resolution_kind,promoted_record_id,confirmed_by,confirmed_at)
      values($1,$2,'inventory_identity','malformed','promoted','created',gen_random_uuid(),'proof',now())`,[authAct,auth]); }
  catch(e){malformed=e;}
  ok("H35 malformed identity decision without selected parent is constrained",malformed&&malformed.code==="23514",malformed&&malformed.constraint);
  const target=(await pool.query(`select u.id unit_id,s.id space_id from units u join spaces s on s.unit_id=u.id where u.property_id=$1 limit 1`,[fresh])).rows[0];
  let mismatch=null;
  try { await pool.query(`insert into proposed_records(activation_id,property_id,target_type,natural_key,status,
      resolution_kind,promoted_record_id,confirmed_by,confirmed_at,selected_unit_id,selected_space_id)
      values($1,$2,'inventory_identity','mismatch','promoted','resolved_existing',gen_random_uuid(),'proof',now(),$3,$4)`,
      [repeatAct,fresh,target.unit_id,target.space_id]); } catch(e){mismatch=e;}
  ok("H36 promoted subject must equal selected space",mismatch&&mismatch.code==="23514",mismatch&&mismatch.constraint);
  ok("H37 source artifact bytes remain retained with matching sha256",(await pool.query(`select encode(digest(content,'sha256'),'hex')=sha256 ok from source_artifacts where id=$1`,[freshUp.body.artifact.id])).rows[0].ok===true);
  ok("H38 the proof used the real fenced HTTP server",/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE.origin)&&preview.status===200&&freshApplied.status===201);

  console.log(`\n  ${passed} passed, ${failed} failed`);
  await pool.end();
  process.exitCode = receipt.complete({ harness: __filename, passed, failed, expectedAtLeast: 54 });
})().catch(async error => {
  console.error(error.stack || error); try { await pool.end(); } catch {}
  process.exit(1);
});
