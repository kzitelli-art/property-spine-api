// ════════════════════════════════════════════════════════════════════
//  rent_roll_field_map.js — WHAT THE COLUMNS IN A REAL RENT ROLL MEAN
//
//  PURE. No database, no I/O, no clock. Rows in, mapped rows out.
//
//  ── THE GAP THIS FILLS ──────────────────────────────────────────────
//  Two normalizers already existed and neither did this job:
//
//    activation.js normalizeRow      tolerant header matching, but its
//                                    output shape only fed proposals
//    snapshot_loader.js normalizeRow expects ALREADY-CANONICAL keys
//                                    (unit_number, market_rent, lease_from)
//                                    and shapes them into a ledger row
//
//  So the ledger writer could never be fed from a real export: it wanted
//  keys nobody's Yardi/AppFolio/Entrata spreadsheet actually uses. This
//  module is the layer between them — header spellings in, canonical keys
//  out — which is what lets ONE activation write both the evidence
//  substrate and the proposals without a second importer.
//
//  ── IT REPORTS ITS OWN WORK ─────────────────────────────────────────
//  Every mapped field records WHICH source header produced it. That is not
//  debugging output: it is the "here is what Spine understood" screen. A
//  human confirming a position needs to see that we read *their* "Mkt
//  Rent" column as market rent, and needs to see which of their columns we
//  ignored. A mapping nobody can inspect is a guess wearing a table.
//
//  ── HONEST BLANK ────────────────────────────────────────────────────
//  A header we do not recognise is reported as unmapped. It is never
//  guessed at by position, and never silently dropped.
// ════════════════════════════════════════════════════════════════════

"use strict";

/*  Canonical field → the header spellings that mean it.
 *
 *  Compared after squashing to lowercase alphanumerics, so "Mkt. Rent",
 *  "MKT_RENT" and "mktrent" are one entry. Order matters WITHIN a field:
 *  the first spelling that appears in the row wins, so the most specific
 *  spellings are listed first.
 *
 *  Deliberately NOT a fuzzy matcher. Recognition may propose; ambiguity
 *  may not silently choose. An unrecognised column stays unrecognised. */
const FIELD_SPELLINGS = Object.freeze({
  unit_number: ["unit", "unitnumber", "unitno", "unitid", "unit#", "apt", "apartment",
                "aptnumber", "suite", "space", "unitcode", "bldgunit"],
  space_label: ["bed", "bedspace", "room", "roomnumber", "spacelabel", "bedlabel"],
  //  "unitroomtype" is Yardi's two-line header "Unit/Room" + "Type" joined —
  //  observed in the real 07/31/2026 Skyline export, which carried the unit
  //  type (STU00015) under it. Learned from the artifact, not guessed.
  unit_type:   ["unittype", "type", "floorplan", "plan", "planname", "unitplan", "style",
                "unitroomtype", "roomtype"],
  name:        ["tenant", "tenantname", "resident", "residentname", "lessee", "occupant",
                "primaryresident", "residentfullname", "name"],
  resident_id: ["residentid", "tenantid", "tcode", "tenantcode", "residentcode"],
  status:      ["status", "unitstatus", "leasestatus", "occupancystatus", "occupancy"],
  sqft:        ["sqft", "squarefeet", "squarefootage", "sf", "unitsqft", "rentablesqft", "area"],
  market_rent: ["marketrent", "market", "mktrent", "askingrent", "marketrate", "gpr",
                "grosspotentialrent", "scheduledrent"],
  actual_rent: ["actualrent", "rent", "currentrent", "leaserent", "monthlyrent", "chargerent",
                "contractrent", "inplacerent", "rentamount", "baserent"],
  //  "residentdeposit" is the real export's name for the security deposit.
  deposit:     ["deposit", "securitydeposit", "secdeposit", "security", "depositheld", "sd",
                "residentdeposit"],
  other:       ["other", "otherdeposit", "otherdeposits", "otherincome"],
  balance:     ["balance", "currentbalance", "arbalance", "amountdue", "outstanding", "delinquent"],
  move_in:     ["movein", "moveindate", "movein_date", "actualmovein", "midate"],
  move_out:    ["moveout", "moveoutdate", "actualmoveout", "modate", "vacatedate"],
  lease_from:  ["leasefrom", "leasestart", "leasestartdate", "startdate", "start", "from",
                "leasebegin", "termstart"],
  lease_to:    ["leaseto", "leaseend", "leaseenddate", "enddate", "end", "to", "expiration",
                "expires", "expirationdate", "termend", "leaseexpiration"],
  email:       ["email", "emailaddress", "tenantemail", "residentemail"],
  phone:       ["phone", "phonenumber", "tenantphone", "residentphone", "cell", "mobile"],
});

//  Columns a rent roll commonly carries that we deliberately do not map.
//  Named so the review screen can say "read and not used" rather than
//  leaving them in the same bucket as "we had no idea what this was".
const KNOWN_UNUSED = Object.freeze(new Set([
  "notes", "note", "comment", "comments", "property", "propertyname", "building",
  "bldg", "floor", "petrent", "parking", "concession", "concessions", "leaseterm",
  "term", "renewaloffer", "noticedate", "lateffee", "latefee",
  //  Read and deliberately not used. The room-summarised export carries one
  //  row per bed and states "Total Beds 1.00" on each; the bed count is the
  //  row itself, so mapping it would store the same fact twice.
  "totalbeds", "beds",
]));

function squash(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/*  Which canonical field, if any, does this header mean?  Exact match on
 *  the squashed spelling only. */
function fieldForHeader(header) {
  const h = squash(header);
  if (!h) return null;
  for (const [field, spellings] of Object.entries(FIELD_SPELLINGS)) {
    if (spellings.includes(h)) return field;
  }
  return null;
}

/*  Build the header → field plan ONCE for a whole file, from the union of
 *  keys actually present. Doing it per row would let two rows in the same
 *  file map the same column differently, which is how a spreadsheet
 *  quietly becomes two spreadsheets. */
function planFor(rows) {
  const headers = [];
  const seen = new Set();
  for (const row of rows || []) {
    for (const k of Object.keys(row || {})) {
      //  Keys the CALLER attached for its own bookkeeping are not source
      //  columns. Excluded by prefix so a harness or importer can carry
      //  context without it being reported as an unread column.
      if (k === "__row_number" || k.startsWith("__")) continue;
      if (!seen.has(k)) { seen.add(k); headers.push(k); }
    }
  }

  const mapped = {};          // canonical field → source header
  const usedHeaders = new Set();
  //  First spelling listed for a field wins, so a file carrying both
  //  "Rent" and "Actual Rent" resolves to the more specific one.
  for (const [field, spellings] of Object.entries(FIELD_SPELLINGS)) {
    let best = null, bestRank = Infinity;
    for (const h of headers) {
      const rank = spellings.indexOf(squash(h));
      if (rank >= 0 && rank < bestRank) { best = h; bestRank = rank; }
    }
    if (best) { mapped[field] = best; usedHeaders.add(best); }
  }

  const unmapped = [], ignored = [];
  for (const h of headers) {
    if (usedHeaders.has(h)) continue;
    (KNOWN_UNUSED.has(squash(h)) ? ignored : unmapped).push(h);
  }

  return { headers, mapped, unmapped, ignored };
}

const NUM = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === "-" || s === "--") return null;
  //  (1,234.00) is accounting notation for negative. A balance read as
  //  positive when it is owed is a wrong-confident number.
  const neg = /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[()$,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
};

const DATE = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  //  Already ISO — take it without going through Date(), which reinterprets
  //  a bare ISO date as UTC midnight and can shift it a day west of GMT.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (us) {
    const [, mo, da, yrRaw] = us;
    const yr = yrRaw.length === 2 ? (Number(yrRaw) > 70 ? `19${yrRaw}` : `20${yrRaw}`) : yrRaw;
    return `${yr}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const TEXT = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

const SHAPE = Object.freeze({
  unit_number: TEXT, space_label: TEXT, unit_type: TEXT, name: TEXT,
  resident_id: TEXT, status: TEXT, email: TEXT, phone: TEXT,
  sqft: NUM, market_rent: NUM, actual_rent: NUM, deposit: NUM, other: NUM, balance: NUM,
  move_in: DATE, move_out: DATE, lease_from: DATE, lease_to: DATE,
});

/*  ── "VACANT" IS NOT A PERSON ──────────────────────────────────────
 *  Real rent rolls put the unit's state in the RESIDENT column: VACANT,
 *  MODEL, DOWN, OFFLINE, "Vacant-Ready". Read literally, that is a tenant
 *  named VACANT — and confirming it would create a person, a lease and a
 *  tenancy for a unit that is empty. The worst possible wrong-confident
 *  value: it inflates occupancy, revenue and the position all at once.
 *
 *  Same vocabulary the ledger's own normalizer already uses
 *  (snapshot_loader NON_REVENUE), so one document cannot mean two things
 *  depending on which reader looked at it. */
const NON_REVENUE_NAME =
  /^(vacant|vacancy|model|down|offline|available|unoccupied|empty|vac)\b/i;

function readsAsNonRevenue(value) {
  const s = String(value == null ? "" : value).trim();
  return s !== "" && NON_REVENUE_NAME.test(s);
}

/*  ── mapRows ───────────────────────────────────────────────────────
 *  rows        as the app parsed them, original headers intact
 *  returns     { plan, mapped: [ …canonical rows… ] }
 *
 *  Each mapped row also carries `_raw`, the untouched original. The
 *  evidence row stores the ORIGINAL, never our reading of it — what the
 *  source contained must survive our interpretation of it changing. */
function mapRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const plan = planFor(list);

  const mapped = list.map((row, i) => {
    const section = String(row && row.__section || "current").trim().toLowerCase();
    const out = {
      row_index: Number(row && row.__row_number) || i + 1,
      section: section === "future" ? "future" : "current",
    };
    for (const [field, header] of Object.entries(plan.mapped)) {
      out[field] = (SHAPE[field] || TEXT)(row ? row[header] : null);
    }
    //  A non-revenue marker in the resident column is a STATE, not a name.
    //  Moved to `status`, and the name is cleared so nothing downstream can
    //  create a person called VACANT.
    if (readsAsNonRevenue(out.name)) {
      if (!out.status) out.status = String(out.name).trim().toLowerCase();
      out.name = null;
      out.resident_id = null;
      out.non_revenue = true;
    } else {
      out.non_revenue = readsAsNonRevenue(out.status);
    }

    //  ── THE PMS IDENTIFIER MAY BE INSIDE THE NAME ─────────────────
    //  Yardi's room-summarised rent roll has no resident-id COLUMN. It
    //  writes the code into the resident cell:
    //
    //      "Sindhura Nagabhirava (s0005738)"
    //
    //  That identifier is worth keeping — it is how this person is known
    //  in the system of record, and it is the only stable handle the
    //  source offers. So it is split out into `resident_id` and the name
    //  is left clean.
    //
    //  WHAT IT IS NOT: a merge key. §12 says a phone, name or email may
    //  be EVIDENCE of identity and may never silently create or merge a
    //  durable person, and a foreign system's primary key is no different
    //  — it is that system's assertion about its own records, recorded as
    //  sourced external identity. Two rows carrying one code are still two
    //  rows until a human says otherwise.
    //
    //  Deliberately narrow: a parenthesised token at the END of the cell,
    //  letter-then-digits. "Smith (unit 4)" and "Ana (see note)" do not
    //  match and are left alone, because recognition may propose and
    //  ambiguity may not silently choose.
    if (out.name && out.resident_id == null) {
      const m = String(out.name).match(/^(.*?)\s*\(([A-Za-z]\d{3,})\)\s*$/);
      if (m && m[1].trim()) {
        out.name = m[1].trim();
        out.resident_id = m[2];
        out.resident_id_source = "embedded_in_name";
      }
    }

    //  `rent` is the contractual fact consumed by the ledger. Market rent
    //  is an asking fact and cannot fill an absent contract value.
    out.rent = out.actual_rent == null ? null : out.actual_rent;
    out._raw = row || {};
    return out;
  });

  return { plan, mapped };
}

/*  A human-readable account of the mapping, for the review screen.
 *  Deliberately says what was NOT understood as loudly as what was. */
function describePlan(plan) {
  return {
    understood: Object.entries(plan.mapped).map(([field, header]) => ({
      column: header, read_as: field.replace(/_/g, " "),
    })),
    ignored: plan.ignored,
    not_understood: plan.unmapped,
    receipt: plan.unmapped.length
      ? `${Object.keys(plan.mapped).length} columns understood. ` +
        `${plan.unmapped.length} not recognised and left out: ${plan.unmapped.join(", ")}.`
      : `${Object.keys(plan.mapped).length} columns understood. Nothing was left unread.`,
  };
}

module.exports = { mapRows, planFor, describePlan, fieldForHeader, FIELD_SPELLINGS };
