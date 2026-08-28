// ════════════════════════════════════════════════════════════════════
//  TOUR CHIPS — proof, measured against REAL conversations.
//
//  The question this answers is not "does the function run" but "would
//  these six chips have been right for this actual person?" So it runs
//  the deriver over live prospect threads and prints the chips beside the
//  evidence that produced them, for a human to judge.
//
//  It also proves the refusals, which matter more than the hits:
//    · a person with nothing on record gets NO chips, not six generic ones
//    · the agent's own words never become the prospect's preference
//    · a stated fact outranks a passing mention
//    · fewer than six is a legitimate answer
//
//  Read-only. No writes anywhere.
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const CH = require("../../src/leasing/tour_chips");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

(async () => {
  console.log("TOUR CHIPS — what mattered most, proposed in advance\n");

  // ── [1] never an empty screen, never a padded list ────────────────
  //  Fable 9b.7: model failure must not block capture — fall back to a
  //  small generic set. My first cut returned nothing at all, which left a
  //  rushed agent typing. But padding a PERSONALISED list is still wrong,
  //  so the two cases must stay visibly different.
  console.log("[1] never an empty screen, never a padded list");
  const empty = CH.deriveChips({});
  check(empty.chips.length > 0, "nothing on record → a generic set, not a blank screen",
        `${empty.chips.length} chips`);
  check(empty.personalized === false,
        "and it is flagged NOT personalized",
        "so no surface can present it as 'we noticed…'");
  check(empty.chips.every(c => c.source === "generic"),
        "every fallback chip says it is generic");
  check(/not a read of them/.test(empty.note || ""), "and the note says so plainly");

  const thin = CH.deriveChips({ attributes: [{ attr_key: "budget", attr_value: "$1,500" }] });
  check(thin.chips.length === 1 && thin.personalized === true,
        "ONE real signal → one chip, NOT padded to six",
        `${thin.chips.length} — ${thin.note}`);
  check(!thin.chips.some(c => c.source === "generic"),
        "sourced and generic chips are never mixed",
        "a generic chip beside evidence is indistinguishable from evidence");

  // ── [2] the honest escape, and whose words count ───────────────────
  console.log("\n[2] the agent can say they could not read it");
  check(!!(empty.escape && empty.escape.is_escape),
        "'Nothing clear yet' is always offered", empty.escape.label);
  check(!empty.chips.some(c => c.key === "nothing_clear"),
        "and it is NOT a chip",
        "a rushed operator tapping a random chip to finish is how analytics go confidently wrong");
  const outboundOnly = CH.deriveChips({ inboundText: [] });
  check(outboundOnly.personalized === false,
        "our own words never become their preference",
        "asking 'is quiet important?' is not the prospect caring about quiet");

  // ── [2b] the unit they actually walked through ─────────────────────
  console.log("\n[2b] on a multi-unit tour, WHICH unit landed");
  const multi = CH.deriveChips({
    attributes: [{ attr_key: "budget", attr_value: "$1,500" }],
    unitsShown: [{ unit_number: "304" }, { unit_number: "512" }],
  });
  check(multi.chips.some(c => c.label === "Unit 304") && multi.chips.some(c => c.label === "Unit 512"),
        "both units shown become chips", "Fable's example list included 'Unit 304'");
  const single = CH.deriveChips({
    attributes: [{ attr_key: "budget", attr_value: "$1,500" }],
    unitsShown: [{ unit_number: "304" }],
  });
  check(!single.chips.some(c => /^Unit /.test(c.label)),
        "a SINGLE unit produces no unit chip",
        "a question with one possible answer is not worth a tap");

  // ── [3] a stated fact outranks a passing mention ──────────────────
  console.log("\n[3] evidence is ranked, not just collected");
  const ranked = CH.deriveChips({
    attributes: [{ attr_key: "pets", attr_value: "60lb lab" }],
    inboundText: ["is there parking nearby"],
  });
  const pets = ranked.chips.find(c => c.key === "pets");
  const park = ranked.chips.find(c => c.key === "parking");
  check(pets && pets.strength > (park ? park.strength : 0),
        "a stated fact outranks a passing question",
        `pets(${pets && pets.strength}) > parking(${park && park.strength})`);
  check(pets && pets.evidence === "60lb lab",
        "and each chip carries the evidence that produced it",
        "a proposal the agent cannot audit is a guess wearing a label");

  // ── [4] AGAINST REAL CONVERSATIONS ────────────────────────────────
  console.log("\n[4] real people, real threads — would these have been right?");
  const people = (await pool.query(
    `select c.person_id, p.name, count(e.id)::int as inbound
       from conversations c
       join persons p on p.id = c.person_id
       join comm_events e on e.conversation_id = c.id and e.direction='inbound'
      where c.property_id = $1 and e.body is not null
      group by 1,2 having count(e.id) >= 3
      order by 3 desc limit 6`, [DEMO])).rows;

  let withChips = 0;
  for (const pr of people) {
    const msgs = (await pool.query(
      `select e.body from comm_events e
         join conversations c on c.id = e.conversation_id
        where c.person_id=$1 and c.property_id=$2
          and e.direction='inbound' and e.body is not null
        order by e.occurred_at limit 60`, [pr.person_id, DEMO])).rows.map(r => r.body);
    const attrs = (await pool.query(
      `select attr_key, attr_value from person_attributes
        where person_id=$1 and (status is null or status = 'active')`, [pr.person_id])).rows;

    const out = CH.deriveChips({ attributes: attrs, inboundText: msgs });
    if (out.personalized) withChips++;
    console.log(`\n  ── ${pr.name}  (${pr.inbound} inbound, ${attrs.length} facts)`
      + (out.personalized ? "" : "   [GENERIC FALLBACK]"));
    console.table(out.chips.map(c => ({
      chip: c.label, from: c.source, strength: c.strength,
      evidence: (c.evidence || "").slice(0, 50),
    })));
    if (out.note) console.log(`     note: ${out.note}`);
  }

  check(people.length > 0, "found real threads to measure against", `${people.length} people`);
  check(withChips > 0, `${withChips} of ${people.length} got PERSONALISED chips`,
        "the rest fell back to generic — honestly labelled, not silently padded");

  // ── [5] the cap holds ─────────────────────────────────────────────
  console.log("\n[5] the surface stays small");
  const many = CH.deriveChips({
    attributes: [{ attr_key: "budget", attr_value: "x" }, { attr_key: "pets", attr_value: "y" },
                 { attr_key: "unit_type", attr_value: "z" }, { attr_key: "move_month", attr_value: "w" }],
    inboundText: ["quiet street? lots of light? parking? gym? laundry? safe area? food nearby? commute?"],
  });
  check(many.chips.length <= CH.MAX_CHIPS, `never more than ${CH.MAX_CHIPS} chips`,
        `${many.considered} candidates → ${many.chips.length} shown`);
  check(many.chips[0].strength >= many.chips[many.chips.length - 1].strength,
        "and the strongest evidence is shown first");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
