// ════════════════════════════════════════════════════════════════════
//  date_column.js — HOW A POSTGRES `date` COLUMN BECOMES A DATE STRING.
//
//  One module owns this answer, the way database_ssl.js owns the SSL
//  answer, because getting it wrong produces a value that is WRONG BY A
//  DAY and looks completely ordinary. A lender reading a lease start of
//  2026-07-31 has no way to tell it from a recorded 2026-07-31.
//
//  ── THE RULE ──────────────────────────────────────────────────────
//  node-postgres decodes a `date` column to LOCAL midnight (no global
//  type parser is configured, deliberately — one would change how every
//  date in the process is decoded, for every consumer). So for a `date`
//  column the LOCAL calendar components ARE the recorded date, and
//  `toISOString()` reads that instant back in UTC:
//
//      TZ=UTC               new Date(2026, 7, 1) → "2026-08-01"  ✓
//      TZ=Europe/Berlin     ...toISOString()     → "2026-07-31"  ✗
//      TZ=Pacific/Auckland  ...toISOString()     → "2026-07-31"  ✗
//
//  Every zone AHEAD of UTC loses a day. Zones behind it do not, which is
//  exactly why this survives: CI and the deployed host both run UTC, so
//  nothing observed has ever been wrong. The defect is latent, and a
//  latent off-by-one on a lender's lease dates is not a thing to leave
//  armed until someone moves a host or runs a proof on a laptop.
//
//  ⚠ THIS IS THE OPPOSITE OF THE RULE FOR A TIMESTAMP. For a
//  `timestamptz` the instant is real and UTC components are meaningful.
//  For a `date` there is no time and no zone to convert between — only
//  calendar components, which is why the conversion must not happen. The
//  comment this replaces asserted the reverse, in good faith, and would
//  have misled the next reader.
//
//  Where the database can answer instead, ASK IT: `to_char(d, 'YYYY-MM-DD')`
//  in the query is stronger than any rendering here, because it never
//  builds a Date at all. See openingTruth in src/tenancy/dated_positions.js.
//
//  CLASS 1 — permanent. Removed only if a global pg date parser is
//  adopted, which would be its own decision with its own proof.
// ════════════════════════════════════════════════════════════════════
"use strict";

//  The calendar components of a Date, as the local clock reads them.
function localYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/*  A `date` column value → "YYYY-MM-DD", or null when there is nothing to
 *  render. Accepts what node-pg actually hands back (a Date), what a
 *  to_char'd query hands back (an ISO-prefixed string), and anything else
 *  parseable — never inventing a date for a value it cannot read.  */
function dateColumnToIso(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : localYmd(v);
  const s = String(v);
  //  Already a date string: slice it. Parsing would be a round trip
  //  through a Date for no gain and one more chance to shift a day.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : localYmd(d);
}

//  Same answer, empty string instead of null — for surfaces whose columns
//  render a blank cell rather than a missing key.
function dateColumnToIsoOrBlank(v) {
  const out = dateColumnToIso(v);
  return out == null ? "" : out;
}

module.exports = { dateColumnToIso, dateColumnToIsoOrBlank, localYmd };
