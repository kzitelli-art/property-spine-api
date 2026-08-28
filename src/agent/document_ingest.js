// document_ingest.js — extracted VERBATIM from server.js (lines 1680-2633).
// Route paths and registration order are unchanged: server.js mounts this
// router at "/" at the exact position these routes were registered inline.
const express = require("express");
const XLSX = require("xlsx");

module.exports = function documentIngest({ pool, anthropic, registryInstance }) {
  const router = express.Router();
// ════════════════════════════════════════════════════════════════════
//  AI INGESTION — staged + auditable. The trust layer made honest.
//  Paste a messy rent roll → the AI extracts rows → NOTHING writes straight
//  into `units`. Instead we persist:
//    • one ingest_run  — the raw input, the model's raw output, the model id
//    • N ingest_candidates — each extracted row + its AI provenance, held
//      for review at decision_status='pending'
//  A separate /promote step turns an approved candidate into a real unit in
//  an EXPLICIT, recorded transition (promoted_unit_id/at/by). If the system
//  ever says "confirmed", there is now a record of what was confirmed,
//  against what input, by which model, and who promoted it.
//
//  Model id lives in the INGEST_MODEL env var (set in Render) so the working
//  string is config, not code — change it without a redeploy of logic.
// ════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
//  INGEST v2 — THE COLLAPSE ENGINE
//
//  Replaces the narrow units-only ingest prompt with a LEVELS-AWARE engine.
//  The job is not "parse a rent roll." It is: take messy real-estate material
//  (rent roll, offering memo, broker package, unit mix, pasted text, Excel,
//  CSV, PDF, Word) and collapse it to the deepest reliable structure the
//  document supports — never all-or-nothing.
//
//  Extraction hierarchy (extract to the deepest level the doc supports):
//    L1 Property shell  — name, address, asset type, total units
//    L2 Unit mix        — types, bed/bath, counts by type, market rents
//    L3 Unit schedule   — unit-by-unit rows, status, rents
//    L4 Lease detail    — tenant, dates, in-place rent, deposits, concessions
//    L5 Exceptions      — vacant, down, employee, model, MTM, eviction, offline
//
//  A thin OM that only discloses "24 units: 12 1BR / 12 2BR" is a SUCCESS at
//  L2 — not a failure. The engine reports the level reached and what's missing.
//
//  This UPGRADES the brain and widens the accepted file types. It preserves
//  the proven staged flow (run -> candidates -> approve -> promote) and the
//  ingest_candidates columns unchanged: the unit-level slice still persists
//  exactly as before, so promote/approve keep working. The richer levelled
//  extraction is returned in the API response now; persisting L1/L2/L4/L5 to
//  their own tables is a later migration once the shape is proven in use.
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
//  INGEST v2 — THE COLLAPSE ENGINE
//
//  Replaces the narrow units-only ingest prompt with a LEVELS-AWARE engine.
//  The job is not "parse a rent roll." It is: take messy real-estate material
//  (rent roll, offering memo, broker package, unit mix, pasted text, Excel,
//  CSV, PDF, Word) and collapse it to the deepest reliable structure the
//  document supports — never all-or-nothing.
//
//  Extraction hierarchy (extract to the deepest level the doc supports):
//    L1 Property shell  — name, address, asset type, total units
//    L2 Unit mix        — types, bed/bath, counts by type, market rents
//    L3 Unit schedule   — unit-by-unit rows, status, rents
//    L4 Lease detail    — tenant, dates, in-place rent, deposits, concessions
//    L5 Exceptions      — vacant, down, employee, model, MTM, eviction, offline
//
//  A thin OM that only discloses "24 units: 12 1BR / 12 2BR" is a SUCCESS at
//  L2 — not a failure. The engine reports the level reached and what's missing.
//
//  This UPGRADES the brain and widens the accepted file types. It preserves
//  the proven staged flow (run -> candidates -> approve -> promote) and the
//  ingest_candidates columns unchanged: the unit-level slice still persists
//  exactly as before, so promote/approve keep working. The richer levelled
//  extraction is returned in the API response now; persisting L1/L2/L4/L5 to
//  their own tables is a later migration once the shape is proven in use.
// ════════════════════════════════════════════════════════════════════

const INGEST_MODEL = process.env.INGEST_MODEL || "claude-sonnet-4-6";

// ── THE COLLAPSE PROMPT ───────────────────────────────────────────────
function ingestPrompt(text) {
  return `You are the extraction engine for a property-management platform. You read ONE piece of real-estate material and COLLAPSE it to the clean structure underneath. The source may be a rent roll, an offering memorandum, a broker package, a property-management report, a unit-mix table, or pasted text — flattened from Excel/CSV/PDF/Word or pasted by hand. Formats vary wildly (AppFolio, Yardi Breeze, Yardi Voyager, broker OMs, student-housing schedules). Read it the way an experienced operator would.

YOUR FIRST OBLIGATION IS NOT PERFECTION — it is to find the highest-confidence useful truth in the document, at whatever depth it supports. Never fail just because the document is incomplete. Extract to the DEEPEST reliable level:
  L1 Property shell: property name, address, asset type, total unit count.
  L2 Unit mix: unit types, bed/bath counts, count of each type, market/asking rents if present.
  L3 Unit schedule: unit-by-unit rows — unit number, floorplan, status, rent.
  L4 Lease detail: tenant name, lease start/end, in-place rent, deposit, concessions, prelease/renewal status.
  L5 Exceptions: vacant, down/offline, employee, model, month-to-month, eviction, non-revenue, unknown.

Report the deepest level you reliably reached in "level_reached".

DETECT THE SOURCE SYSTEM FIRST, then apply its column map. Known systems and their telltales:
- AppFolio: title "Rent Roll"; a dedicated "Status" COLUMN with values like "Current" / "Vacant-Unrented"; columns Unit, Tenant, Status, Rent (single rent, no market/actual split), Deposit, "Lease From", "Lease To"; footer like "107 Units 95.3% Occupied". No resident IDs, no SqFt, no charge columns. By-bed units written as "101 - 1".
- Entrata (PeakMade and other Entrata-based managers): report template label "AME - Budgeted Rent (ACCT)" at top of every page; footer "Rent Roll 3.7 generated <timestamp> MDT and data as of <timestamp> MDT"; section labels "Unit Details" then "Future Resident Details" then "Average Charges by Unit Type Summary"; plain-English unit types ("Studio","1x1","2x2"); NO resident ID codes (names only, "Last, First"). Columns: "Bldg-Unit" (unit, no leading zeros e.g. "101"), "Unit Type", "SQFT", "Unit Status" (dedicated column), "Resident" (name or "-- Vacant --"), "Budgeted Rent", "Scheduled Charges", "Balance" (negatives in parens), "Deposit Held", "Move-In", "Lease Start", "Lease End", "Expected Move-Out". ENTRATA RENT MAPPING: "Budgeted Rent" -> market_rent (pro-forma/market); "Scheduled Charges" -> actual_rent (what's actually billed in place). "Unit Status" vocabulary maps: "Occupied No Notice"->active; "Notice Rented"/"Notice Unrented"->active (on notice, still occupied); "Vacant Rented Ready"/"Vacant Rented"->vacant (pre-leased, note it); "Vacant Unrented Ready"->vacant; "-- Vacant --"->vacant. ENTRATA PARSING WARNING: resident names and statuses WRAP across 2-3 physical text lines, and vacant units show "-- Vacant --" in the Resident column — do NOT treat a wrapped continuation line as a separate unit; associate wrapped text with the unit row it belongs to.
- Yardi Breeze: header "Property = <name>"; "As Of =" + "Month ="; columns Unit, "Unit SqFt", "Tenant Name", "Actual Rent", "Actual Rent per Sqft", "Tenant Deposit", "Other Deposit", "Misc" (single ancillary bucket, not itemized), "Misc per Sqft", "Move In", "Lease Expiration", "Move Out", "Balance". Status via SECTION HEADERS ("Current/Notice/Vacant Tenants" vs "Future Tenants/Applicants"). The "per Sqft" analytic columns are the giveaway.
- Yardi Voyager (by-unit): header "<name> (1325)"; resident IDs like "t0002191"; unit-type codes like "ut000011"; columns Unit, "Unit Type", "Unit Sq Ft", "Resident" (ID), "Name", "Market Rent", "Actual Rent", "Resident Deposit", "Other", "Move In", "Lease Expiration", "Move Out", "Balance". Status via section headers ("Current/Notice/Vacant Residents" vs "Future Residents/Applicants"); footer "Summary Groups" with "% Unit Occupancy".
- Yardi Voyager (by-room/bed, student housing): header "(crm…)" + a "Summarize By = Room|Bed" line; student IDs like "s0003894"; columns Unit, "Room", "Bed", "Unit/Room Type" (e.g. STU00011), "Resident" (name + s# or VACANT), "Sq Ft", "Market Rent", "Actual Rent", deposits, "Move In", "Lease From", "Lease To", "Move Out", "Balance"; footer "Summary Groups" with "# Of Beds" / "% Bed Occupancy".
- Seller/handoff roll: title often "Rent Roll Analysis"; columns "Tenant Name", "Unit", "Unit Type" (floorplan like "2BR/2BA"), "Rent", "Security Deposit", "Move In/Out", "Lease Start/End"; names as "Last, First". This is what a SELLER hands over at acquisition — a distinct shape.
Put your best guess in detected_system; if none match, "unknown" and read it generically.

CHARGE CODES & CREDITS: some systems (Entrata especially) itemize ancillary charges and CREDITS in a summary block — e.g. "Admin Fees", "Amenity Premium", "Application Fee", "Late Charges", and credits like "Employee Unit Rent Credit" or "Model" shown as NEGATIVE. When a unit's rent figure is a net of such codes, the base residential rent is what matters for actual_rent — do not let a credit line (employee/model) read as the unit's market rent; flag those units' status accordingly (employee/model) and note it. AFFORDABLE / INCOME-RESTRICTED UNITS: some unit types carry an affordability tag — e.g. "A1-AFF 50", "AFF 80", "AFF 30", "LIHTC", "ami". The number is an AMI percentage (an income cap), and the rent is intentionally and legally set far below market for that unit. This is CORRECT, not an error — never flag a low affordable rent as wrong and never normalize it toward market. Capture the affordable status in the unit's note (e.g. "affordable, 50% AMI") and keep its actual_rent exactly as shown.

PROPERTY IDENTITY: the ADDRESS is the stable identity of a property — NOT its name. The same building is often renamed over time (e.g. "SOLO on Chestnut" -> "Uno on Chestnut") and its system database code changes. Always capture the address in property.address; treat the marketing name as a label that can change.

NORMALIZE across formats:
- Many docs have multiple rent columns ("Pre-Lease Rent" vs "In-Place Rent", "Market Rent" vs "Actual Rent"). Map the CURRENT contract/in-place rent to actual_rent, and the asking/market/pre-lease rent to market_rent. If only one rent exists and the doc is a rent roll, it's actual_rent; if it's an OM, it's market_rent (asking).
- STATUS lives in different places by system — derive it from EITHER a "Status" column (AppFolio: "Current"->active, "Vacant-Unrented"->vacant) OR the SECTION HEADER a row sits under (Yardi: rows under "Current/Notice/Vacant …" are active unless the name is VACANT). Normalize to: active | vacant | down | employee | model | mtm | eviction | non_revenue | unknown. Also map "Occupied"->active, "Available"->vacant, "Down"->down, "Employee"->employee, "Model"->model, "MTM"/"Month to Month"->mtm. Also scan the RESIDENT/TENANT NAME itself for status words even when the status column or section says occupied: a resident shown as "Model", "<code>, Model", "Employee", "Admin", "Office", or "Down" means the unit is non-revenue (model/employee/etc.) regardless of what the status column says — set status accordingly and note it. A model or employee unit hidden inside an "Occupied" section is a real pattern, not a contradiction to ignore.
- FORWARD-LOOKING UNITS — THE REVENUE-SPINE RULE. The rent roll is not a flat snapshot; it carries what is true TODAY plus what is already SCHEDULED. A single unit can hold more than one true fact: it can be VACANT today yet have a future resident pre-leased into it; it can be OCCUPIED today yet on notice with a move-out scheduled. NEVER collapse a future fact into the current status, and NEVER overwrite the current row with the future one. The SAME unit number can appear twice in a file — once under "Current/Notice/Vacant" and again under "Future Residents/Applicants" (or Entrata's "Future Resident Details"). When that happens, emit the unit ONCE: its top-level status/rent/tenant = the CURRENT-section fact (e.g. vacant), and attach the future-section fact to a "future_events" array on that unit. Do not emit "future" as a status. A row that appears ONLY under a future/applicants section (no current-section counterpart) is a future_event on its unit with current status vacant.
  future_events[] entries look like: { "type": "scheduled_move_in" | "scheduled_move_out" | "renewal" | "rent_change", "tenant_name": "...", "rent": 0, "lease_start": "YYYY-MM-DD", "lease_end": "YYYY-MM-DD" } — include ONLY the fields each event actually has.
- Unit numbers are STRINGS — preserve exactly, including leading zeros ("0101") and alphanumerics ("1F","2R","BR","1325-101").
- ROOM/BED is first-class for student / by-the-bed housing. When the roll has Room and/or Bed columns (or beds leased individually), capture room and bed per row. The bed — not the unit — is the leasable atom; one lease can be one bed.
- PHANTOM ROWS: either Yardi config emits a second row at "0.00" Actual Rent when one resident holds a whole unit (the extra room/bed rows). Do NOT count a 0.00-rent phantom row as a separate lease or as a vacant bed — attribute it to the same resident/lease.
- DO NOT trust filenames or folder names for the reporting period. Take snapshot_date ONLY from the in-file date line ("As Of =", "As of:", "As of"). If there is no in-file date, snapshot_date is null — never infer it from context.
- Itemized charges (parking, pet, insurance) captured separately when present. Breeze lumps ancillary into one "Misc" column — capture it as a single misc charge, not as rent. AppFolio has none. Never fold ancillary into rent. CONCESSIONS ARE NOT THE RENT. A row may show a base/market rent, then a concession or discount line that reduces it — sometimes to near zero (e.g. base 1471, concession -1471, "Total" 220). The unit's actual_rent is the BASE contract rent (1471), NOT the post-concession net (220). Capture the concession separately (in note, e.g. "concession -1471 this period") and never report the discounted net as the unit's rent. A "Total" column that already nets concessions and ancillary is a display total, not the lease rate — do not map it to actual_rent or market_rent.
- A RENT ROLL IS NOT ALWAYS THE WHOLE PROPERTY. Many exports are residential-only and silently omit commercial/retail, parking, and other income that genuinely exists at the property. Do NOT assume the document is the complete income picture. In "missing", state which income types are present in THIS file (e.g. "residential only — no commercial/retail or parking section in this file; the property may still have it"). Never treat the absence of a retail or parking section as evidence the property has none. When a document DOES contain a commercial rent roll — NNN tenants, base-rent-per-SF, CAM — keep those lines separate from residential units; put any you see in "unclear" rather than the residential units[] array.

PROVENANCE — every extracted unit carries prov:
- "confirmed" = read directly from a clear row/section (a bedroom count from a clear "Unit Type" header IS a direct read, not a guess).
- "assumed" = genuine ambiguity: bedrooms with no source, no rent anywhere, a value inferred from an OM's marketing claim, a non-residential/placeholder line, an unparseable unit number, or conflicting values. An offering memo's rents are asking CLAIMS => assumed.

HARD RULES:
- NEVER invent a value. No support => null. A wrong confident value is worse than an honest blank. This is the most important rule.
- Only residential units. Ignore titles, column headers, divider lines, subtotals, any line containing "Total", metadata rows, blanks.
- Parking/storage/retail/amenity lines are NOT units — put their raw line in "unclear".
- If you cannot tell whether a row is a unit, do NOT invent it — raw line into "unclear".
- If the document has NO reliable property/unit signal at all, say so: set level_reached to "none" and explain in "missing".

TOP OF THE STRUCTURE IS NOT ALWAYS ONE PROPERTY. A single file can describe a DEAL / PORTFOLIO — one transaction covering MANY separate properties (separate street addresses). An offering memorandum (OM) for a portfolio is the prime example. The real hierarchy is: file -> deal/portfolio -> properties -> units. Decide first which case you are in:
  • SINGLE PROPERTY: one building / one address (a normal rent roll, a single-asset OM). Emit the flat "property" + "units" shape (the classic shape, unchanged).
  • DEAL / PORTFOLIO: a named offering covering multiple addresses (e.g. "Philadelphia Family Housing Portfolio — 83 units, 284 beds, 28 properties"). Emit the "deal" shape: a deal shell plus a "subject_properties" array, with each property's units nested UNDER it.

SUBJECT vs COMP — THE MOST IMPORTANT ROUTING DECISION IN AN OM. An OM contains the asset being SOLD (the SUBJECT) and also reference material that must NEVER be treated as part of the asset:
  • SUBJECT properties/units: the actual real estate being offered for sale. In a portfolio OM these are listed in the "portfolio overview", the "portfolio rent roll", the "unit mix", and the per-address tax/financial tables. These are the ONLY things that matter for this workflow.
  • COMPS and other NOISE: "Sale comparables" / "sale comps", "Lease comparables" / "lease comps", market-survey tables, surrounding-area statistics, broker contact pages, lender names, maps, photos, market commentary, university/enrollment data. These are OTHER people's buildings or context — shown only for pricing/market color. A sale comp like "2233 N 20th Street, 38 units" is NOT a subject property and its 38 units are NOT subject units.

ROUTING RULE FOR THIS WORKFLOW: capture SUBJECT properties and SUBJECT units ONLY. You MUST still RECOGNIZE a comp well enough to KNOW it is a comp (so it is not mistaken for a subject) — but once recognized, DROP it. Do NOT list comp properties, comp units, broker/lender/market addresses, or market tables in the output. Do NOT spend effort itemizing sale comps or lease comps. The cost of a comp leaking in as a subject is severe (a stranger's building becomes a fake property); the cost of omitting a comp is zero for this workflow. When in genuine doubt whether an address is subject or comp, prefer to EXCLUDE it and note the ambiguity in "missing".
  Telltales that an address is a SUBJECT: it appears in the portfolio overview / portfolio rent roll / unit-mix / per-address tax table; it is inside the offering's own address list; the doc's unit and bed totals are built from it.
  Telltales that an address is a COMP / NOISE: it sits under a heading containing "comparable", "comp", "sale comp", "lease comp", "market", "survey"; it has a Sale Price / Price-Per-Unit / Cap Rate / "leased at sale" / "Seller / Buyer" line; it is a named complex used for rent comparison; it is a broker office or lender address.

DEAL-LEVEL FINANCIAL TABLES: a portfolio OM carries deal-wide financial tables — a tax/assessment table (per-address assessed values + tax bills), a stabilized income & expense (I&E / NOI) summary, an offering price. These belong to the DEAL, not to any one unit. Identify them and place them in "deal.financial_tables" by name with their headline figures. Do NOT force their numbers into units. If a per-address figure (e.g. a tax bill) can be matched to a subject property, you may note it on that property; otherwise keep it at deal level.

OUTPUT SIZE — CRITICAL FOR LARGE ROLLS: Keep the JSON as SMALL as possible. OMIT any field whose value is null, empty, or unknown — do NOT write it out. Only include fields you actually found a value for. The ONLY always-required field per unit is "unit_number"; include "prov" too, and any of the other fields ONLY when they have a real value. This keeps a 100+ unit roll inside one response. The server fills any omitted field with null after parsing, so leaving a field out is exactly equivalent to null — but far smaller.

Return ONLY valid JSON, no prose, no markdown fences. OMIT every field that would be null/empty. There are TWO top-level shapes; choose ONE:

(A) SINGLE PROPERTY — the classic shape (use for a normal rent roll or single-asset doc):
{
  "document_type": "rent_roll | offering_memo | unit_mix | broker_package | pm_report | unknown",
  "detected_system": "appfolio | yardi_breeze | yardi_voyager | entrata | broker_om | student_schedule | seller_handoff | unknown",
  "scope": "single_property",
  "level_reached": "L1 | L2 | L3 | L4 | L5 | none",
  "snapshot_date": "YYYY-MM-DD (omit if none)",
  "property": { "name": "...", "address": "...", "asset_type": "...", "total_units": 0 },
  "unit_mix": [ { "unit_type": "", "bedrooms": 0, "bathrooms": 0, "count": 0, "market_rent": 0 } ],
  "units": [
    { "unit_number": "REQUIRED", "status": "active|vacant|down|employee|model|mtm|eviction|non_revenue|unknown",
      "prov": "confirmed|assumed",
      "...include ONLY fields with real values from this set": "room, bed, address, bedrooms, bathrooms, square_feet, market_rent, actual_rent, lease_start, lease_end, tenant_name, resident_code, deposit, balance, note",
      "future_events": "OMIT unless the unit has a scheduled future move-in/out/renewal; array of { type, tenant_name, rent, lease_start, lease_end }" }
  ],
  "missing": [ "what a buyer/operator would still need that this doc didn't provide" ],
  "unclear": [ "raw lines seen but not placed" ]
}

(B) DEAL / PORTFOLIO — use when ONE transaction covers MANY addresses. SUBJECT properties only; comps DROPPED:
{
  "document_type": "offering_memo | broker_package | ...",
  "detected_system": "broker_om | ...",
  "scope": "deal_portfolio",
  "level_reached": "L1 | L2 | L3 | L4 | L5",
  "snapshot_date": "YYYY-MM-DD (omit if none — e.g. the rent roll 'As of' date)",
  "deal": {
    "name": "The Philadelphia Family Housing Portfolio",
    "broker": "Avison Young (omit if none)",
    "location": "Philadelphia, PA",
    "asset_type": "student / affordable / multifamily ...",
    "stated_totals": { "properties": 28, "units": 83, "beds": 284, "occupancy": "57.8%", "in_place_avg_rent": 1696 },
    "financial_tables": [
      { "name": "tax_underwriting", "note": "per-address assessed values + tax bills", "total_prior_assessed": 17745300, "total_new_assessed": 14927500, "total_tax_bill": 208955.15 },
      { "name": "stabilized_ie", "gross_potential_rent": 2133405, "noi": 1111653 }
    ]
  },
  "subject_properties": [
    {
      "address": "1711 W Montgomery Avenue",   // ADDRESS is identity; REQUIRED per property
      "prov": "confirmed|assumed",
      "...optional property fields with real values": "name, total_units, total_beds, tax_bill, assessed_value, note",
      "units": [
        { "unit_number": "REQUIRED (e.g. 'A','1A')",
          "status": "active|vacant|...",
          "prov": "confirmed|assumed",
          "...include ONLY fields with real values": "bedrooms, bathrooms, room, bed, square_feet, market_rent, actual_rent, lease_start, lease_end, tenant_name, deposit, balance, note",
          "future_events": "OMIT unless scheduled; array of { type, tenant_name, rent, lease_start, lease_end }" }
      ]
    }
  ],
  "comps_seen": 0,    // COUNT of comp properties you recognized and DROPPED (do NOT list them) — proves you saw and excluded them
  "missing": [ "subject-level info a buyer would still need" ],
  "unclear": [ "raw lines you could not confidently route to a subject property" ]
}
RULES FOR SHAPE (B): every subject property MUST have an "address" (identity). Each unit is nested UNDER its property, so a unit number like "A" is unique within its property. In a rent roll, in-place rent -> actual_rent and the asking/market-rate column -> market_rent. Report ONLY subject properties in "subject_properties". Comps are NEVER listed — only COUNTED in "comps_seen". Set "level_reached" to the deepest level reached for the subject (a full per-unit subject rent roll is L4).
Example of ONE slim subject unit: {"unit_number":"A","status":"active","prov":"confirmed","bedrooms":4,"bathrooms":4,"actual_rent":1950,"market_rent":2461,"note":"In-place per bed $488"}

Source material:
"""
${text}
"""`;
}

// ══════════════════════════════════════════════════════════════════════
//  THE PLANNER — plan → targeted extract → merge/reconcile
//
//  The durable path for documents too large for one pass. The architecture,
//  per design: a real-estate document must be UNDERSTOOD before it is
//  extracted. Blind chunking would solve the token problem while creating a
//  worse one — a comp section, a market table, and a subject rent roll all
//  contain addresses, unit counts, and rents; without document-level context
//  a chunk of comps looks just like a chunk of subjects, and the system would
//  promote a stranger's building as a real property.
//
//  So we do NOT split blindly. We:
//    1. PLAN — one small pass reads the whole doc and returns a compact MAP:
//       scope, deal name, stated totals, and the SUBJECT property groups with
//       their verbatim addresses. No unit detail. Tiny even for 200+ units.
//    2. EXTRACT — one pass per batch of subject addresses, each carrying the
//       plan so it knows "these are subjects, everything else here is context."
//       Output per call stays small because each returns only its batch.
//    3. RECONCILE — merge server-side by deal+address+unit, then check the
//       extracted counts against the plan's stated totals. Discrepancies go to
//       review; nothing is silently "fixed", nothing auto-creates, comps never
//       enter the candidate pipeline.
// ══════════════════════════════════════════════════════════════════════

// ── PHASE 1 PROMPT: the document plan (compact map, NO unit detail) ──────
function planPrompt(text) {
  return `You are the planning stage of a real-estate document pipeline. Read the WHOLE document and produce a COMPACT MAP of what it is and where the SUBJECT real estate lives — NOT the unit-level data. A later stage extracts the units; your job is to tell it what matters, what is subject, and what is noise.

CRITICAL DISTINCTION — SUBJECT vs NOISE. A document (especially an offering memorandum) mixes the asset being SOLD (the SUBJECT) with reference material that must NEVER be treated as the asset:
  • SUBJECT: the actual properties offered for sale — listed in the portfolio overview, rent roll, unit-mix, per-address tax table.
  • NOISE: "sale comparables", "lease comparables", "market rent survey", competitive-property tables, broker/lender contacts, university/market commentary, maps, photos. These contain addresses and rents too, but they are OTHER people's buildings or context.
A comp like "2233 N 20th Street, 38 units" is NOISE, not a subject. Identify it well enough to EXCLUDE it.

You MUST list every SUBJECT property address verbatim, because the next stage extracts units only for the addresses you name here. If you miss a subject address, its units are lost. If you wrongly include a comp address, a stranger's building gets promoted. Be exact.

Keep the output SMALL. Do NOT output units, rents, or per-unit rows. Output ONLY the map.

Return ONLY valid JSON, no prose, no fences:
{
  "document_type": "offering_memo | rent_roll | broker_package | unit_mix | pm_report | unknown",
  "detected_system": "broker_om | appfolio | yardi_breeze | yardi_voyager | entrata | student_schedule | seller_handoff | unknown",
  "scope": "single_property | deal_portfolio",
  "deal": {
    "name": "portfolio/deal name (omit if single property)",
    "broker": "omit if none",
    "location": "city, state",
    "asset_type": "student | affordable | multifamily | ...",
    "stated_totals": { "properties": 0, "units": 0, "beds": 0, "offering_price": 0, "noi": 0 }
  },
  "subject_addresses": [ "1414 Diamond Street", "1418 Diamond Street", "..." ],
  "financial_tables_present": [ "tax_summary", "pro_forma_noi", "stabilized_ie", "..." ],
  "comp_sections_present": [ "sale_comparables", "lease_comparables", "market_rent_survey" ],
  "comps_seen": 0,
  "notes": [ "anything the extractor should know — e.g. 'rent schedule spans pages 16-21', 'units labeled like 1F/1R/2F'" ]
}
For a SINGLE property, set scope "single_property", omit "deal", and put the one address in subject_addresses.
"subject_addresses" must contain ONLY subject properties. "comps_seen" is the COUNT of comp/competitive properties you saw and excluded.

Document:
"""
${text}
"""`;
}

// ── PHASE 2 PROMPT: targeted extraction for ONE batch of subject addresses ─
// The plan travels with the call so the model keeps document-level context:
// it knows these addresses are SUBJECTS and that other addresses in the same
// text are comps/noise to ignore.
function extractGroupPrompt(text, plan, addresses) {
  const dealName = (plan.deal && plan.deal.name) || "(single property)";
  return `You are the extraction stage of a real-estate document pipeline. A planning stage has already mapped this document. Your job: extract FULL per-unit detail for ONLY the SUBJECT addresses listed below, using the whole document for context but ignoring everything that is not one of these addresses.

DOCUMENT CONTEXT (from the planner — trust it):
  Deal: ${dealName}
  Document type: ${plan.document_type || "unknown"}
  Detected system: ${plan.detected_system || "unknown"}
  This document also contains comp/market/broker material — that is NOISE. Do NOT extract it.

EXTRACT UNITS ONLY FOR THESE SUBJECT ADDRESSES (extract every one that appears in the text):
${addresses.map(a => "  • " + a).join("\n")}

RULES:
- For each address above, find its units in the rent roll / unit schedule and extract them at the deepest reliable level (unit number, status, beds, baths, sqft, rents, lease dates, tenant).
- A unit number like "A", "1F", "Unit 2" is unique only WITHIN its property — keep each unit under its address.
- In-place/current rent → actual_rent; asking/market/pre-lease rent → market_rent. Vacant units have no actual_rent.
- Status vocabulary → active | vacant | down | employee | model | mtm | non_revenue | unknown. "Occupied"→active, "Available"/"Vacant"→vacant, "Down"→down, "Employee"→employee.
- FORWARD-LOOKING UNITS: a unit can be vacant/occupied TODAY and also have a SCHEDULED future move-in, move-out, or renewal. Do NOT collapse a future fact into status and do NOT emit "future" as a status. If the same unit appears under both a current section and a "Future Residents/Applicants" section, emit it ONCE with the CURRENT fact as its status/rent/tenant and attach the future fact to a "future_events" array. A unit appearing only in a future section is vacant now with a future_event.
- NEVER invent a value. No support → omit the field. Do NOT extract any address that is not in the list above. Do NOT extract comp/market/survey rows.
- Unit numbers are STRINGS — preserve exactly (leading zeros, "1F", "BR").

OUTPUT — keep it SMALL, omit null/empty fields. Return ONLY valid JSON, no prose, no fences:
{
  "properties": [
    {
      "address": "exact subject address from the list",
      "prov": "confirmed|assumed",
      "units": [
        { "unit_number": "REQUIRED", "status": "...", "prov": "confirmed|assumed",
          "...only fields with real values": "bedrooms, bathrooms, square_feet, market_rent, actual_rent, lease_start, lease_end, tenant_name, deposit, balance, note",
          "future_events": "OMIT unless scheduled; array of { type, tenant_name, rent, lease_start, lease_end }" }
      ]
    }
  ],
  "unclear": [ "rows you could not confidently place under one of the listed addresses" ]
}

Document:
"""
${text}
"""`;
}

// ── normalization for merge keys ──────────────────────────────────────
// Addresses must match across the plan and the extraction passes even with
// cosmetic differences ("1414 Diamond Street" vs "1414 W Diamond St"). We
// normalize conservatively: lowercase, collapse whitespace, strip common
// suffixes/directionals to a canonical core. This is for KEY MATCHING only —
// the display address is always the verbatim one from extraction.
function normalizeAddress(addr) {
  if (!addr) return "";
  let s = String(addr).toLowerCase().trim();
  s = s.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  // directional + street-type canonicalization
  const repl = [
    [/\bnorth\b/g, "n"], [/\bsouth\b/g, "s"], [/\beast\b/g, "e"], [/\bwest\b/g, "w"],
    [/\bstreet\b/g, "st"], [/\bavenue\b/g, "ave"], [/\bav\b/g, "ave"],
    [/\bplace\b/g, "pl"], [/\bdrive\b/g, "dr"], [/\bboulevard\b/g, "blvd"],
    [/\broad\b/g, "rd"], [/\bcourt\b/g, "ct"], [/\blane\b/g, "ln"],
  ];
  for (const [re, to] of repl) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}

// LOOSE address key — the fallback when exact normalized keys miss. A document
// can name the same building two ways across sections: the overview says
// "1414 Diamond Street", the rent schedule says "1414 W Diamond St". Exact
// normalization can canonicalize a directional that's PRESENT in both, but it
// can't add a "W" one source omits — so those keys won't match and the
// property looks empty. This key strips directionals and street-types entirely,
// keeping just the house number + the alphabetic street core, so
// "1414 diamond" == "1414 w diamond". Used ONLY as a fallback after an exact
// miss, to avoid collapsing genuinely-different addresses.
function looseAddressKey(addr) {
  if (!addr) return "";
  let s = normalizeAddress(addr);
  // drop leading-or-trailing directionals and common street types
  s = s.replace(/\b(n|s|e|w|ne|nw|se|sw)\b/g, " ");
  s = s.replace(/\b(st|ave|pl|dr|blvd|rd|ct|ln|ter|way|cir|pkwy)\b/g, " ");
  // keep house number + remaining word stems
  s = s.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

// Batch the subject addresses so each extraction call's OUTPUT stays well under
// the token ceiling. Student OMs run ~8 units/property; ~10 properties/batch
// keeps a batch around 80 units of detail — comfortably one-pass sized.
function batchAddresses(addresses, perBatch = 10) {
  const batches = [];
  for (let i = 0; i < addresses.length; i += perBatch) {
    batches.push(addresses.slice(i, i + perBatch));
  }
  return batches;
}

// ── extraction_result: the normalized, read-only middle layer ─────────
// The stable contract between raw model output and the candidate workflow.
//
//   model_raw_output        = raw model transcript (audit/debug)
//   extraction_result       = normalized read-only extraction  ← THIS
//   ready_for_promotion / needs_review = candidate workflow
//   canonical units/leases  = created only on promote
//
// It is built from the SAME parsed model output already in hand — no extra
// model call, no DB write, no candidate touched. It CREATES nothing, maps
// nothing into the database, and does NOT pull forward the promote/mapping
// build. One consistent shape for single property AND deal/portfolio:
//   single  → properties:[ one ], deal:null
//   deal    → properties:[ many ], deal:{…}
// The scorer and (later) the review UI read THIS, never the raw transcript.
//
// Field names mirror what the brain emits TODAY (omit-when-null sparse rows);
// per-unit always carries unit_number + prov. Richer flags from the roadmap
// contract (is_future, is_phantom_bed, charges[]) slot in for free once the
// brain emits them — everything is omit-when-null, so absence breaks nothing.
function buildExtractionResult(parsed, isDeal, subjectProperties) {
  const cleanUnits = (arr) => (Array.isArray(arr) ? arr : []).map(u => {
    // pass through only real values; drop internal staging tags
    const { _property_address, ...rest } = u || {};
    return rest;
  });
  const properties = isDeal
    ? (Array.isArray(subjectProperties) ? subjectProperties : []).map(sp => ({
        address: sp.address ?? sp.name ?? null,
        prov: sp.prov ?? "assumed",
        units: cleanUnits(sp.units),
      }))
    : [{
        address: parsed.property?.address ?? null,
        prov: parsed.property ? "confirmed" : "assumed",
        units: cleanUnits(parsed.units),
      }];
  return {
    scope: isDeal ? "deal_portfolio" : "single_property",
    document_type: parsed.document_type ?? "unknown",
    detected_system: parsed.detected_system ?? "unknown",
    level_reached: parsed.level_reached ?? "none",
    snapshot_date: parsed.snapshot_date ?? null,
    deal: isDeal ? (parsed.deal ?? null) : null,
    properties,
    unit_mix: Array.isArray(parsed.unit_mix) ? parsed.unit_mix : [],
    comps_seen: isDeal ? (Number.isFinite(parsed.comps_seen) ? parsed.comps_seen : 0) : null,
    missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    unclear: Array.isArray(parsed.unclear) ? parsed.unclear : [],
  };
}

// ── SHARED COLLAPSE PIPELINE ──────────────────────────────────────────
// Preserves the proven staged flow. The levelled extraction is returned in
// full; the unit slice persists into ingest_candidates exactly as before.
async function runIngest(propertyId, sourceText, kind) {
  // Output ceiling. The 16k we shipped with was a conservative floor, not the
  // model's real limit — Sonnet can return far more. We push it to a high
  // practical ceiling so large OMs (150+ units, full L4 detail) clear in one
  // pass. MAX_INGEST_TOKENS lets us tune on Render without a code change.
  // This is the BRIDGE: one-pass handles most docs; the planner (plan ->
  // targeted extract -> reconcile) is the durable path for anything bigger.
  const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_INGEST_TOKENS, 10) || 64000;
  const ai = await anthropic.messages.create({
    model: INGEST_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: "user", content: ingestPrompt(sourceText) }],
  });

  const rawOutput = (ai.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();

  // TRUNCATION DETECTION — the honest failure. If the model hit the output
  // ceiling, stop_reason is "max_tokens" and the JSON is cut off mid-token.
  // Rather than a cryptic parse error, say plainly that the document outgrew
  // one-pass extraction and needs the planner. This is what makes the bridge
  // a bridge and not a trap: the system KNOWS when it has outgrown one pass.
  if (ai.stop_reason === "max_tokens") {
    const err = new Error(
      "This document is too large for single-pass extraction — the response hit the output ceiling and was cut off. " +
      "It needs the document-planning pipeline (plan → targeted subject extraction → reconcile), which isn't built yet. " +
      "Smaller files and most single/medium portfolios still ingest in one pass."
    );
    err.raw = rawOutput;
    err.truncated = true;
    throw err;
  }

  let raw = rawOutput.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    // A parse failure with no max_tokens stop is a genuinely malformed
    // response, not a size problem — keep it distinct from truncation.
    const err = new Error("AI returned unparseable output (not a size limit — the response was malformed).");
    err.raw = rawOutput;
    err.unparseable = true;
    throw err;
  }

  const unclear = Array.isArray(parsed.unclear) ? parsed.unclear : [];
  const missing = Array.isArray(parsed.missing) ? parsed.missing : [];

  // ── Decide the shape. A deal/portfolio nests units under subject_properties;
  //    a single property returns a flat units[]. We FLATTEN subject units into
  //    the SAME candidate pipeline so approve/promote is unchanged — but we
  //    stamp each candidate with its property address so a unit number like "A"
  //    stays traceable to its building. COMPS are never here: the brain dropped
  //    them upstream and only COUNTED them in comps_seen.
  const isDeal = parsed.scope === "deal_portfolio" || Array.isArray(parsed.subject_properties);
  const subjectProperties = Array.isArray(parsed.subject_properties) ? parsed.subject_properties : [];

  // stagingUnits = the flat list that becomes candidates. Each carries an
  // optional _property_address (deal case) for the candidate note.
  let stagingUnits = [];
  if (isDeal) {
    for (const sp of subjectProperties) {
      const addr = sp.address || sp.name || null;
      const us = Array.isArray(sp.units) ? sp.units : [];
      for (const u of us) stagingUnits.push({ ...u, _property_address: addr });
    }
  } else {
    stagingUnits = Array.isArray(parsed.units) ? parsed.units : [];
  }

  const unitMix = Array.isArray(parsed.unit_mix) ? parsed.unit_mix : [];

  // Persist the run — verbatim input, raw model output, model id (provenance anchor).
  // candidate_count counts the SUBJECT units staged (comps excluded by design).
  const runRes = await pool.query(
    `insert into ingest_runs
       (property_id, kind, source_text, model_id, model_raw_output, candidate_count, unclear)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [propertyId, kind, sourceText, INGEST_MODEL, rawOutput, stagingUnits.length, unclear]
  );
  const run = runRes.rows[0];

  // Stage every SUBJECT unit as a candidate — SAME columns, SAME decision semantics.
  // market_rent persisted = actual_rent if present, else market_rent (so a rent
  // roll keeps in-place rent and an OM keeps asking rent — one column, correct
  // value). In a deal, the property address is prepended to the note so the
  // reviewer can see which building each "A"/"1A" belongs to. The richer graph
  // rides along in model_raw_output until a later migration gives it tables.
  const candidates = [];
  for (const u of stagingUnits) {
    const hasNumber = !!u.unit_number;
    const prov = (u.prov === "confirmed" && hasNumber) ? "confirmed" : "assumed";
    const decision = (prov === "confirmed") ? "ready_for_promotion" : "pending";
    const addrTag = u._property_address ? `[${u._property_address}] ` : "";
    const baseNote = !hasNumber ? "no unit number" : (u.note || null);
    const note = (addrTag && baseNote) ? addrTag + baseNote : (addrTag ? addrTag.trim() : baseNote);
    const rentToStore = (u.actual_rent != null) ? u.actual_rent : (u.market_rent ?? null);
    const c = await pool.query(
      `insert into ingest_candidates
         (run_id, property_id, unit_number, bedrooms, market_rent, prov, ai_note, decision_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [run.id, propertyId, hasNumber ? String(u.unit_number) : null,
       u.bedrooms ?? null, rentToStore, prov, note, decision]
    );
    candidates.push(c.rows[0]);
  }

  // ── One clean human-facing summary line, scope-aware. ──
  const compsSeen = Number.isFinite(parsed.comps_seen) ? parsed.comps_seen : 0;
  let summary;
  if (isDeal) {
    const propWord = subjectProperties.length === 1 ? "subject property" : "subject properties";
    summary = `I found one portfolio with ${subjectProperties.length} ${propWord} and ${candidates.length} subject units. These are the only items staged for review.`
      + (compsSeen ? ` (${compsSeen} comparable propertie${compsSeen === 1 ? "" : "s"} were recognized and ignored.)` : "");
  } else {
    summary = `Single property. ${candidates.length} unit${candidates.length === 1 ? "" : "s"} staged for review.`;
  }

  // ── IDENTITY: resolve each property string against the registry ──────
  // Option 1 product behavior: upload → resolve → attach if resolved, flag if
  // ambiguous, auto-register as unresolved if unknown. NEVER guesses. Uses the
  // ONE shared identity path (registryInstance.resolveOrRegister). Read-time,
  // additive: this does not change what gets staged, only reports identity.
  let registryResults = [];
  try {
    const addrs = isDeal
      ? subjectProperties.map(sp => sp.address).filter(Boolean)
      : [parsed.property && parsed.property.address].filter(Boolean);
    for (const address of addrs) {
      const rr = await registryInstance.resolveOrRegister(pool, {
        source: kind === "rent_roll" ? "rent_roll" : "other",
        value: address, alias_type: "address_string",
      });
      registryResults.push(rr);
    }
  } catch (e) {
    registryResults = [{ status: "error", error: e.message }];
  }

  // ── #4: reconcile the ROUTE property against what the FILE actually says ──
  // The upload came in under /properties/:propertyId/ingest — a property the
  // USER picked. The registry resolves what's IN THE FILE. If they disagree,
  // the response must SAY SO. The route property does NOT silently win — that
  // would recreate the lie that the user already knew the right property.
  let routeIdentityCheck = { route_property_id: propertyId, status: "unknown" };
  try {
    const resolvedIds = registryResults.filter(r => r.status === "resolved").map(r => r.property_id);
    if (registryResults.some(r => r.status === "ambiguous")) {
      routeIdentityCheck = { route_property_id: propertyId, status: "ambiguous_in_file",
        note: "The file's property is ambiguous in the registry. Route property is NOT confirmed as correct — resolve the alias before trusting attachment." };
    } else if (resolvedIds.length === 0) {
      routeIdentityCheck = { route_property_id: propertyId, status: "no_resolved_identity",
        note: "Nothing in the file resolved to a canonical property. Route property is the user's assertion only — unconfirmed by the file." };
    } else if (resolvedIds.every(id => id === propertyId)) {
      routeIdentityCheck = { route_property_id: propertyId, status: "match",
        note: "The file's resolved property matches the route property. Confirmed." };
    } else {
      routeIdentityCheck = { route_property_id: propertyId, status: "CONFLICT",
        resolved_in_file: [...new Set(resolvedIds)],
        note: "WARNING: the file resolves to a DIFFERENT property than the route. The route property is NOT applied as truth. A human must reconcile — this is exactly the identity lie the registry exists to prevent." };
    }
  } catch (e) {
    routeIdentityCheck = { route_property_id: propertyId, status: "error", error: e.message };
  }

  return {
    run_id: run.id,
    document_type: parsed.document_type || "unknown",
    detected_system: parsed.detected_system || "unknown",
    scope: isDeal ? "deal_portfolio" : "single_property",
    level_reached: parsed.level_reached || "none",
    snapshot_date: parsed.snapshot_date || null,
    summary,
    // single-property fields (null in a deal)
    property: isDeal ? null : (parsed.property || null),
    unit_mix: unitMix,
    // deal fields (null in a single property) — returned now, persisted later
    deal: isDeal ? (parsed.deal || null) : null,
    subject_property_count: isDeal ? subjectProperties.length : null,
    subject_properties: isDeal ? subjectProperties : null,  // full graph (units nested)
    comps_seen: isDeal ? compsSeen : null,
    // ── the normalized read-only contract layer (single + deal share one shape) ──
    extraction_result: buildExtractionResult(parsed, isDeal, subjectProperties),
    candidate_count: candidates.length,
    ready_for_promotion: candidates.filter(c => c.decision_status === "ready_for_promotion"),
    needs_review: candidates.filter(c => c.decision_status === "pending"),
    missing,
    unclear,
    registry: registryResults,  // identity resolution per subject property (resolved | ambiguous | registered_unresolved | skipped)
    registry_route_check: routeIdentityCheck,  // #4: does the file agree with the route property? match | CONFLICT | ambiguous_in_file | no_resolved_identity
    note: "Subject assets only. Comps are recognized and dropped — never staged. Nothing written to units yet. AI-confident rows are 'ready_for_promotion'; a human approves (POST /ingest/:runId/approve), then POST /ingest/:runId/promote creates units. extraction_result is the normalized read-only view — it persists nothing.",
  };
}

// ══════════════════════════════════════════════════════════════════════
//  PLANNER ORCHESTRATION — plan → targeted extract → merge/reconcile
//
//  Used when one-pass truncates (or when forced). Same staged output contract
//  as runIngest so the review/approve/promote flow downstream is unchanged.
//  Output-only: nothing auto-writes to units; comps never become candidates;
//  reconciliation surfaces discrepancies for review rather than fixing them.
// ══════════════════════════════════════════════════════════════════════

// small helper: call the model, strip fences, parse, with truncation awareness
async function callModelJSON(prompt, maxTokens, label) {
  const ai = await anthropic.messages.create({
    model: INGEST_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const rawOutput = (ai.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (ai.stop_reason === "max_tokens") {
    const hint = label === "Extract"
      ? " A single extraction batch was too large — lower PLAN_PER_BATCH (env var) so fewer properties are extracted per pass."
      : "";
    const err = new Error(`${label} stage hit the output ceiling — batch too large.${hint}`);
    err.raw = rawOutput; err.truncated = true; err.stage = label;
    throw err;
  }
  const cleaned = rawOutput.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try { return { parsed: JSON.parse(cleaned), raw: rawOutput }; }
  catch {
    const err = new Error(`${label} stage returned unparseable JSON.`);
    err.raw = rawOutput; err.unparseable = true; err.stage = label;
    throw err;
  }
}

async function runIngestPlanned(propertyId, sourceText, kind) {
  const PLAN_TOKENS    = parseInt(process.env.PLAN_TOKENS, 10)    || 8000;   // the map is small
  const EXTRACT_TOKENS = parseInt(process.env.EXTRACT_TOKENS, 10) || 32000;  // one batch of units
  const PER_BATCH      = parseInt(process.env.PLAN_PER_BATCH, 10) || 10;     // subject addresses per extract call

  // ── PHASE 1: PLAN ──
  const { parsed: plan, raw: planRaw } = await callModelJSON(planPrompt(sourceText), PLAN_TOKENS, "Plan");
  const subjectAddresses = Array.isArray(plan.subject_addresses) ? plan.subject_addresses.filter(Boolean) : [];
  const isDeal = plan.scope === "deal_portfolio" || subjectAddresses.length > 1;

  if (subjectAddresses.length === 0) {
    const err = new Error("Planner found no subject addresses in this document.");
    err.raw = planRaw; err.unparseable = true; throw err;
  }

  // ── PHASE 2: TARGETED EXTRACTION, batch by batch ──
  const batches = batchAddresses(subjectAddresses, PER_BATCH);
  const extractedByAddr = new Map();   // exact normalized key -> { address, prov, units }
  const extractedByLoose = new Map();  // loose key -> same object (directional-tolerant fallback)
  const extractRawOutputs = [];
  const allUnclear = [];

  for (const batch of batches) {
    const { parsed: ex, raw } = await callModelJSON(extractGroupPrompt(sourceText, plan, batch), EXTRACT_TOKENS, "Extract");
    extractRawOutputs.push(raw);
    if (Array.isArray(ex.unclear)) allUnclear.push(...ex.unclear);
    const props = Array.isArray(ex.properties) ? ex.properties : [];
    for (const p of props) {
      if (!p.address) continue;
      const key = normalizeAddress(p.address);
      const loose = looseAddressKey(p.address);
      const units = Array.isArray(p.units) ? p.units : [];
      if (extractedByAddr.has(key)) {
        // merge: same property surfaced in two batches (shouldn't happen, but safe)
        const existing = extractedByAddr.get(key);
        const seen = new Set(existing.units.map(u => String(u.unit_number)));
        for (const u of units) if (!seen.has(String(u.unit_number))) existing.units.push(u);
      } else {
        const rec = { address: p.address, prov: p.prov || "confirmed", units };
        extractedByAddr.set(key, rec);
        if (loose && !extractedByLoose.has(loose)) extractedByLoose.set(loose, rec);
      }
    }
  }

  // ── Build the subject_properties graph (same shape runIngest returns) ──
  // Match each planned subject to its extracted units: try the EXACT normalized
  // key first; on a miss, fall back to the directional-tolerant LOOSE key so a
  // "1414 Diamond Street" plan still finds "1414 W Diamond St" units. Only when
  // both miss is the property truly empty (and reconciliation will flag it).
  const subjectProperties = [];
  const matchedKeys = new Set();
  for (const addr of subjectAddresses) {
    const key = normalizeAddress(addr);
    const loose = looseAddressKey(addr);
    let hit = extractedByAddr.get(key);
    let how = hit ? "exact" : null;
    if (!hit && extractedByLoose.has(loose)) { hit = extractedByLoose.get(loose); how = "loose"; }
    if (hit) {
      matchedKeys.add(normalizeAddress(hit.address));
      // keep the PLANNED address as display identity (page-7 overview spelling),
      // but note when units were matched by the looser key for transparency.
      subjectProperties.push({
        address: addr,
        prov: hit.prov,
        units: hit.units,
        ...(how === "loose" ? { _matched_via: `loose key (extracted as "${hit.address}")` } : {}),
      });
    } else {
      subjectProperties.push({ address: addr, prov: "assumed", units: [], _note: "planned subject but no units extracted" });
    }
  }

  // Any extracted property that never matched a planned subject — surface it,
  // don't silently drop it. Could be a spelling the planner didn't list, or a
  // comp the extractor shouldn't have returned. Either way it's a review signal.
  const orphanExtracted = [];
  for (const [key, rec] of extractedByAddr.entries()) {
    if (!matchedKeys.has(key)) orphanExtracted.push(rec.address);
  }

  // ── Flatten subject units into staging (identical semantics to runIngest) ──
  const stagingUnits = [];
  for (const sp of subjectProperties) {
    for (const u of (sp.units || [])) stagingUnits.push({ ...u, _property_address: sp.address });
  }

  // ── PHASE 3: RECONCILE against the plan's stated totals ──
  const stated = (plan.deal && plan.deal.stated_totals) || {};
  const extractedPropCount = subjectProperties.filter(p => (p.units || []).length > 0).length;
  const plannedPropCount = subjectAddresses.length;
  const extractedUnitCount = stagingUnits.length;
  const emptyProps = subjectProperties.filter(p => (p.units || []).length === 0).map(p => p.address);

  const reconciliation = {
    planned_subject_properties: plannedPropCount,
    extracted_properties_with_units: extractedPropCount,
    extracted_units: extractedUnitCount,
    stated_properties: stated.properties ?? null,
    stated_units: stated.units ?? null,
    stated_beds: stated.beds ?? null,
    orphan_extracted_properties: orphanExtracted,
    flags: [],
  };
  if (stated.properties != null && stated.properties !== plannedPropCount)
    reconciliation.flags.push(`Stated ${stated.properties} properties but planner mapped ${plannedPropCount} subject addresses.`);
  if (stated.units != null && stated.units !== extractedUnitCount)
    reconciliation.flags.push(`Stated ${stated.units} units but extracted ${extractedUnitCount}.`);
  if (emptyProps.length)
    reconciliation.flags.push(`${emptyProps.length} planned propert${emptyProps.length === 1 ? "y" : "ies"} returned no units: ${emptyProps.slice(0, 8).join(", ")}${emptyProps.length > 8 ? "…" : ""}.`);
  if (orphanExtracted.length)
    reconciliation.flags.push(`${orphanExtracted.length} extracted propert${orphanExtracted.length === 1 ? "y" : "ies"} did not match any planned subject: ${orphanExtracted.slice(0, 8).join(", ")}${orphanExtracted.length > 8 ? "…" : ""}.`);

  // ── Persist the run. We write the SAME kind value the one-pass path uses
  //    (known-good against the live table) rather than a new "_planned" variant
  //    that could trip a CHECK/enum constraint the repo can't see. The planned/
  //    multi-pass fact is recorded inside model_raw_output (mode:"planned"),
  //    which is free-form text — so the distinction is preserved without
  //    risking the insert. plan + all extract passes are stored for full
  //    provenance of a multi-call ingest. ──
  const combinedRaw = JSON.stringify({ mode: "planned", plan: planRaw, extracts: extractRawOutputs }, null, 0);
  const runRes = await pool.query(
    `insert into ingest_runs
       (property_id, kind, source_text, model_id, model_raw_output, candidate_count, unclear)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [propertyId, kind, sourceText, INGEST_MODEL, combinedRaw, stagingUnits.length, allUnclear]
  );
  const run = runRes.rows[0];

  // ── Stage subject units as candidates — SAME columns/semantics as runIngest ──
  const candidates = [];
  for (const u of stagingUnits) {
    const hasNumber = !!u.unit_number;
    const prov = (u.prov === "confirmed" && hasNumber) ? "confirmed" : "assumed";
    const decision = (prov === "confirmed") ? "ready_for_promotion" : "pending";
    const addrTag = u._property_address ? `[${u._property_address}] ` : "";
    const baseNote = !hasNumber ? "no unit number" : (u.note || null);
    const note = (addrTag && baseNote) ? addrTag + baseNote : (addrTag ? addrTag.trim() : baseNote);
    const rentToStore = (u.actual_rent != null) ? u.actual_rent : (u.market_rent ?? null);
    const c = await pool.query(
      `insert into ingest_candidates
         (run_id, property_id, unit_number, bedrooms, market_rent, prov, ai_note, decision_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [run.id, propertyId, hasNumber ? String(u.unit_number) : null,
       u.bedrooms ?? null, rentToStore, prov, note, decision]
    );
    candidates.push(c.rows[0]);
  }

  const compsSeen = Number.isFinite(plan.comps_seen) ? plan.comps_seen : 0;
  const propWord = subjectProperties.length === 1 ? "subject property" : "subject properties";
  let summary = `Planned ingest: ${subjectProperties.length} ${propWord}, ${candidates.length} subject units staged across ${batches.length} extraction pass${batches.length === 1 ? "" : "es"}.`;
  if (compsSeen) summary += ` (${compsSeen} comparable propert${compsSeen === 1 ? "y" : "ies"} recognized and ignored.)`;
  if (reconciliation.flags.length) summary += ` ${reconciliation.flags.length} reconciliation flag${reconciliation.flags.length === 1 ? "" : "s"} for review.`;

  // ── INFER the real level reached — do NOT claim L4 unless lease-level detail
  //    was actually extracted. L4 = per-unit lease/tenant detail present;
  //    L3 = per-unit rows with attributes but no lease detail; L2 = unit counts
  //    only (none here, since we extract rows); L1 = addresses but no units.
  //    Overstating the level overstates confidence the data doesn't support.
  const hasLeaseDetail = stagingUnits.some(u =>
    u.tenant_name || u.lease_start || u.lease_end || u.deposit != null || u.balance != null);
  const hasUnitDetail = stagingUnits.some(u =>
    u.bedrooms != null || u.bathrooms != null || u.square_feet != null ||
    u.market_rent != null || u.actual_rent != null);
  const levelReached =
    stagingUnits.length === 0 ? "L1" :
    hasLeaseDetail ? "L4" :
    hasUnitDetail ? "L3" : "L2";

  // ── IDENTITY: resolve each subject property against the registry ─────
  // Same shared path as runIngest. Planned ingest is always the deal/multi
  // shape, so resolve every subject address. Never guesses; flags ambiguous.
  let registryResults = [];
  try {
    for (const address of subjectProperties.map(sp => sp.address).filter(Boolean)) {
      const rr = await registryInstance.resolveOrRegister(pool, {
        source: kind === "rent_roll" ? "rent_roll" : "other",
        value: address, alias_type: "address_string",
      });
      registryResults.push(rr);
    }
  } catch (e) {
    registryResults = [{ status: "error", error: e.message }];
  }

  // ── #4: reconcile ROUTE property vs what the FILE says (same as runIngest) ──
  let routeIdentityCheck = { route_property_id: propertyId, status: "unknown" };
  try {
    const resolvedIds = registryResults.filter(r => r.status === "resolved").map(r => r.property_id);
    if (registryResults.some(r => r.status === "ambiguous")) {
      routeIdentityCheck = { route_property_id: propertyId, status: "ambiguous_in_file",
        note: "The file's property is ambiguous in the registry. Route property NOT confirmed." };
    } else if (resolvedIds.length === 0) {
      routeIdentityCheck = { route_property_id: propertyId, status: "no_resolved_identity",
        note: "Nothing in the file resolved to a canonical property. Route property is the user's assertion only." };
    } else if (resolvedIds.every(id => id === propertyId)) {
      routeIdentityCheck = { route_property_id: propertyId, status: "match", note: "File resolved property matches the route property." };
    } else {
      routeIdentityCheck = { route_property_id: propertyId, status: "CONFLICT",
        resolved_in_file: [...new Set(resolvedIds)],
        note: "WARNING: file resolves to a DIFFERENT property than the route. Route property NOT applied as truth; human must reconcile." };
    }
  } catch (e) {
    routeIdentityCheck = { route_property_id: propertyId, status: "error", error: e.message };
  }

  return {
    run_id: run.id,
    mode: "planned",
    document_type: plan.document_type || "unknown",
    detected_system: plan.detected_system || "unknown",
    scope: isDeal ? "deal_portfolio" : "single_property",
    level_reached: levelReached,
    summary,
    property: isDeal ? null : (subjectProperties[0] || null),
    deal: isDeal ? (plan.deal || null) : null,
    subject_property_count: subjectProperties.length,
    subject_properties: subjectProperties,
    comps_seen: compsSeen,
    // ── normalized read-only contract layer — same shape as the one-pass path.
    //    Sourced from the planner's own subjectProperties graph (units nested)
    //    plus the plan's doc-level facts. Read-only; persists nothing. ──
    extraction_result: buildExtractionResult(
      { document_type: plan.document_type, detected_system: plan.detected_system,
        level_reached: levelReached, snapshot_date: plan.snapshot_date || null,
        deal: plan.deal || null, comps_seen: compsSeen,
        unit_mix: [], missing: [], unclear: allUnclear },
      isDeal, subjectProperties
    ),
    candidate_count: candidates.length,
    ready_for_promotion: candidates.filter(c => c.decision_status === "ready_for_promotion"),
    needs_review: candidates.filter(c => c.decision_status === "pending"),
    reconciliation,
    unclear: allUnclear,
    note: "Planned (multi-pass) ingest. Plan → targeted subject extraction → merge/reconcile. Subject assets only; comps never staged; nothing written to units yet. Reconciliation flags are for human review — they do not auto-resolve. NOTE: portfolio (multi-property) promotion is currently BLOCKED — staging and review work, but /promote refuses portfolios until per-subject-property mapping exists. Single-property runs promote normally.",
    registry: registryResults,  // identity resolution per subject property (resolved | ambiguous | registered_unresolved | skipped)
    registry_route_check: routeIdentityCheck,  // #4: file-vs-route identity reconciliation
  };
}

// ── ROUTER: one-pass first; fall through to the planner on truncation ──
// This is the hybrid. Small/medium docs ride the proven single-pass path.
// When a doc is too large and one-pass truncates, we automatically switch to
// plan → targeted extract → reconcile instead of failing. The user drops one
// file; the system decides how to handle it. INGEST_FORCE_PLANNER=1 forces the
// planner for testing.
async function runIngestAuto(propertyId, sourceText, kind) {
  if (process.env.INGEST_FORCE_PLANNER === "1") {
    return await runIngestPlanned(propertyId, sourceText, kind);
  }
  try {
    return await runIngest(propertyId, sourceText, kind);
  } catch (e) {
    if (e.truncated) {
      // one-pass outgrew the ceiling → durable path
      return await runIngestPlanned(propertyId, sourceText, kind);
    }
    throw e;
  }
}

// ── FILE → TEXT: read any supported file type into plain text ─────────
// Excel/CSV via SheetJS, PDF via pdf-parse, Word via mammoth, plain text as-is.
// All flow into the SAME runIngest pipeline — turning a file into text is the
// only thing that differs by type.
async function fileToText(file) {
  const name = (file.originalname || "").toLowerCase();
  const buf = file.buffer;

  // Excel / CSV
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) {
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    let flat = "";
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, raw: false });
      flat += `### SHEET: ${sheetName}\n`;
      for (const row of rows) {
        const line = (row || []).map(c => (c == null ? "" : String(c))).join("\t").trim();
        if (line) flat += line + "\n";
      }
      flat += "\n";
    }
    return flat;
  }

  // PDF (text-based; scanned/handwritten OCR is a later layer)
  if (name.endsWith(".pdf")) {
    // Import the inner library directly. The package's index.js runs a debug
    // block on require that reads a sample file off disk — absent on Render,
    // it throws and 500s the request. The lib module skips that block.
    const pdfParse = require("pdf-parse/lib/pdf-parse.js");
    const data = await pdfParse(buf);
    return data.text || "";
  }

  // Word
  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value || "";
  }

  // Plain text / unknown — try utf-8
  return buf.toString("utf8");
}
  return { INGEST_MODEL, runIngest, runIngestPlanned, runIngestAuto, fileToText, callModelJSON, ingestPrompt, planPrompt, extractGroupPrompt };
}