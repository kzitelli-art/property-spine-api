/* ════════════════════════════════════════════════════════════════════
   tracker_intake.js — THE LEASING TRACKER AS EVIDENCE, NOT AS TRUTH

       source evidence  →  claim  →  reconciliation  →  (human) → truth

   Mike's workbook is the operating position he manages today. It is
   strong evidence and it is not a lease. This seam stages one governed
   CLAIM per bed and reconciles each against canonical lease truth. It
   writes no lease, mints no person, and promotes nothing.

   ── THE RULING THIS EXISTS TO OBEY ──────────────────────────────────

   Do NOT force late tracker commitments into `leases` to make Spine say
   144. The tracker carries a resident, a signed/pending status, a
   cohort label and a monthly rent. It does NOT carry authoritative
   start and end dates. "Full Year" is cohort evidence; it is not a
   term, and manufacturing 2026-08-01 → 2027-07-31 from it would be
   inventing the exact contractual fact the claim exists to admit is
   missing.

   So a bed with a tracker commitment and no canonical lease stays a
   CLAIM. The surface says "awaiting contractual tie" and Mike keeps
   operating. That is the whole point: don't wait for perfect source
   synchronisation, and don't fabricate truth.

   ── NOT A SECOND FORWARD DATASTORE ──────────────────────────────────

   This writes to `proposed_records` — the claim-before-truth ledger
   migration 040 already built, on an `activation` that names the source
   file. No new table, no migration, and nothing here is read as a
   position: `forward_leasing_read` derives the canonical count from
   `leases` and overlays these claims as a SEPARATELY LABELLED layer. A
   claim never becomes a committed bed by being stored.

   ── FIVE RECONCILIATION OUTCOMES ────────────────────────────────────

     tied_to_lease        a canonical lease overlaps the cycle and the
                          tracker agrees. The claim ties to it and
                          carries the rent as separate economic evidence.
     awaiting_lease       tracker commitment, no canonical lease. Kept
                          as a claim. NOT promoted — no governed term.
     open_but_leased      tracker says open, Spine has a lease. The 416A
                          shape. Exception → needs_review.
     identity_conflict    the Unit cell and the Room cell name different
                          beds. Neither is chosen. → needs_review.
     agrees_open          tracker open, Spine has no lease. Nothing to
                          claim; recorded so the run is complete.

   ── PERSON RESOLUTION GOES THROUGH PERSON INGRESS ───────────────────

   Never by name. `ingestPerson` is called WITHOUT an authority, so a
   resident is proposed and never minted by a spreadsheet upload.

   READ-MOSTLY: the only writes are the activation and the claims.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const crypto = require("crypto");
const { ingestPerson } = require("../identity/person_ingress");
const { TERMINAL_LEASE_STATUSES, rangesOverlap } = require("../tenancy/position_classifier");

const TARGET_TYPE = "forward_lease_commitment";
const ASSUMPTION_TYPE = "open_bed_asking_assumption";
const SOURCE_KIND = "leasing_tracker";
const SIGNED = /^(signed|executed)$/i;
const PENDING = /^pending$/i;

/*  Bed letters are ORDINAL POSITIONS. Spine's rent-roll import produced
 *  'Room1'/'Room2'; the tracker writes 'A'/'B'. The mapping is
 *  deterministic and reversible, so it is applied — and named in every
 *  claim's payload, because a silent identity translation is how two
 *  systems come to disagree about which bed they mean. */
const LETTER_ORDINAL = { a: "1", b: "2", c: "3", d: "4" };
const ordinal = (v) => {
  const s = String(v == null ? "" : v).trim().toLowerCase()
    .replace(/^(room|rm|bed|bd|space)\s*[-#.]?\s*/, "");
  return LETTER_ORDINAL[s] || s || null;
};
const bedKey = (unit, ord) =>
  `${String(unit).replace(/^\d{3,4}-(?=\d)/, "")}#${ord == null ? "-" : ord}`;

/*  ── PARSE ───────────────────────────────────────────────────────────
 *  Header-aware. Returns one record per bed row plus the rows it could
 *  not read, which are REPORTED and never dropped: a comparison set that
 *  silently shrank would make the reconciliation look cleaner than it is.
 *
 *  ⚠ BOTH IDENTITY COLUMNS ARE READ AND CROSS-CHECKED. On the live
 *  Skyline tab one row's Unit cell is wrong and another's Room cell is
 *  wrong — in opposite directions — so neither column is reliable alone.
 *  A single-column reader reports 144 committed beds and is wrong by one
 *  bed and by $1,100 of pending rent. */
function parseTrackerSheet(rows) {
  const cellOf = (row, j) => (j >= 0 && row && row[j] != null ? String(row[j]).trim() : "");
  let hdr = -1, cUnit = -1, cRoom = -1, cType = -1, cSem = -1, cStatus = -1,
    cNewRenew = -1, cName = -1, cPhone = -1, cEmail = -1, cRent = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const c = (rows[i] || []).map((x) => String(x == null ? "" : x).trim());
    const u = c.findIndex((x) => /^unit\s*#?$/i.test(x));
    if (u < 0) continue;
    hdr = i; cUnit = u;
    const find = (re) => c.findIndex((x) => re.test(x));
    cRoom = find(/^(room|bed|space)\s*#?$/i);
    cType = find(/^unit\s*type$/i);
    cSem = find(/^(semester|term|lease\s*type)$/i);
    cStatus = find(/^(signed\s*\/?\s*pending|signed|status|lease\s*status)$/i);
    cNewRenew = find(/^new\s*\/?\s*renewal$/i);
    cName = find(/^(name|tenant|resident)$/i);
    cPhone = find(/^phone(\s*number)?$/i);
    cEmail = find(/^e-?mail$/i);
    cRent = find(/^monthly\s*rent$/i);
    break;
  }
  if (hdr < 0) {
    const e = new Error("No header row with a 'Unit' column was found in this sheet.");
    e.code = "TRACKER_HEADER_NOT_FOUND";
    throw e;
  }

  const beds = [], unreadable = [];
  for (let i = hdr + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rawUnit = cellOf(row, cUnit);
    const m = rawUnit.match(/^(\d{2,4})\s*([a-d])?/i);
    if (!m) {
      if (row.some((x) => x != null && String(x).trim())) {
        unreadable.push({ row: i + 1, text: row.filter(Boolean).join(" | ").slice(0, 120) });
      }
      continue;
    }
    const fromUnit = m[2] ? LETTER_ORDINAL[m[2].toLowerCase()] : null;
    const fromRoom = cRoom >= 0 && cellOf(row, cRoom) ? ordinal(cellOf(row, cRoom)) : null;
    const identity_conflict = !!(fromUnit && fromRoom && fromUnit !== fromRoom);
    const status = cellOf(row, cStatus);
    const rentRaw = cRent >= 0 ? row[cRent] : null;

    beds.push({
      source_row: i + 1,
      raw_unit: rawUnit,
      unit: m[1],
      ordinal: fromUnit || fromRoom,
      ordinal_from_unit_cell: fromUnit,
      ordinal_from_room_cell: fromRoom,
      identity_conflict,
      bed_key: identity_conflict ? null : bedKey(m[1], fromUnit || fromRoom),
      unit_type: cellOf(row, cType) || null,
      cohort_label: cellOf(row, cSem) || null,
      tracker_status: status || null,
      committed: SIGNED.test(status) || PENDING.test(status),
      signed: SIGNED.test(status),
      pending: PENDING.test(status),
      new_or_renewal: cellOf(row, cNewRenew) || null,
      resident_name: cellOf(row, cName) || null,
      resident_phone: cellOf(row, cPhone) || null,
      resident_email: cellOf(row, cEmail) || null,
      monthly_rent: typeof rentRaw === "number" && isFinite(rentRaw) && rentRaw !== 0 ? rentRaw : null,
    });
  }
  return { beds, unreadable, header_row: hdr + 1 };
}

/*  ── ASKING-RENT ASSUMPTIONS, FROM THE STATS TAB ─────────────────────
 *  Mike's summary sheet is label-keyed: a unit-type row carrying Total
 *  Beds, Signed & Pending, Remaining and Asking. Only two cells matter
 *  here — the subject (unit type) and the asking amount — and neither
 *  becomes a rent fact.
 *
 *  The `Total` row is EXCLUDED deliberately: its "asking" cell is a
 *  weighted average of the type rows ($834.06 at Skyline), which is a
 *  derived figure and not an assumption anybody stated about any bed. */
function parseAskingAssumptions(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const cell = (r, j) => (j >= 0 && r && r[j] != null ? String(r[j]).trim() : "");
  let hdr = -1, cType = -1, cAsk = -1, cRemaining = -1, cBeds = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const c = (rows[i] || []).map((x) => String(x == null ? "" : x).trim());
    const t = c.findIndex((x) => /^unit\s*type$/i.test(x));
    if (t < 0) continue;
    hdr = i; cType = t;
    cAsk = c.findIndex((x) => /^asking\*?$/i.test(x));
    cRemaining = c.findIndex((x) => /^remaining$/i.test(x));
    cBeds = c.findIndex((x) => /^total\s*beds$/i.test(x));
    break;
  }
  if (hdr < 0 || cAsk < 0) return [];
  const out = [];
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const subject = cell(r, cType);
    if (!subject) continue;
    if (/^total$/i.test(subject)) continue;          // a weighted mean, not an assumption
    const amount = r[cAsk];
    if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) continue;
    const beds = cBeds >= 0 && typeof r[cBeds] === "number" ? r[cBeds] : null;
    if (beds === 0) continue;                        // a type with no inventory states nothing
    out.push({
      subject, amount: Number(amount),
      stated_remaining: cRemaining >= 0 && typeof r[cRemaining] === "number" ? r[cRemaining] : null,
      source_sheet: "stats", source_row: i + 1,
      basis: "asking rent stated by the operating tracker for beds still open",
    });
  }
  return out;
}

/*  ── STAGE ───────────────────────────────────────────────────────────
 *  One claim per tracker bed row, reconciled against canonical truth. */
async function stageTrackerClaims(client, {
  property_id, cycle_start, cycle_end, cycle_label = null,
  source_label, source_sha256 = null, rows, stats_rows = null,
  accepted_by_user_id = null,
} = {}) {
  if (!property_id) throw new Error("stageTrackerClaims requires property_id");
  if (!cycle_start || !cycle_end) {
    const e = new Error("stageTrackerClaims requires cycle_start and cycle_end");
    e.code = "CYCLE_REQUIRED"; throw e;
  }
  if (!source_label) {
    const e = new Error("stageTrackerClaims requires source_label — a claim with no named source is not evidence");
    e.code = "SOURCE_REQUIRED"; throw e;
  }

  const { beds, unreadable, header_row } = parseTrackerSheet(rows);

  /*  ── THE SOURCE ARTIFACT, AND WHY THIS VERSION IS THE OPERATING ONE
   *
   *  v2 does not rewrite v1. It is a NEW activation that SUPERSEDES the
   *  current one in the same statement that accepts it, so the history
   *  stays intact and there is never a moment with two current sources
   *  or none. The answer to "why this version?" is a sentence a person
   *  can read — "it is the accepted source; it superseded the 08-14
   *  upload" — and not `max(created_at)`, which is an authority rule
   *  nobody ever stated. See migration 177.  */
  const prior = (await client.query(
    `select id, source_label, accepted_at from activations
      where property_id=$1 and source_kind=$2 and status='activated'
        and superseded_by_id is null
      for update`, [property_id, SOURCE_KIND])).rows[0] || null;

  /*  ⚠ ORDER MATTERS, AND THE CONSTRAINT PROVED IT. Inserting the new
   *  row as `activated` first left TWO rows activated-and-unsuperseded for
   *  the length of one statement, and uq_activation_current_source
   *  (migration 177) refused the write — correctly. The window was real:
   *  a concurrent read in between would have seen two current sources.
   *
   *  So the new row is born `open`, the prior one is pointed at it, and
   *  only then is it accepted. At no instant are there two current
   *  sources, and at no instant are there none. */
  const activation = (await client.query(
    `insert into activations
       (property_id, source_label, status, source_kind, supersedes_activation_id)
     values ($1,$2,'open',$3,$4) returning id`,
    [property_id, source_label, SOURCE_KIND, prior ? prior.id : null])).rows[0];

  if (prior) {
    await client.query(
      `update activations
          set superseded_by_id=$1, superseded_at=now(), updated_at=now()
        where id=$2`, [activation.id, prior.id]);
  }
  await client.query(
    `update activations
        set status='activated', accepted_by_user_id=$2, accepted_at=now(), updated_at=now()
      where id=$1`, [activation.id, accepted_by_user_id]);

  //  ── canonical inventory and the leases overlapping the cycle ──
  const inv = (await client.query(
    `select s.id as space_id, u.id as unit_id, u.unit_number, s.space_label
       from spaces s join units u on u.id = s.unit_id where u.property_id = $1`, [property_id])).rows;
  const spaceByKey = new Map(inv.map((r) =>
    [bedKey(r.unit_number, ordinal(r.space_label)), r]));

  const leaseRows = (await client.query(
    `select l.id, l.space_id, l.lease_status, l.rent,
            to_char(l.start_date,'YYYY-MM-DD') as start_date,
            to_char(l.end_date,'YYYY-MM-DD')   as end_date
       from leases l join spaces s on s.id = l.space_id join units u on u.id = s.unit_id
      where u.property_id = $1`, [property_id])).rows
    .filter((l) => !TERMINAL_LEASE_STATUSES.has(String(l.lease_status || "").toLowerCase()));
  const cycleLeasesBySpace = new Map();
  for (const l of leaseRows) {
    if (!rangesOverlap({ start_date: cycle_start, end_date: cycle_end }, l)) continue;
    const k = String(l.space_id);
    if (!cycleLeasesBySpace.has(k)) cycleLeasesBySpace.set(k, []);
    cycleLeasesBySpace.get(k).push(l);
  }

  const outcomes = {
    tied_to_lease: 0, awaiting_lease: 0, open_but_leased: 0,
    identity_conflict: 0, agrees_open: 0, bed_not_in_inventory: 0,
  };
  const claims = [];

  for (const b of beds) {
    const evidence_refs = [{
      source: source_label, sha256: source_sha256, row: b.source_row,
      header_row, raw_unit: b.raw_unit,
    }];

    //  ── 1. identity first. Never pick a column. ──
    if (b.identity_conflict) {
      outcomes.identity_conflict++;
      claims.push(await writeClaim(client, {
        activation_id: activation.id, property_id, natural_key: `row:${b.source_row}`,
        status: "needs_review",
        status_reason: `The Unit cell names bed ${b.ordinal_from_unit_cell} and the Room cell ` +
          `names bed ${b.ordinal_from_room_cell}. Spine will not choose between them — ` +
          `correct the source row and re-stage.`,
        payload: { ...b, reconciliation: "identity_conflict", cycle_label }, evidence_refs,
      }));
      continue;
    }

    const inventory = spaceByKey.get(b.bed_key);
    if (!inventory) {
      outcomes.bed_not_in_inventory++;
      claims.push(await writeClaim(client, {
        activation_id: activation.id, property_id, natural_key: `bed:${b.bed_key}`,
        status: "blocked",
        status_reason: `The tracker names bed ${b.raw_unit}, which is not in Spine's inventory ` +
          `for this property.`,
        payload: { ...b, reconciliation: "bed_not_in_inventory", cycle_label }, evidence_refs,
      }));
      continue;
    }

    const governing = cycleLeasesBySpace.get(String(inventory.space_id)) || [];

    //  ── 2. tracker says OPEN ──
    if (!b.committed) {
      if (governing.length) {
        outcomes.open_but_leased++;
        claims.push(await writeClaim(client, {
          activation_id: activation.id, property_id, natural_key: `bed:${b.bed_key}`,
          status: "needs_review",
          status_reason: `The tracker shows this bed open, but Spine holds a ` +
            `${governing[0].lease_status} lease ${governing[0].start_date} → ${governing[0].end_date}. ` +
            `One of them is stale — a human decides which.`,
          payload: { ...b, reconciliation: "open_but_leased", space_id: inventory.space_id,
            canonical_lease_ids: governing.map((l) => l.id), cycle_label }, evidence_refs,
        }));
      } else {
        /*  ⚠ AN OPEN BED IS ALSO A STATEMENT, and it was the one shape not
         *  being recorded. Skipping it meant 15 of Mike's 16 open beds had
         *  no claim, so nothing downstream knew their unit type — and the
         *  open-bed asking assumption silently priced ONE bed and reported
         *  $799 instead of $13,345. A plausible total, wrong by 94%.
         *
         *  The tracker is saying: this bed is open, it is a 2 BR, and the
         *  asking rent for that type applies to it. That is evidence, and
         *  it belongs in the claim layer with everything else. */
        outcomes.agrees_open++;
        claims.push(await writeClaim(client, {
          activation_id: activation.id, property_id, natural_key: `bed:${b.bed_key}`,
          status: "staged",
          status_reason: "The tracker shows this bed open and Spine holds no lease for it. " +
            "Recorded so the open set carries its unit type and the asking-rent assumption " +
            "can be applied to a named bed rather than a count.",
          payload: { ...b, reconciliation: "agrees_open", space_id: inventory.space_id,
            cycle_label }, evidence_refs,
        }));
      }
      continue;
    }

    //  ── 3. tracker says COMMITTED. Resolve the resident through the
    //        person seam — never by name, never minted here. ──
    let person = null;
    if (b.resident_name || b.resident_phone || b.resident_email) {
      person = await ingestPerson(client, {
        property_id, channel: "leasing_intake", activation_id: activation.id,
        authority: null,                      // a spreadsheet is not a confirmation
        evidence: {
          full_name: b.resident_name || null,
          legacy_phone: b.resident_phone || null,
          email: b.resident_email || null,
        },
      });
    }

    const personSummary = person ? {
      disposition: person.disposition, person_id: person.person_id || null,
      proposal_id: person.proposal_id || null,
    } : { disposition: "no_person_evidence", person_id: null, proposal_id: null };

    if (governing.length) {
      outcomes.tied_to_lease++;
      const lease = governing[0];
      const rentDiffers = lease.rent != null && Number(lease.rent) !== 0 && b.monthly_rent != null &&
        Number(lease.rent) !== Number(b.monthly_rent);
      claims.push(await writeClaim(client, {
        activation_id: activation.id, property_id, natural_key: `bed:${b.bed_key}`,
        status: rentDiffers ? "needs_review" : "staged",
        status_reason: rentDiffers
          ? `The tracker states $${b.monthly_rent}/mo; the canonical lease states $${lease.rent}/mo. ` +
            `Spine does not overwrite a governed rent from a spreadsheet.`
          : (lease.rent == null || Number(lease.rent) === 0
            ? "Tied to a canonical lease that carries no rent. The tracker's rent is ECONOMIC " +
              "EVIDENCE for that lease and requires its own confirmation."
            : null),
        payload: { ...b, reconciliation: "tied_to_lease", space_id: inventory.space_id,
          canonical_lease_ids: governing.map((l) => l.id),
          canonical_rent: lease.rent == null ? null : Number(lease.rent),
          contended: governing.length > 1, person: personSummary, cycle_label }, evidence_refs,
      }));
      continue;
    }

    //  ── 4. committed, and Spine has no lease. THE CLAIM STOPS HERE. ──
    outcomes.awaiting_lease++;
    claims.push(await writeClaim(client, {
      activation_id: activation.id, property_id, natural_key: `bed:${b.bed_key}`,
      status: "staged",
      status_reason:
        "A tracker commitment with no canonical lease. NOT PROMOTABLE: the tracker carries no " +
        "start or end date, and the cohort label is evidence about the term, not the term. " +
        "Establishing this bed needs the executed lease, not this row.",
      payload: { ...b, reconciliation: "awaiting_lease", space_id: inventory.space_id,
        person: personSummary, cycle_label,
        missing_for_promotion: ["start_date", "end_date"] }, evidence_refs,
    }));
  }

  /*  ── THE PROJECTION'S OTHER INPUT, AND IT IS NOT A RENT ────────────
   *  Mike's Stats tab states an asking rent per unit type for the beds
   *  still open. That is a PRICING ASSUMPTION carried by the same source
   *  artifact — it is not contractual rent, not market rent, and not
   *  achieved rent, and calling it any of those would establish a fact
   *  no evidence supports. It is stored as its own claim type so nothing
   *  reading commitments can pick it up by accident.  */
  const assumptions = [];
  for (const a of parseAskingAssumptions(stats_rows)) {
    assumptions.push(await writeClaim(client, {
      activation_id: activation.id, property_id,
      natural_key: `asking:${a.subject}`, target_type: ASSUMPTION_TYPE,
      status: "staged",
      status_reason: "An asking-rent ASSUMPTION stated by the operating tracker for beds " +
        "still open. Not contractual rent, not market rent, not achieved rent.",
      payload: { ...a, cycle_label, claim_class: "assumption" },
      evidence_refs: [{ source: source_label, sha256: source_sha256,
        sheet: a.source_sheet || null, row: a.source_row || null }],
    }));
  }

  return {
    activation_id: activation.id,
    superseded_activation_id: prior ? prior.id : null,
    source_kind: SOURCE_KIND,
    assumptions_written: assumptions.length,
    source: { label: source_label, sha256: source_sha256, header_row },
    cycle: { label: cycle_label, start: cycle_start, end: cycle_end },
    parsed: { bed_rows: beds.length, unreadable_rows: unreadable.length, unreadable },
    tracker_position: {
      signed: beds.filter((b) => b.signed).length,
      pending: beds.filter((b) => b.pending).length,
      committed: beds.filter((b) => b.committed).length,
      open: beds.filter((b) => !b.committed).length,
      signed_rent: beds.filter((b) => b.signed).reduce((a, b2) => a + (b2.monthly_rent || 0), 0),
      pending_rent: beds.filter((b) => b.pending).reduce((a, b2) => a + (b2.monthly_rent || 0), 0),
    },
    outcomes,
    claims_written: claims.length,
    promoted: 0,
    note: "Nothing was promoted. No lease was written and no person was minted. " +
          "Every row above is a claim awaiting governed confirmation.",
  };
}

async function writeClaim(client, {
  activation_id, property_id, natural_key, status, status_reason, payload, evidence_refs,
  target_type = TARGET_TYPE,
}) {
  const row = (await client.query(
    `insert into proposed_records
       (activation_id, property_id, module, target_type, natural_key,
        payload_json, evidence_refs, status, status_reason)
     values ($1,$2,'leasing',$3,$4,$5::jsonb,$6::jsonb,$7,$8)
     returning id, status`,
    [activation_id, property_id, target_type, natural_key,
      JSON.stringify(payload), JSON.stringify(evidence_refs), status, status_reason || null])).rows[0];
  return row;
}

/*  Read the staged claims for a cycle so the ledger can overlay them.
 *  READ-ONLY, and deliberately returns the claim layer LABELLED — a
 *  caller cannot mistake it for a canonical position. */
async function readTrackerClaims(client, { property_id, cycle_label = null, activation_id = null } = {}) {
  /*  ⚠ THE CURRENT SOURCE, NOT THE NEWEST ROWS. Ordering every claim by
   *  created_at and taking the first per bed would make max(created_at)
   *  the authority — and would happily read half of v1 and half of v2 if
   *  v2 omitted a bed. Scoped to the accepted, unsuperseded activation,
   *  the operating read describes ONE source artifact. */
  if (!activation_id) {
    const cur = await currentTrackerSource(client, { property_id });
    if (!cur) return [];
    activation_id = cur.id;
  }
  const rows = (await client.query(
    `select id, natural_key, status, status_reason, payload_json, evidence_refs, created_at
       from proposed_records
      where property_id = $1 and target_type = $2
        and ($3::uuid is null or activation_id = $3::uuid)
      order by created_at desc, natural_key`,
    [property_id, TARGET_TYPE, activation_id])).rows;
  const seen = new Set(), latest = [];
  for (const r of rows) {                      // newest staging wins per bed
    if (seen.has(r.natural_key)) continue;
    if (cycle_label && r.payload_json && r.payload_json.cycle_label &&
        r.payload_json.cycle_label !== cycle_label) continue;
    seen.add(r.natural_key); latest.push(r);
  }
  return latest;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/*  The CURRENT source, by supersession — never max(created_at). */
async function currentTrackerSource(client, { property_id } = {}) {
  const { rows } = await client.query(
    `select id, source_label, accepted_at, supersedes_activation_id
       from activations
      where property_id=$1 and source_kind=$2 and status='activated'
        and superseded_by_id is null`, [property_id, SOURCE_KIND]);
  return rows[0] || null;
}

/*  Asking assumptions from the CURRENT source only. A superseded upload's
 *  pricing must not keep feeding a projection. */
async function readAskingAssumptions(client, { property_id, cycle_label = null } = {}) {
  const cur = await currentTrackerSource(client, { property_id });
  if (!cur) return { source: null, assumptions: [] };
  const { rows } = await client.query(
    `select id, natural_key, payload_json, evidence_refs, status
       from proposed_records
      where property_id=$1 and target_type=$2 and activation_id=$3
      order by natural_key`, [property_id, ASSUMPTION_TYPE, cur.id]);
  return {
    source: { activation_id: cur.id, label: cur.source_label, accepted_at: cur.accepted_at },
    assumptions: rows
      .filter((r) => !cycle_label || !r.payload_json || !r.payload_json.cycle_label ||
        r.payload_json.cycle_label === cycle_label)
      .map((r) => ({ ...r.payload_json, claim_id: r.id, status: r.status })),
  };
}

module.exports = {
  stageTrackerClaims, readTrackerClaims, readAskingAssumptions, currentTrackerSource,
  parseTrackerSheet, parseAskingAssumptions, sha256,
  TARGET_TYPE, ASSUMPTION_TYPE, SOURCE_KIND, _internal: { bedKey, ordinal },
};
