#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   leasing_basis_discovery.js — DISCOVER THE CYCLE BASIS FROM OPERATING
                                BEHAVIOUR, NOT FROM SEMANTICS

   The owner's ruling, verbatim in intent: do not settle Skyline's
   commitment basis by argument. Pull the fresh rent roll and Mike's live
   tracker together, see which beds he actually calls committed, and find
   the dated-lease-right rule that reproduces exactly those beds. Then
   Spine derives it from canonical truth and the tracker disappears.

   This tool is that comparison, run as a command instead of by hand.

   ── THE TWO QUESTIONS IT KEEPS APART ────────────────────────────────

     CURRENT OCCUPANCY    how many of the N positions are occupied TODAY
     FORWARD POSITION     how many are COMMITTED for a selected cycle

   They are different questions over the same positions and this tool
   never adds them, subtracts them or lets one stand in for the other.
   §1 answers the first — it is the reconciliation check against what the
   operator already knows ("we're around 90%"). §3/§4 answer the second.

   ── WHAT IT INFERS: NOTHING ─────────────────────────────────────────

   It does not pick a basis. It reports what each candidate rule produces,
   how sensitive each is to the cycle window's exact edges, and — when a
   tracker export is supplied — the EXACT SET DIFFERENCE between each rule
   and the beds a human is actually counting. A rule that reproduces the
   tracker's set is the discovered basis. If none does, the residual beds
   ARE the manual state the tracker carries, named bed by bed, which is
   the list that has to be explained before Spine can replace it.

   ── WHY COHORTS ARE A SECTION OF THEIR OWN ──────────────────────────

   Measured on the 07/31 rehearsal export: real leases start 2026-07-27
   and 2026-08-03. Those are two move-in weekends of ONE cycle. A rule
   keyed to a nominal 2026-08-01 window edge counts 91 beds; moving that
   edge back six weeks counts 122. The 30-bed difference is a cohort that
   obviously belongs to the cycle and falls four days outside the window.

   So "belongs to the cycle" is a COHORT question, and a calendar-window
   rule can split a cohort without anyone noticing. §2 shows the cohorts
   before §3 shows the rules, deliberately: look at how the property
   actually leases before choosing a predicate over it.

   READ-ONLY. Every statement is a SELECT, wrapped in a read-only
   transaction that is rolled back.

   CLASS 3 — activation-acceptance tooling. Removal condition: delete once
   property_leasing_cycles.commitment_basis is established for the
   property and the tracker is retired (docs/LEASING_CYCLE_AND_PACE_TRACE.md).

   Run:
     DATABASE_URL=<the db holding the FRESH import> \
     node tools/leasing_basis_discovery.js \
       --property "Skyline" \
       --cycle-start 2026-08-01 --cycle-end 2027-07-31 \
       [--as-of 2026-08-16] \
       [--tracker /path/to/mikes_tracker.xlsx]

   The tracker file may be .xlsx or .csv. It needs a column naming the
   bed (unit and room, together or apart). Rows it cannot resolve are
   REPORTED, never dropped — a silently shrinking comparison set would
   make any rule look better than it is.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Pool } = require("pg");
const { datedPropertyPositions } = require("../src/tenancy/dated_positions");

/*  ⚠ READ AT THE CONNECTION SITE ON PURPOSE — see the same note in
 *  tools/turn_readiness_census.js and GAP 2 in
 *  docs/build1/INTEGRITY_GAPS.md. An alias here is invisible to
 *  tests/gates/gate_harness_isolation.js. */
if (!process.env.DATABASE_URL) {
  console.error("\n  DATABASE_URL is required — point it at the database holding the FRESH import.\n");
  process.exit(2);
}

// ── arguments ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PROPERTY = arg("property");
const CYCLE_START = arg("cycle-start");
const CYCLE_END = arg("cycle-end");
const AS_OF = arg("as-of", new Date().toISOString().slice(0, 10));
const TRACKER = arg("tracker");
const TRACKER_SHEET = arg("tracker-sheet");

if (!PROPERTY || !CYCLE_START || !CYCLE_END) {
  console.error("\n  --property, --cycle-start and --cycle-end are all required.");
  console.error("  A cycle is a named span. Without both dates there is no span to ask about.\n");
  process.exit(2);
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;
for (const [n, v] of [["cycle-start", CYCLE_START], ["cycle-end", CYCLE_END], ["as-of", AS_OF]]) {
  if (!ISO.test(v)) { console.error(`\n  --${n} must be YYYY-MM-DD, got "${v}"\n`); process.exit(2); }
}
if (CYCLE_END < CYCLE_START) { console.error("\n  cycle-end is before cycle-start.\n"); process.exit(2); }

// ── bed identity, normalised the same way on both sides ────────────
/*  A tracker is written by a human for humans: "1417-101 Room1",
 *  "101-Room1", "101 rm1", "101/1". Spine holds unit_number '1417-101'
 *  and space_label 'Room1'. This reduces both to one comparable key.
 *
 *  It is deliberately DUMB and deliberately LOUD. It does not fuzzy
 *  match, and anything it cannot reduce is reported as unresolved rather
 *  than guessed onto a bed. Attaching a tracker row to the wrong bed
 *  would corrupt the exact set difference this whole tool exists to
 *  produce. */
function bedKey(unitNumber, spaceLabel) {
  const u = String(unitNumber || "").trim().toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^.*?-(?=\d)/, "");            // '1417-101' -> '101'
  const r = String(spaceLabel || "").trim().toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^(room|rm|bed|bd|space)/, "") // 'Room1' -> '1'
    .replace(/^[-/#.]+/, "");
  return r ? `${u}#${r}` : `${u}#-`;        // '-' = whole unit, not "room unknown"
}

/*  Parse one tracker cell/row into (unit, room). Returns null when the
 *  row does not look like a bed at all — a header, a blank, a total.
 *
 *  ⚠ ORDER MATTERS, and the first version had it backwards. It tried the
 *  combined "unit and room in one cell" pattern FIRST, with the room digit
 *  optional. Fed the ordinary two-column row ["1417-103","Room1"], that
 *  pattern happily consumed "1417-103" ALONE as unit 10 / room 3 — the
 *  building prefix satisfied the optional `\d{3,4}-`, "10" satisfied the
 *  unit, and the trailing "3" satisfied the room. Every bed resolved to a
 *  position that does not exist, all six rules reported 0 matches, and the
 *  output was a clean table.
 *
 *  So: SEPARATE CELLS FIRST, and the combined form now REQUIRES an explicit
 *  room keyword rather than treating a trailing digit as one. An optional
 *  group that can eat part of the identifier beside it is not a tolerant
 *  parser, it is a silent one. */
const UNIT_ONLY = /^(?:\d{3,4}-)?\d{2,4}$/;                 // '1417-103' or '103'
const ROOM_ONLY = /^(?:room|rm|bed|bd|space)\s*[-#.]?\s*([0-9a-d])$|^([0-9a-d])$/i;
const COMBINED = /^(?:(\d{3,4})-)?(\d{2,4})\s*[-/ ]\s*(?:room|rm|bed|bd|space)\s*[-#.]?\s*([0-9a-d])$/i;
const stripBuilding = (u) => String(u).replace(/^\d{3,4}-(?=\d)/, "");

function parseTrackerRow(cells) {
  const strs = cells.map((c) => (c == null ? "" : String(c).trim())).filter(Boolean);
  if (!strs.length) return null;

  //  Case 1 — unit in one cell, room in another. The ordinary export shape.
  const unitCell = strs.find((s) => UNIT_ONLY.test(s));
  if (unitCell) {
    const roomCell = strs.find((s) => s !== unitCell && ROOM_ONLY.test(s));
    if (roomCell) {
      const m = roomCell.match(ROOM_ONLY);
      return { unit: stripBuilding(unitCell), room: m[1] || m[2] };
    }
  }

  //  Case 2 — both in one cell, with the room NAMED: "1417-101 Room1".
  for (const s of strs) {
    const m = s.match(COMBINED);
    if (m) return { unit: m[2], room: m[3] };
  }

  //  Case 3 — a by-unit tracker, no room grain at all.
  if (unitCell) return { unit: stripBuilding(unitCell), room: null };
  return null;
}

/*  A bed letter is an ORDINAL POSITION within the unit, and different
 *  systems spell the same ordinal differently: Spine's rent-roll import
 *  produced 'Room1'/'Room2'/'Room3', the leasing tracker writes 'A'/'B'/'C'.
 *  Mapping one to the other is deterministic and reversible, so it is done
 *  rather than refused — but it is NAMED in the output, because a silent
 *  identity translation is how two systems come to disagree about which bed
 *  they mean. */
const LETTER_ORDINAL = { a: "1", b: "2", c: "3", d: "4" };
const asOrdinal = (room) => {
  const r = String(room == null ? "" : room).trim().toLowerCase()
    .replace(/^(room|rm|bed|bd|space)\s*[-#.]?\s*/, "");
  return LETTER_ORDINAL[r] || r;
};

/*  ── HEADER-AWARE READING ────────────────────────────────────────────
 *  A real leasing tracker is not a list of committed beds — it is a list of
 *  EVERY bed, with a status column saying which are committed. Reading it as
 *  "every parseable row is committed" would have scored the tracker at 160
 *  of 160 and made every rule look wrong by exactly the remaining count.
 *
 *  So: find a header row, find the status column, and split the rows the way
 *  the operator does. If no status column is found, every bed row counts and
 *  the output SAYS so, because that assumption changes every number below. */
const STATUS_HEADER = /^(signed\s*\/?\s*pending|signed|status|lease\s*status)$/i;
const COMMITTED_VALUE = /^(signed|pending|executed|committed|yes|x)$/i;
const PENDING_VALUE = /^pending$/i;
const UNIT_HEADER = /^unit\s*#?$|^unit$|^apt\.?\s*#?$/i;
const ROOM_HEADER = /^(room|bed|space)\s*#?$/i;

function sheetRows(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".csv" || ext === ".tsv" || ext === ".txt") {
    const sep = ext === ".tsv" ? "\t" : ",";
    return [["(file)", require("fs").readFileSync(file, "utf8")
      .split(/\r?\n/).map((l) => l.split(sep))]];
  }
  const XLSX = require("xlsx");
  const wb = XLSX.readFile(file);
  return wb.SheetNames.map((n) =>
    [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null })]);
}

function readTracker(file, sheetFilter) {
  /*  ⚠ EXACT NAME WINS. A substring filter of "Skyline 2026-2027 RR" also
   *  matches "Skyline 2026-2027 RR Stats" — and the Stats sheet is a summary
   *  whose "Total Units / Total Beds" cells parse as bed identifiers. It
   *  produced four fictional beds and a clean zero-match table. A summary tab
   *  next to a detail tab with a prefix name is the ordinary case, not an
   *  exotic one, so the ordering is part of the contract. */
  const all = sheetRows(file);
  const wanted = !sheetFilter ? all
    : (all.filter(([n]) => n.toLowerCase().trim() === sheetFilter.toLowerCase().trim()).length
      ? all.filter(([n]) => n.toLowerCase().trim() === sheetFilter.toLowerCase().trim())
      : all.filter(([n]) => n.toLowerCase().includes(sheetFilter.toLowerCase())));
  const sheets = wanted;
  const resolved = [], unresolved = [], identityConflicts = [];
  let statusColUsed = null, sheetUsed = null;

  for (const [name, rows] of sheets) {
    //  locate a header row and its columns
    let hdr = -1, cStatus = -1, cUnit = -1, cRoom = -1;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const cells = (rows[i] || []).map((c) => String(c == null ? "" : c).trim());
      const s = cells.findIndex((c) => STATUS_HEADER.test(c));
      const u = cells.findIndex((c) => UNIT_HEADER.test(c));
      if (u >= 0) { hdr = i; cUnit = u; cStatus = s; cRoom = cells.findIndex((c) => ROOM_HEADER.test(c)); break; }
    }
    for (let i = (hdr >= 0 ? hdr + 1 : 0); i < rows.length; i++) {
      const row = rows[i] || [];
      const cell = (j) => (j >= 0 && row[j] != null ? String(row[j]).trim() : "");
      let unit = null, room = null;
      if (cUnit >= 0 && /^\d{2,4}\s*[a-d]?/i.test(cell(cUnit))) {
        const raw = cell(cUnit);
        const m = raw.match(/^(\d{2,4})\s*([a-d])?/i);
        unit = m[1];
        const fromUnit = m[2] ? m[2].toLowerCase() : null;
        const fromRoom = cRoom >= 0 && cell(cRoom) ? asOrdinal(cell(cRoom)) : null;
        //  ⚠ BOTH COLUMNS, CROSS-CHECKED. Neither is reliable alone: this
        //  tracker has one row whose Unit cell is wrong and one whose Room
        //  cell is wrong, and each mis-identifies a real signed bed.
        const fromUnitOrd = fromUnit ? LETTER_ORDINAL[fromUnit] : null;
        if (fromUnitOrd && fromRoom && fromUnitOrd !== fromRoom) {
          identityConflicts.push({ sheet: name, row: i + 1, raw,
            unitSays: fromUnit.toUpperCase(), roomSays: cell(cRoom),
            status: cStatus >= 0 ? cell(cStatus) : "" });
        }
        room = fromUnitOrd || fromRoom;
      } else {
        const p = parseTrackerRow(row);
        if (p) { unit = p.unit; room = p.room == null ? null : asOrdinal(p.room); }
      }
      if (unit == null) {
        if (row.some((c) => c != null && String(c).trim())) {
          unresolved.push(row.filter(Boolean).join(" | "));
        }
        continue;
      }
      const status = cStatus >= 0 ? cell(cStatus) : "";
      resolved.push({
        key: bedKey(unit, room), raw: row.filter(Boolean).join(" | "),
        status,
        committed: cStatus < 0 ? true : COMMITTED_VALUE.test(status),
        pending: PENDING_VALUE.test(status),
      });
      statusColUsed = cStatus >= 0 ? cStatus : statusColUsed;
      sheetUsed = name;
    }
    if (resolved.length) break;                 // first sheet that yields beds
  }
  return { resolved, unresolved, identityConflicts,
    statusColumnFound: statusColUsed != null, sheetUsed };
}

// ── candidate bases ────────────────────────────────────────────────
/*  Each is a pure predicate over (lease, window). Adding one is a line.
 *  NONE of them is the answer; the tracker picks. `stable` records
 *  whether the rule's count moves when the window edges move — a rule
 *  that swings under a two-day edit is a rule people will argue about. */
const d = (s) => String(s || "").slice(0, 10);
const BASES = [
  { key: "A_start_in_window", label: "lease STARTS inside the cycle window",
    fn: (l, w) => l.start_date && d(l.start_date) >= w.start && d(l.start_date) <= w.end },
  { key: "A2_start_near_anchor", label: "lease STARTS within ±45d of cycle_start (the cohort reading)",
    fn: (l, w) => l.start_date && d(l.start_date) >= shift(w.start, -45) && d(l.start_date) <= shift(w.start, 45) },
  { key: "B_overlaps", label: "lease OVERLAPS the window at all",
    fn: (l, w) => d(l.start_date) <= w.end && (l.end_date ? d(l.end_date) : "9999-12-31") >= w.start },
  { key: "C_covers_window", label: "lease covers the WHOLE window",
    fn: (l, w) => d(l.start_date) <= w.start && (l.end_date ? d(l.end_date) : "9999-12-31") >= w.end },
  { key: "D_covers_80pct", label: "lease covers >= 80% of the window",
    fn: (l, w) => {
      const s = maxs(d(l.start_date), w.start), e = mins(l.end_date ? d(l.end_date) : "9999-12-31", w.end);
      return days(s, e) >= 0.8 * days(w.start, w.end);
    } },
  { key: "E_ends_near_cycle_end", label: "lease ENDS within ±45d of cycle_end (the term-anchored reading)",
    fn: (l, w) => l.end_date && d(l.end_date) >= shift(w.end, -45) && d(l.end_date) <= shift(w.end, 45) },
];
const maxs = (a, b) => (a > b ? a : b);
const mins = (a, b) => (a < b ? a : b);
const days = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
function shift(iso, n) {
  const t = Date.parse(iso + "T00:00:00Z") + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

const TERMINAL = new Set(["cancelled", "rescinded", "void", "superseded", "terminated", "expired"]);

// ── output helpers ─────────────────────────────────────────────────
const H = (s) => console.log(`\n  ── ${s} ──`);
const pct = (n, d0) => (d0 ? `${((100 * n) / d0).toFixed(1)}%` : "—");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const host = (() => { try { return new globalThis.URL(process.env.DATABASE_URL).host; } catch (_) { return "(unparsed)"; } })();

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  LEASING BASIS DISCOVERY — read-only");
  console.log(`  DATABASE   ${host}`);
  console.log(`  CYCLE      ${CYCLE_START} → ${CYCLE_END}`);
  console.log(`  OCCUPANCY  as of ${AS_OF}`);
  console.log(`  TRACKER    ${TRACKER || "(none supplied — §4 will not run)"}`);
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  This tool chooses NOTHING. It reports what each candidate rule");
  console.log("  produces and, with a tracker, which rule reproduces the beds a");
  console.log("  human is actually counting.");

  try {
    await client.query("begin read only");

    const prop = (await client.query(
      `select id, name from properties
        where id::text = $1 or name ilike '%'||$1||'%' order by name limit 2`, [PROPERTY])).rows;
    if (!prop.length) { console.log(`\n  No property matched "${PROPERTY}".`); return; }
    if (prop.length > 1) {
      console.log(`\n  "${PROPERTY}" matched more than one property. Name it exactly or pass the id:`);
      prop.forEach((p) => console.log(`     ${p.id}  ${p.name}`));
      return;
    }
    const P = prop[0];
    console.log(`\n  PROPERTY   ${P.name}  ${P.id}`);

    // ── the denominator, from canonical inventory ──────────────────
    const beds = (await client.query(
      `select s.id as space_id, u.unit_number, s.space_label
         from spaces s join units u on u.id = s.unit_id
        where u.property_id = $1
        order by u.unit_number, s.space_label`, [P.id])).rows;
    const keyOf = new Map(beds.map((b) => [String(b.space_id), bedKey(b.unit_number, b.space_label)]));
    const labelOf = new Map(beds.map((b) => [bedKey(b.unit_number, b.space_label),
      `${b.unit_number} ${b.space_label || ""}`.trim()]));
    const N = beds.length;

    // ═════ 1 · CURRENT OCCUPANCY — the reconciliation check ════════
    H(`1 · CURRENT OCCUPANCY as of ${AS_OF} — denominator ${N} rentable positions`);
    console.log("     From the canonical dated read. This is TODAY, not the cycle.");
    const dp = await datedPropertyPositions(client, { property_id: P.id, as_of: AS_OF });
    const byState = {};
    for (const p of dp.positions) byState[p.tenancy_state] = (byState[p.tenancy_state] || 0) + 1;
    for (const [k, v] of Object.entries(byState).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(k).padEnd(26)} ${String(v).padStart(4)}   ${pct(v, N)}`);
    }
    const occ = byState.contractually_occupied || 0;
    console.log(`     ${"".padEnd(26)} ────`);
    console.log(`     OCCUPIED (contractually)   ${String(occ).padStart(4)}   ${pct(occ, N)}`);
    if (byState.unresolved) {
      console.log(`\n     ⚠ ${byState.unresolved} positions are UNRESOLVED — no spanning lease, and the`);
      console.log("       opening claim does not say vacant. They are NOT vacant and NOT");
      console.log("       occupied. Any occupancy % that hides them is overstating certainty.");
    }

    // ═════ 2 · LEASE START COHORTS ═════════════════════════════════
    /*  ⚠ CAST THE DATES IN SQL. `pg` returns a `date` column as a JS Date,
     *  and `String(aDate).slice(0,10)` is "Mon Aug 03" — which compares as a
     *  string against "2026-08-01" and loses, silently, for every row.
     *
     *  The first run of this tool printed a clean table in which every
     *  candidate basis returned 0 beds. Not an error, not a crash: six
     *  well-formatted zeros. The identical defect was fixed in
     *  openingTruth() two commits ago ("Fri Jul 31"), and it came straight
     *  back in new code because the coercion looks harmless at the call site.
     *
     *  to_char, not toISOString — toISOString is the classic DATE off-by-one
     *  when the server's zone is behind UTC. */
    const live = (await client.query(
      `select l.id, l.space_id, l.lease_status,
              to_char(l.start_date, 'YYYY-MM-DD') as start_date,
              to_char(l.end_date,   'YYYY-MM-DD') as end_date
         from leases l join spaces s on s.id = l.space_id join units u on u.id = s.unit_id
        where u.property_id = $1`, [P.id])).rows
      .filter((l) => !TERMINAL.has(String(l.lease_status || "").toLowerCase()));

    /*  THE ASSERTION THAT WOULD HAVE CAUGHT IT. Every comparison below is a
     *  string comparison against 'YYYY-MM-DD'; a value in any other shape
     *  does not throw, it just never matches. Check the shape once, here,
     *  rather than trusting six predicates to notice. */
    const badDate = live.find((l) =>
      (l.start_date != null && !ISO.test(l.start_date)) ||
      (l.end_date != null && !ISO.test(l.end_date)));
    if (badDate) {
      console.log(`\n  REFUSING: a lease date is not YYYY-MM-DD (${badDate.start_date} / ${badDate.end_date}).`);
      console.log("  Every basis below compares dates as strings, so a wrong shape returns");
      console.log("  zero beds for every rule instead of failing. Fix the cast, not the output.");
      await client.query("rollback");
      return;
    }

    H("2 · HOW THIS PROPERTY ACTUALLY LEASES — lease-start cohorts");
    console.log("     Clustered on a 14-day gap. Look at this BEFORE choosing a rule:");
    console.log("     a calendar window edge that lands inside a cohort splits it.");
    const starts = [...new Set(live.map((l) => d(l.start_date)).filter(Boolean))].sort();
    const cohorts = [];
    for (const s of starts) {
      const last = cohorts[cohorts.length - 1];
      if (last && days(last.dates[last.dates.length - 1], s) <= 14) last.dates.push(s);
      else cohorts.push({ dates: [s] });
    }
    for (const c of cohorts) {
      const inC = live.filter((l) => c.dates.includes(d(l.start_date)));
      const bedsIn = new Set(inC.map((l) => String(l.space_id))).size;
      const span = c.dates.length === 1 ? c.dates[0] : `${c.dates[0]} … ${c.dates[c.dates.length - 1]}`;
      const edge = (c.dates[0] < CYCLE_START && c.dates[c.dates.length - 1] >= CYCLE_START)
        || (c.dates[0] <= CYCLE_END && c.dates[c.dates.length - 1] > CYCLE_END);
      console.log(`     ${span.padEnd(28)} ${String(bedsIn).padStart(4)} beds` +
        (edge ? "   ⚠ STRADDLES A CYCLE EDGE — a window rule splits this cohort" : ""));
    }

    // ═════ 3 · CANDIDATE BASES + EDGE SENSITIVITY ══════════════════
    H("3 · CANDIDATE BASES — committed beds for this cycle, and edge sensitivity");
    console.log("     'moves ±Nd' = how the count changes when BOTH window edges shift.");
    console.log("     A rule that swings under a small edit is a rule people will argue over.");
    const setFor = (basis, w) => {
      const out = new Set();
      for (const l of live) if (basis.fn(l, w)) out.add(String(l.space_id));
      return out;
    };
    const W = { start: CYCLE_START, end: CYCLE_END };
    const results = new Map();
    for (const b of BASES) {
      const base = setFor(b, W);
      results.set(b.key, base);
      const swing = [7, 30].map((n) => {
        const lo = setFor(b, { start: shift(W.start, -n), end: shift(W.end, -n) }).size;
        const hi = setFor(b, { start: shift(W.start, n), end: shift(W.end, n) }).size;
        return `±${n}d → ${lo}/${hi}`;
      }).join("  ");
      console.log(`     ${b.key.padEnd(22)} ${String(base.size).padStart(4)} beds  ${pct(base.size, N).padStart(6)}   ${swing}`);
      console.log(`     ${"".padEnd(22)} ${b.label}`);
    }
    /*  A second, cruder net under the same failure. Six rules disagreeing is
     *  the normal case (that is the whole point); six rules ALL returning
     *  zero against a live lease population is not a finding about the
     *  property, it is a defect in this tool. */
    if (live.length && [...results.values()].every((s) => s.size === 0)) {
      console.log("\n     ⚠ EVERY basis returned zero against " + live.length + " live leases.");
      console.log("       That is not a fact about this property. Suspect date handling or the");
      console.log("       cycle window before reporting any of these numbers.");
    }

    // ═════ 4 · TRACKER RECONCILIATION ══════════════════════════════
    if (!TRACKER) {
      H("4 · TRACKER RECONCILIATION — NOT RUN");
      console.log("     No --tracker supplied. Nothing above picks a basis, and this tool");
      console.log("     will not pick one from the numbers alone. Re-run with the live");
      console.log("     tracker export to discover which rule matches operating behaviour.");
    } else {
      const T = readTracker(TRACKER, TRACKER_SHEET);
      const { resolved, unresolved, identityConflicts } = T;
      const committedRows = resolved.filter((r) => r.committed);
      const trackerKeys = new Set(committedRows.map((r) => r.key));
      const known = new Set(labelOf.keys());
      const trackerUnknown = [...trackerKeys].filter((k) => !known.has(k));
      const trackerMatched = new Set([...trackerKeys].filter((k) => known.has(k)));

      H(`4 · TRACKER RECONCILIATION — ${TRACKER}`);
      if (T.sheetUsed) console.log(`     sheet                            ${T.sheetUsed}`);
      console.log(`     rows that parsed as a bed        ${resolved.length}`);
      if (T.statusColumnFound) {
        const pend = committedRows.filter((r) => r.pending).length;
        console.log(`     …the tracker marks COMMITTED     ${committedRows.length}  (of which pending ${pend})`);
        console.log(`     …the tracker leaves OPEN         ${resolved.length - committedRows.length}`);
      } else {
        console.log("     ⚠ NO STATUS COLUMN FOUND — every parsed bed row is being treated as");
        console.log("       committed. If this tracker lists all inventory with a status column,");
        console.log("       that assumption inflates the tracker set and makes every rule below");
        console.log("       look wrong by exactly the open-bed count. Check the header row.");
      }
      console.log(`     distinct committed beds          ${trackerKeys.size}`);
      console.log(`     …resolved to a Spine position    ${trackerMatched.size}`);
      if (identityConflicts.length) {
        console.log(`\n     ⚠ ${identityConflicts.length} tracker rows NAME THE BED TWO DIFFERENT WAYS:`);
        identityConflicts.forEach((c) => console.log(
          `        row ${c.row}: Unit cell says "${c.raw}" (${c.unitSays}) but Room cell says "${c.roomSays}"` +
          (c.status ? `  [${c.status}]` : "")));
        console.log("       Neither column is reliable alone. Each conflict leaves one real bed");
        console.log("       unnamed and double-counts another — resolve them before trusting the");
        console.log("       counts, and note this is a defect the tracker cannot detect itself.");
      }
      if (trackerUnknown.length) {
        console.log(`\n     ⚠ ${trackerUnknown.length} tracker beds DO NOT EXIST in Spine's inventory:`);
        trackerUnknown.slice(0, 25).forEach((k) => console.log(`        ${k}`));
        if (trackerUnknown.length > 25) console.log(`        … and ${trackerUnknown.length - 25} more`);
        console.log("       Either the import is missing inventory or the tracker names beds");
        console.log("       differently. Resolve this BEFORE trusting any diff below — a");
        console.log("       comparison set that silently shrank makes every rule look better.");
      }
      if (unresolved.length) {
        console.log(`\n     ⚠ ${unresolved.length} tracker rows could not be parsed as a bed at all`);
        console.log("       (headers, totals and blanks are expected here — scan for real rows):");
        unresolved.slice(0, 10).forEach((r) => console.log(`        ${r.slice(0, 90)}`));
        if (unresolved.length > 10) console.log(`        … and ${unresolved.length - 10} more`);
      }

      console.log("\n     ── set difference, per candidate rule ──");
      console.log("     RULE                    match   rule-only   tracker-only");
      let exact = null;
      for (const b of BASES) {
        const ruleKeys = new Set([...results.get(b.key)].map((sid) => keyOf.get(sid)).filter(Boolean));
        const both = [...ruleKeys].filter((k) => trackerMatched.has(k));
        const ruleOnly = [...ruleKeys].filter((k) => !trackerMatched.has(k));
        const trackOnly = [...trackerMatched].filter((k) => !ruleKeys.has(k));
        console.log(`     ${b.key.padEnd(22)} ${String(both.length).padStart(5)}   ${String(ruleOnly.length).padStart(9)}   ${String(trackOnly.length).padStart(12)}`);
        if (!ruleOnly.length && !trackOnly.length && trackerMatched.size) exact = { b, ruleOnly, trackOnly };
        b._diff = { ruleOnly, trackOnly };
      }

      console.log("");
      if (exact) {
        console.log(`     ✓ EXACT MATCH — ${exact.b.key}`);
        console.log(`       "${exact.b.label}"`);
        console.log("       This rule reproduces the tracker's beds with no residue. It is the");
        console.log("       discovered commitment_basis, and the tracker becomes derivable.");
      } else {
        console.log("     ✗ NO CANDIDATE REPRODUCES THE TRACKER EXACTLY.");
        console.log("       That is a finding, not a failure. The closest rule's residue IS the");
        console.log("       manual state the tracker carries — the beds a human is counting for");
        console.log("       a reason Spine has no recorded fact for. Name them, then decide");
        console.log("       whether that reason is a fact Spine should be recording.");
        const ranked = [...BASES].sort((a, b2) =>
          (a._diff.ruleOnly.length + a._diff.trackOnly.length) -
          (b2._diff.ruleOnly.length + b2._diff.trackOnly.length));
        const best = ranked[0];
        console.log(`\n       closest: ${best.key} — ${best.label}`);
        const show = (title, keys) => {
          if (!keys.length) return;
          console.log(`\n       ${title} (${keys.length}):`);
          keys.slice(0, 40).forEach((k) => console.log(`          ${labelOf.get(k) || k}`));
          if (keys.length > 40) console.log(`          … and ${keys.length - 40} more`);
        };
        show("BEDS THE RULE COMMITS AND THE TRACKER DOES NOT", best._diff.ruleOnly);
        show("BEDS THE TRACKER COMMITS AND THE RULE DOES NOT", best._diff.trackOnly);
      }
    }

    await client.query("rollback");
  } finally {
    client.release();
    await pool.end();
  }

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  §1 is TODAY. §3/§4 are THE CYCLE. Never quote one as the other.");
  console.log("  And neither is pace: when each bed BECAME committed is not");
  console.log("  recoverable from a rent roll — see LEASING_CYCLE_AND_PACE_TRACE §5.");
  console.log("════════════════════════════════════════════════════════════════\n");
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
