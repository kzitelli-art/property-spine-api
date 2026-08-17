/* ════════════════════════════════════════════════════════════════════
   rent_roll_occupancy_correction.db.js — OPEN IS A CLASSIFICATION,
   NEVER A REMAINDER.

   ── WHAT WAS WRONG ──────────────────────────────────────────────────
   The Rent Roll defined Occupied as an active/commercial lease and then
   computed `open = positions.length - occupied` (rent_roll_unit_view
   :178 and :200). Everything that was not Occupied became Open:
   committed-and-awaiting-activation beds, contested beds, and beds whose
   opening evidence contradicted the lease record.

   It could not do better, because the occupancy axis was empty. The
   dated read took its claim from `units.occupancy_status` — a UNIT-level
   column that reads 'unknown' for all 72 Skyline units — while the
   per-bed answer the established opening position actually accepted was
   never readable from the loader at all.

   Skyline showed 32 Occupied / 128 Open. The truth is four numbers.

   ── WHAT IS PROVEN HERE ─────────────────────────────────────────────
       160 beds = 31 Occupied + 22 Activation Pending + 100 Open
                  + 7 Needs Review

   and, because a total that adds up is not evidence that anything was
   measured:

     · the per-space claim RESOLVED for all 160 beds. Without this, a
       fixture can produce plausible totals from an empty claim and the
       whole harness is theatre.
     · Open never absorbs an unclassified position — provoked with a
       state that belongs to no bucket.
     · the INTERVAL read refuses the same beds the as-of read refuses.
       Adding `unreconciled` to evidence without adding it to that gate
       would offer six contested beds as contractually free — a NEW way
       to double-let a bed, created by the fix meant to stop one.
     · 109A renders Needs Review while `tenancy_state` still says
       `contractually_occupied` and `evidence_state` says `disagrees`.
       Both facts survive; only the BUCKET collapses them.
     · the vacant confirm path refuses a vacancy contradicted by a lease
       in force, and still promotes one that is not.

   CLASS 3 — proof infrastructure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const activation = require("../src/onboarding/activation_service.js");
const { datedPropertyPositions, intervalPropertyPositions, rentRollBuckets } =
  require("../src/tenancy/dated_positions.js");
const { unitRentRoll } = require("../src/surfaces/rent_roll_unit_view.js");

const HARNESS = "rent_roll_occupancy_correction.db.js";
const EXPECTED = 71;
const AS_OF = "2026-08-17";
const TERM  = { from: "2026-08-01", to: "2027-07-31" };
const APRIL = { from: "2026-04-01", to: "2027-03-31" };   // the 109A lease

let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log("  ok    " + label); passed++; }
  else { console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); failed++; }
};
const note = (l) => console.log("        " + l);

(async () => {
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });

  try {
    // ══ 1. A SKYLINE-SHAPED PROPERTY ════════════════════════════════
    const org = (await pool.query(
      `insert into organizations (name) values ('Occupancy Proof Co') returning id`)).rows[0].id;
    const user = (await pool.query(
      `insert into users (name, email, is_active, status, platform_role, organization_id)
       values ('Occupancy Proof Operator',$1,true,'active','super_admin',$2) returning id`,
      [`occ-${Date.now()}@example.invalid`, org])).rows[0].id;
    const prop = (await pool.query(
      `insert into properties (name, address, organization_id, leasing_basis)
       values ('Occupancy Proof Property','1 Proof Way',$1,'bed') returning id`, [org])).rows[0].id;
    const deal = (await pool.query(
      `insert into deal_intakes (onboarding_type,status,deal_name,organization_id)
       values ('existing_asset','classified','Occupancy Proof Deal',$1) returning id`, [org])).rows[0].id;
    await pool.query(
      `insert into deal_intake_properties (intake_id,property_id,status) values ($1,$2,'current')`,
      [deal, prop]);

    //  72 units / 160 beds — 44 three-bed, 28 single. Same shape as Skyline.
    const beds = [];   //  { unit, label, space_id }
    for (let i = 1; i <= 72; i++) {
      const unitNumber = `1417-${String(i).padStart(3, "0")}`;
      const u = (await pool.query(
        `insert into units (property_id, unit_number) values ($1,$2) returning id`,
        [prop, unitNumber])).rows[0].id;
      await pool.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [u]);
      const n = i <= 44 ? 3 : 1;
      for (let r = 1; r <= n; r++) {
        const s = (await pool.query(
          `insert into spaces (unit_id, space_label) values ($1,$2) returning id`,
          [u, `Room${r}`])).rows[0].id;
        beds.push({ unit: unitNumber, label: `Room${r}`, space_id: s });
      }
    }
    ok("72 units / 160 beds / no whole-unit phantoms", beds.length === 160, String(beds.length));

    const batchId = (await pool.query(
      `insert into import_batches (property_id, source_type, source_file, source_as_of_date,
                                   leasing_model, confidence, status)
       values ($1,'rent_roll_ledger','RentRoll07.xlsx','2026-07-31','bed','extracted','committed')
       returning id`, [prop])).rows[0].id;
    const act = (await pool.query(
      `insert into activations (deal_id, property_id, status, source_as_of_date,
                                import_batch_id, opened_by_user_id)
       values ($1,$2,'activated','2026-07-31',$3,$4) returning id`,
      [deal, prop, batchId, user])).rows[0].id;

    const putLease = (space_id, status, from, to, tenants = "{}") => pool.query(
      `insert into leases (property_id, space_id, rent, lease_status, start_date, end_date, tenant_ids)
       values ($1,$2,900,$3,$4,$5,$6) returning id`,
      [prop, space_id, status, from, to, tenants]).then((r) => r.rows[0].id);

    const propose = (bed, status, normalized) => pool.query(
      `insert into proposed_records
         (activation_id, property_id, module, target_type, natural_key, normalized_json, status)
       values ($1,$2,'leasing','lease',$3,$4,$5) returning id`,
      [act, prop, `${bed.unit}|${bed.label}`,
       JSON.stringify({ unit_number: bed.unit, space_label: bed.label, ...normalized }),
       status]).then((r) => r.rows[0].id);

    /*  THE SHAPE, bed by bed. Every count below is deliberate and the
     *  four buckets are its arithmetic, not a coincidence:
     *     31 occupied      promoted-with-tenant + an active lease
     *     22 pending       promoted-vacant + a PENDING lease spanning today
     *      1 109A          promoted-vacant + an ACTIVE lease  → contradiction
     *    100 open          promoted-vacant, nothing on the bed
     *      6 unreconciled  proposal left needs_review
     *                                                   ── 160 */
    let i = 0;
    const take = (n) => beds.slice(i, (i += n));
    const occupiedBeds = take(31);
    const pendingBeds  = take(22);
    const bed109A      = take(1)[0];
    const openBeds     = take(100);
    const heldBeds     = take(6);
    ok("the fixture consumes exactly 160 beds", i === 160, String(i));

    for (const b of occupiedBeds) {
      await putLease(b.space_id, "active", TERM.from, TERM.to);
      await propose(b, "promoted", { tenant_name: `Resident ${b.unit}`, rent: 1200,
        start_date: TERM.from, end_date: TERM.to });
    }
    for (const b of pendingBeds) {
      await putLease(b.space_id, "pending", TERM.from, TERM.to);
      await propose(b, "promoted", { is_vacant: true, market_rent: 1200 });
    }
    //  109A — the real one. July says empty; an older April lease says a
    //  named resident is active. Both are on record.
    const lease109A = await putLease(bed109A.space_id, "active", APRIL.from, APRIL.to);
    await propose(bed109A, "promoted", { is_vacant: true, market_rent: 825 });
    for (const b of openBeds) await propose(b, "promoted", { is_vacant: true, market_rent: 1200 });
    //  FIVE of the six carry the competing lease that made them
    //  unreconciled. The SIXTH deliberately carries no lease at all.
    //
    //  Without that one bed this harness cannot see its own subject: a bed
    //  with a lease is already term_blocked in the interval read, so
    //  "not offered as free" would pass for a reason that has nothing to
    //  do with the unreconciled gate. The first version of this fixture
    //  gave all six a lease and proved nothing about the change it exists
    //  to prove.
    const heldWithLease = heldBeds.slice(0, 5);
    const heldNoLease = heldBeds[5];
    for (const b of heldWithLease) {
      await putLease(b.space_id, "pending", TERM.from, TERM.to);
      await propose(b, "needs_review", { tenant_name: `Competing ${b.unit}`, rent: 1200,
        start_date: TERM.from, end_date: TERM.to });
    }
    await propose(heldNoLease, "needs_review", { tenant_name: `Competing ${heldNoLease.unit}`,
      rent: 1200, start_date: TERM.from, end_date: TERM.to });

    await pool.query(
      `insert into opening_tenancy_positions
         (property_id, deal_intake_id, activation_id, as_of_date,
          positions_established, positions_unresolved, source_rows_read,
          established_by_user_id, authority_basis, status)
       values ($1,$2,$3,'2026-07-31',154,6,160,$4,'platform_role:super_admin','established')`,
      [prop, deal, act, user]);

    // ══ 2. THE CLAIM MUST ACTUALLY RESOLVE ══════════════════════════
    //  THE LOAD-BEARING ASSERTION. Everything below can produce
    //  believable totals from an empty claim; this is what says the
    //  opening position was genuinely read per bed.
    console.log("\n  ── the per-space claim reaches the dated read ──");
    const dp = await datedPropertyPositions(pool, { property_id: prop, as_of: AS_OF });
    ok("the dated read returns 160 positions", dp.positions.length === 160,
      String(dp.positions.length));
    const resolved = dp.positions.filter(
      (p) => p.occupancy_claim_basis === "opening_position_space_claim");
    ok("★ all 160 beds resolved a per-space opening claim", resolved.length === 160,
      `${resolved.length}/160 — the rest fell back to the unit-level placeholder`);
    ok("…and none fell back to unit_occupancy_status",
      dp.positions.every((p) => p.occupancy_claim_basis !== "unit_occupancy_status"));
    const claims = dp.positions.reduce((a, p) => {
      a[p.occupancy_claim || "null"] = (a[p.occupancy_claim || "null"] || 0) + 1; return a; }, {});
    note(`claims: ${JSON.stringify(claims)}`);
    ok("123 beds carry an accepted VACANT claim", claims.vacant === 123, String(claims.vacant));
    ok("31 carry an accepted OCCUPIED claim", claims.occupied === 31, String(claims.occupied));
    ok("6 carry UNRECONCILED", claims.unreconciled === 6, String(claims.unreconciled));

    // ══ 3. THE FOUR NUMBERS ═════════════════════════════════════════
    console.log("\n  ── the four buckets ──");
    const b = rentRollBuckets(dp.positions);
    note(JSON.stringify(b));
    ok("★ Occupied = 31", b.occupied === 31, String(b.occupied));
    ok("★ Activation Pending = 22", b.activation_pending === 22, String(b.activation_pending));
    ok("★ Open = 100", b.open === 100, String(b.open));
    ok("★ Needs Review = 7", b.needs_review === 7, String(b.needs_review));
    ok("the four account for every bed", b.occupied + b.activation_pending + b.open
      + b.needs_review === 160);
    ok("nothing is unclassified", b.unclassified === 0, String(b.unclassified));

    //  The old arithmetic, kept as a witness: it is the number we refuse.
    const oldOpen = 160 - dp.positions.filter(
      (p) => p.tenancy_state === "contractually_occupied").length;
    ok("the subtraction would still say something else", oldOpen !== b.open,
      `subtraction=${oldOpen} classification=${b.open}`);
    note(`the old headline would read ${160 - oldOpen} occupied / ${oldOpen} open`);

    // ══ 4. OPEN MAY NOT ABSORB THE UNKNOWN ══════════════════════════
    console.log("\n  ── Open is a classification, not a remainder ──");
    //  Two doors into the tally, so both are provoked.
    //  (a) a position whose bucket was never decided — the classifier hits
    //      a tenancy_state from the future.
    const undecided = dp.positions.slice(0, 3).map((p) => {
      const q = { ...p, tenancy_state: "a_state_from_the_future",
        evidence_state: "confirmed", basis_state: "established" };
      delete q.bucket;
      return q;
    });
    const ub = rentRollBuckets(undecided);
    ok("an undecidable state lands in unclassified, NOT Open",
      ub.unclassified === 3 && ub.open === 0, JSON.stringify(ub));
    //  (b) a DECIDED bucket carrying a value the tally does not know.
    //      Without the guard this did `t[b]++` on an undefined key —
    //      minting a key nobody reads, or NaN in a headline.
    const alien = dp.positions.slice(0, 2).map((p) => ({ ...p, bucket: "vibes" }));
    const ab = rentRollBuckets(alien);
    ok("an unknown DECIDED bucket lands in unclassified, never NaN",
      ab.unclassified === 2 && ab.open === 0
      && Object.values(ab).every((n) => Number.isFinite(n)), JSON.stringify(ab));

    // ══ 5. 109A — TWO FACTS, ONE BUCKET ═════════════════════════════
    console.log("\n  ── 109A keeps both of its contradicting facts ──");
    const p109 = dp.positions.find((p) => String(p.space_id) === String(bed109A.space_id));
    ok("tenancy_state still says contractually_occupied",
      p109.tenancy_state === "contractually_occupied", p109.tenancy_state);
    ok("evidence_state says disagrees", p109.evidence_state === "disagrees", p109.evidence_state);
    ok("its accepted claim is vacant", p109.occupancy_claim === "vacant", p109.occupancy_claim);
    ok("…and it BUCKETS as Needs Review",
      rentRollBuckets([p109]).needs_review === 1);
    ok("the lease it contradicts is still readable on the position",
      p109.lease && String(p109.lease.lease_id) === String(lease109A));

    // ══ 6. THE SURFACE ══════════════════════════════════════════════
    console.log("\n  ── the operator Rent Roll surface ──");
    const rr = await unitRentRoll(pool, { property_id: prop, as_of: AS_OF });
    ok("surface totals match the shared tally",
      rr.totals.occupied === 31 && rr.totals.activation_pending === 22
      && rr.totals.open === 100 && rr.totals.needs_review === 7,
      JSON.stringify(rr.totals));
    ok("rentable_positions is still 160", rr.totals.rentable_positions === 160);
    ok("units still read 72", rr.totals.units === 72, String(rr.totals.units));
    //  ── ONE CLASSIFICATION, NOT TWO ──────────────────────────────────
    //  The app re-derived Occupied/Unresolved/Contested in the browser
    //  (PS_RR_FILTERS). Every row now carries the server's answer, and the
    //  header is the tally of exactly those answers — so the two cannot
    //  disagree even if a surface wanted them to.
    const rows = rr.units.flatMap((u) => u.positions);
    const rowTally = rows.reduce((a, r) => { a[r.bucket] = (a[r.bucket] || 0) + 1; return a; }, {});
    ok("★ every row carries the server's bucket",
      rows.length === 160 && rows.every((r) => !!r.bucket && !!r.bucket_label));
    ok("★ the row buckets tally to the header exactly",
      rowTally.occupied === 31 && rowTally.activation_pending === 22
      && rowTally.open === 100 && rowTally.needs_review === 7,
      JSON.stringify(rowTally));
    ok("…and the glass labels carry no internal vocabulary",
      rows.every((r) => ["Occupied", "Pending Activation", "Open", "Needs Review"]
        .includes(r.bucket_label)),
      [...new Set(rows.map((r) => r.bucket_label))].join(" | "));
    const p109row = rows.find((r) => String(r.space_id) === String(bed109A.space_id));
    ok("109A renders as Needs Review on the glass",
      p109row.bucket_label === "Needs Review", p109row.bucket_label);

    //  ── EVERY REASON IS POSITIVE AND CAUSAL ──────────────────────────
    //  "None of the other buckets matched" IS the defect. An Open bed must
    //  name the established vacancy, the absence of a governing tenancy
    //  fact, and the absence of a contradiction — the three things that
    //  together make a bed genuinely offerable.
    //  ── THE CODE IS THE CONTRACT, THE SENTENCE IS FOR A PERSON ───────
    //  These assert the CODE, not the prose. A test that regexes English
    //  makes the copy an API and turns rewording into a breaking change.
    ok("every row carries a reason code and a sentence",
      rows.every((r) => !!r.bucket_reason_code && !!r.bucket_reason));
    ok("★ 109A's code names the exact contradiction",
      p109row.bucket_reason_code === "OPENING_VACANCY_CONFLICTS_WITH_OPERATIVE_LEASE",
      p109row.bucket_reason_code);
    ok("★ …and its conflicting_refs name the lease, structurally",
      (p109row.conflicting_refs || []).some((x) => x.kind === "lease"
        && String(x.id) === String(lease109A)),
      JSON.stringify(p109row.conflicting_refs));
    ok("★ …while supporting_refs name the opening position and proposal",
      (p109row.supporting_refs || []).some((x) => x.kind === "opening_position")
      && (p109row.supporting_refs || []).some((x) => x.kind === "proposal"),
      JSON.stringify(p109row.supporting_refs));
    const codes = [...new Set(rows.map((r) => r.bucket_reason_code))].sort();
    note(`reason codes in play: ${codes.join(", ")}`);
    ok("Open beds carry the positive-support code",
      rows.filter((r) => r.bucket === "open")
        .every((r) => r.bucket_reason_code === "ESTABLISHED_VACANT_NO_LATER_BLOCKER"));
    ok("Pending Activation beds name the unmet activation condition",
      rows.filter((r) => r.bucket === "activation_pending")
        .every((r) => r.bucket_reason_code === "COMMENCED_LEASE_NOT_ACTIVATED"));
    ok("every Occupied bed's supporting_refs include its lease",
      rows.filter((r) => r.bucket === "occupied")
        .every((r) => (r.supporting_refs || []).some((x) => x.kind === "lease")));
    const anOpen = rows.find((r) => r.bucket === "open");
    ok("★ an Open bed states its POSITIVE basis",
      /Established vacant at 2026-07-31/.test(anOpen.bucket_reason)
      && /no operative lease spanning/.test(anOpen.bucket_reason)
      && /no unresolved contradiction/.test(anOpen.bucket_reason), anOpen.bucket_reason);
    const aPend = rows.find((r) => r.bucket === "activation_pending");
    ok("★ a Pending Activation bed names the lease and the condition",
      /committed/.test(aPend.bucket_reason)
      && /economic tenancy is not activated/.test(aPend.bucket_reason), aPend.bucket_reason);
    /*  This assertion used to regex the sentence for "accepted this bed as
     *  vacant". Rewording the copy to "records this bed as vacant" broke
     *  it — which is precisely why prose must not be the contract. The
     *  structural version lives above (reason code + conflicting_refs);
     *  what remains here is a SANITY check that the sentence is a real
     *  explanation naming both sides, not a phrase match. */
    ok("★ 109A's sentence still names both sides for a human",
      p109row.bucket_reason.includes(lease109A)
      && /vacant/.test(p109row.bucket_reason)
      && /no basis to choose/i.test(p109row.bucket_reason), p109row.bucket_reason);
    const anUnrec = rows.find((r) => r.bucket === "needs_review"
      && /could not reconcile/.test(r.bucket_reason || ""));
    ok("★ an unreconciled bed says the source row was left unresolved",
      !!anUnrec, "no unreconciled reason found");
    ok("no reason is a negative residue",
      rows.every((r) => !/none of the other|did not match|no bucket/i.test(r.bucket_reason)));

    //  Per-unit numbers must add up too, or the header and the rows disagree.
    const perUnit = rr.units.reduce((a, u) => ({
      occupied: a.occupied + u.occupied,
      activation_pending: a.activation_pending + u.activation_pending,
      open: a.open + u.open,
      needs_review: a.needs_review + u.needs_review,
    }), { occupied: 0, activation_pending: 0, open: 0, needs_review: 0 });
    ok("the unit rows sum to the header",
      JSON.stringify(perUnit) === JSON.stringify({ occupied: 31, activation_pending: 22,
        open: 100, needs_review: 7 }), JSON.stringify(perUnit));

    // ══ 7. THE FORWARD READ MUST AGREE ══════════════════════════════
    //  The regression this fix could have introduced.
    console.log("\n  ── the interval read refuses the same beds ──");
    const iv = await intervalPropertyPositions(pool,
      { property_id: prop, requested_start: TERM.from, requested_end: TERM.to });
    const held = new Set(heldBeds.map((x) => String(x.space_id)));
    const heldIv = iv.positions.filter((p) => held.has(String(p.space_id)));
    ok("all 6 unreconciled beds are visible in the interval read", heldIv.length === 6);
    ok("★ none of them is offered as contractually free",
      heldIv.every((p) => p.interval_state !== "contractually_free"),
      heldIv.map((p) => p.interval_state).join(","));
    //  THE ONE THAT ACTUALLY TESTS THE GATE. Five are blocked by their own
    //  competing lease and would have been blocked before this change too.
    //  This one has nothing on it and would have been offered as free.
    const gateBed = iv.positions.find(
      (p) => String(p.space_id) === String(heldNoLease.space_id));
    ok("★ an unreconciled bed with NO lease is held back by the evidence gate",
      gateBed.interval_state === "unresolved", gateBed.interval_state);
    ok("…and names unreconciled, not the disagrees reason",
      gateBed.unresolved_because === "opening_position_unreconciled",
      String(gateBed.unresolved_because));
    const iv109 = iv.positions.find((p) => String(p.space_id) === String(bed109A.space_id));
    ok("109A is not offered as free either", iv109.interval_state !== "contractually_free",
      iv109.interval_state);

    // ══ 8. THE VACANT CONFIRM PATH ══════════════════════════════════
    console.log("\n  ── a vacancy contradicted by a lease in force ──");
    const act2 = (await activation.openActivation(pool, {
      user_id: user, deal_intake_id: deal, property_id: prop,
      source_label: "second source" })).activation.id;
    const mkProp = (bed, normalized) => pool.query(
      `insert into proposed_records
         (activation_id, property_id, module, target_type, natural_key, normalized_json, status)
       values ($1,$2,'leasing','lease',$3,$4,'staged') returning id`,
      [act2, prop, `${bed.unit}|${bed.label}|${Math.random()}`,
       JSON.stringify({ unit_number: bed.unit, space_label: bed.label, ...normalized })])
      .then((r) => r.rows[0].id);

    const contradicted = await mkProp(bed109A, { is_vacant: true, market_rent: 825 });
    let refused = null;
    try { await activation.confirmProposal(pool, { user_id: user, proposed_id: contradicted }); }
    catch (e) { refused = e; }
    ok("★ confirming it refuses", refused
      && refused.reason === "vacancy_contradicted_by_operative_lease",
      refused ? refused.reason : "it was confirmed");
    const st = (await pool.query(
      `select status, status_reason from proposed_records where id=$1`, [contradicted])).rows[0];
    ok("…the proposal is needs_review", st.status === "needs_review", st.status);
    ok("…and the reason names the competing lease",
      String(st.status_reason || "").includes(lease109A));
    ok("…and the refusal is a sentence an operator can act on",
      /shown as empty on this rent roll/.test(refused.message)
      && /marked for review/.test(refused.message));

    //  Unchanged behaviour: a vacancy nobody contradicts still promotes.
    const clean = await mkProp(openBeds[0], { is_vacant: true, market_rent: 1200 });
    const cleanOut = await activation.confirmProposal(pool, { user_id: user, proposed_id: clean });
    ok("an uncontradicted vacancy still promotes, with no lease",
      cleanOut.vacant === true && cleanOut.lease_id === null);

    //  And a vacant row the source never tied to a bed still promotes —
    //  the guard resolves non-fatally rather than newly refusing these.
    const looseId = (await pool.query(
      `insert into proposed_records
         (activation_id, property_id, module, target_type, natural_key, normalized_json, status)
       values ($1,$2,'leasing','lease',$3,$4,'staged') returning id`,
      [act2, prop, `loose-${Math.random()}`,
       JSON.stringify({ unit_number: beds[0].unit, is_vacant: true, market_rent: 1200 })]
      )).rows[0].id;
    const looseOut = await activation.confirmProposal(pool, { user_id: user, proposed_id: looseId });
    ok("a vacant row naming no bed on a multi-bed unit still promotes",
      looseOut.vacant === true, JSON.stringify(looseOut));

    // ══ 9. NOT_ESTABLISHED IS NOT 160 EXCEPTIONS ════════════════════
    /*  The ruling's first blocker. A property that has never had an
     *  opening tenancy position established has ONE unmet precondition,
     *  not one tenancy conflict per bed. Unknown is not Open — and it is
     *  not 160 red rows either.  */
    console.log("\n  ── a property with no opening baseline ──");
    const bare = (await pool.query(
      `insert into properties (name, address, organization_id, leasing_basis)
       values ('No Baseline Property','2 Proof Way',$1,'bed') returning id`, [org])).rows[0].id;
    {
      const u = (await pool.query(
        `insert into units (property_id, unit_number) values ($1,'A1') returning id`,
        [bare])).rows[0].id;
      await pool.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [u]);
      for (const r of ["Room1", "Room2", "Room3"]) {
        await pool.query(`insert into spaces (unit_id, space_label) values ($1,$2)`, [u, r]);
      }
    }
    const bareRoll = await unitRentRoll(pool, { property_id: bare, as_of: AS_OF });
    ok("★ it is NOT_ESTABLISHED", bareRoll.truth_state === "NOT_ESTABLISHED",
      bareRoll.truth_state);
    ok("★ …and NOT a wall of 3 review exceptions",
      bareRoll.totals.needs_review === 0, JSON.stringify(bareRoll.totals));
    ok("★ …the beds are not_established, which is not a tenancy bucket",
      bareRoll.totals.not_established === 3 && bareRoll.totals.established === 0,
      JSON.stringify(bareRoll.totals));
    ok("★ …and they are NOT Open either",
      bareRoll.totals.open === 0, String(bareRoll.totals.open));
    ok("…totals and units are still returned, not blanked",
      !!bareRoll.totals && bareRoll.units.length === 1,
      JSON.stringify({ totals: !!bareRoll.totals, units: bareRoll.units.length }));
    ok("…each bed carries basis_state not_established with no bucket",
      bareRoll.units[0].positions.every((r) => r.basis_state === "not_established"
        && r.bucket === null && r.bucket_reason_code === "NO_AUTHORITATIVE_BASIS"),
      JSON.stringify(bareRoll.units[0].positions.map((r) => [r.basis_state, r.bucket])));
    ok("…and it says why, and what would resolve it",
      /have no authoritative fact establishing them/.test(bareRoll.why)
      && /Establish those positions/.test(bareRoll.next_step), bareRoll.why);

    //  A property with SOME basis is partially established — it must show
    //  the beds it can and say how many it cannot, never refuse the lot.
    await pool.query(
      `insert into leases (property_id, space_id, rent, lease_status, start_date, end_date, tenant_ids)
       select $1, s.id, 900, 'active', $2, $3, '{}' from spaces s
        join units u on u.id=s.unit_id
        where u.property_id=$1 and s.space_label='Room1'`, [bare, TERM.from, TERM.to]);
    const partial = await unitRentRoll(pool, { property_id: bare, as_of: AS_OF });
    ok("★ one lease makes the property PARTIALLY_ESTABLISHED",
      partial.truth_state === "PARTIALLY_ESTABLISHED", partial.truth_state);
    ok("★ …1 occupied is stated, 2 remain not_established",
      partial.totals.occupied === 1 && partial.totals.not_established === 2,
      JSON.stringify(partial.totals));
    ok("★ …and the two without a basis did NOT become needs_review",
      partial.totals.needs_review === 0, String(partial.totals.needs_review));

    // ══ 10. THE BASELINE IS CHOSEN BY DATE, NOT BY LIFECYCLE FLAG ═══
    /*  The ruling's second blocker, and the one my receipt under-ranked.
     *  Selecting `status = 'established'` does not merely forget an older
     *  baseline once a newer one lands — it applies the NEWER month's
     *  claims to the OLDER date. Actively wrong, on a read that used to be
     *  right.  */
    console.log("\n  ── an August baseline must not rewrite July ──");
    const julyRoll = await unitRentRoll(pool, { property_id: prop, as_of: AS_OF });
    ok("before: the July baseline answers", julyRoll.opening_baseline
      && julyRoll.opening_baseline.as_of_date === "2026-07-31",
      JSON.stringify(julyRoll.opening_baseline));
    const julyBuckets = JSON.stringify(julyRoll.totals);

    //  Establish an August 31 baseline over the same property. Its
    //  activation has NO proposals, so if a dated read ever selects it for
    //  an August-17 question the claims vanish and the numbers collapse —
    //  which is exactly the failure this asserts against.
    //  Through the CANONICAL writer, not by hand. The first version of
    //  this fixture flipped status with an UPDATE and the database refused
    //  it — "a superseded position must name what superseded it, and when".
    //  The deferred trigger was right, and emulating supersession would
    //  have proved the selection rule against a shape the writer never
    //  produces.
    const actAug = (await pool.query(
      `insert into activations (deal_id, property_id, status, source_as_of_date,
                                import_batch_id, opened_by_user_id)
       values ($1,$2,'open','2026-08-31',$3,$4) returning id`,
      [deal, prop, batchId, user])).rows[0].id;
    await pool.query(
      `insert into proposed_records
         (activation_id, property_id, module, target_type, natural_key, normalized_json, status)
       values ($1,$2,'leasing','lease',$3,$4,'promoted')`,
      [actAug, prop, `${openBeds[0].unit}|${openBeds[0].label}`,
       JSON.stringify({ unit_number: openBeds[0].unit, space_label: openBeds[0].label,
         is_vacant: true, market_rent: 1200 })]);
    const augOut = await activation.establishOpeningPosition(pool,
      { user_id: user, activation_id: actAug });
    ok("the August baseline was established through the canonical writer",
      !!augOut.opening_position && augOut.superseded !== null,
      JSON.stringify({ id: augOut.opening_position && augOut.opening_position.id,
        superseded: augOut.superseded }));

    const julyAfter = await unitRentRoll(pool, { property_id: prop, as_of: AS_OF });
    ok("★ the Aug-17 read still selects the JULY baseline",
      julyAfter.opening_baseline && julyAfter.opening_baseline.as_of_date === "2026-07-31",
      JSON.stringify(julyAfter.opening_baseline));
    ok("…even though that baseline is now marked superseded",
      julyAfter.opening_baseline.status === "superseded",
      julyAfter.opening_baseline.status);
    ok("★ and the four numbers are unchanged by the later establishment",
      JSON.stringify(julyAfter.totals) === julyBuckets,
      `${julyBuckets} → ${JSON.stringify(julyAfter.totals)}`);

    //  On or after the August baseline's own date, IT answers.
    const septRoll = await unitRentRoll(pool, { property_id: prop, as_of: "2026-09-15" });
    ok("a September read selects the AUGUST baseline",
      septRoll.opening_baseline && septRoll.opening_baseline.as_of_date === "2026-08-31",
      JSON.stringify(septRoll.opening_baseline));

    //  And before any baseline existed, the property was not established.
    const earlyRoll = await unitRentRoll(pool, { property_id: prop, as_of: "2026-06-01" });
    /*  ★ THE RULING'S CORE POINT, PROVEN. At 2026-06-01 NO opening
     *  baseline is effective — and the read still answers. The 109A April
     *  lease spans that date, so that ONE position is established by a
     *  canonical lease with no baseline anywhere, and the other 159 are
     *  honestly not_established. An opening tenancy position is a
     *  bootstrap mechanism, not a prerequisite: remove it entirely and
     *  native tenancy facts still establish what they establish.  */
    ok("★ with NO baseline at all, the read still answers",
      !!earlyRoll.totals && earlyRoll.totals.rentable_positions === 160,
      JSON.stringify(earlyRoll.totals));
    ok("★ …a native lease establishes its position with no baseline",
      earlyRoll.truth_state === "PARTIALLY_ESTABLISHED"
      && earlyRoll.totals.occupied === 1 && earlyRoll.totals.established === 1,
      JSON.stringify({ t: earlyRoll.truth_state, totals: earlyRoll.totals }));
    ok("★ …and the other 159 are not_established, not Open and not review",
      earlyRoll.totals.not_established === 159 && earlyRoll.totals.open === 0
      && earlyRoll.totals.needs_review === 0, JSON.stringify(earlyRoll.totals));

    // ══ 11. INVENTORY INVARIANTS ════════════════════════════════════
    console.log("\n  ── the inventory did not move ──");
    const inv = (await pool.query(
      `select count(distinct u.id)::int units, count(distinct s.id)::int spaces,
              count(distinct s.id) filter (where s.space_label='(whole unit)')::int phantoms
         from units u join spaces s on s.unit_id=u.id where u.property_id=$1`, [prop])).rows[0];
    ok("still 72 units / 160 beds / 0 phantoms",
      inv.units === 72 && inv.spaces === 160 && inv.phantoms === 0, JSON.stringify(inv));

  } catch (e) {
    console.error("\n  HARNESS ERROR:", e && e.stack ? e.stack : e);
    failed++;
  } finally {
    await pool.end();
  }

  console.log(`\n  ${failed === 0 ? "ALL PASS" : "FAILURES PRESENT"}   ${passed}/${passed + failed}`);
  receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
  process.exit(failed === 0 ? 0 : 1);
})();
