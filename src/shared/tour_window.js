// ════════════════════════════════════════════════════════════════════
//  tour_window.js — the tours-board WINDOW CONTRACT.
//
//  WHY THIS EXISTS AS ITS OWN MODULE
//  ---------------------------------
//  The board used to be able to say only "today, and optionally N days
//  forward" — the offset was clamped with Math.max(days, 0), so the past
//  was not expressible in the contract at all. No UI could page backward
//  no matter how it was written.
//
//  Two things live here, and they live together on purpose:
//    1. resolveTourWindow() — the pure decision: which days is the caller
//       asking for, and is the request honest?
//    2. windowPredicate() / statusPredicate() — the SQL fragments that
//       enforce that decision.
//
//  The route and its harness both build their SQL from these generators,
//  so the harness exercises the REAL predicate rather than a copy that
//  can drift. A test asserting against a re-typed WHERE clause proves
//  only that someone can type.
//
//  WHAT THE BROWSER MAY AND MAY NOT DO
//  -----------------------------------
//  The caller sends OFFSETS, never dates. "Two days before your today"
//  is a request; what "today" means is resolved server-side in the
//  property's operating timezone. A client-supplied date would make the
//  browser the authority on the property's operating day — the same
//  class of violation as a client-supplied property id.
//
//  CLASS 1 — permanent product primitive. The board's day contract does
//  not retire with any fixture or demo path.
// ════════════════════════════════════════════════════════════════════
"use strict";

// A tour is LIVE while its outcome is still owed, TERMINAL once its
// outcome is recorded. Terminal tours leave the capture-candidate set —
// but they are still what happened on that day, so a backward-looking
// window that hides them describes the day dishonestly.
const LIVE_STATUSES = ["scheduled", "confirmed_by_prospect", "checked_in"];
const TERMINAL_STATUSES = ["completed", "no_show", "cancelled", "rescheduled"];

// Bounds. MAX_OFFSET keeps either edge from becoming an unbounded scan;
// MAX_SPAN bounds the query itself. Both are deliberate ceilings, not
// guesses about what an operator wants to see.
const MAX_OFFSET = 30;
const MAX_SPAN = 30; // inclusive span of 31 days

const clampOffset = (n) => Math.min(Math.max(n, -MAX_OFFSET), MAX_OFFSET);

function intOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function truthy(v) {
  if (v === true) return true;
  if (v === undefined || v === null) return false;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

// ── THE DECISION ─────────────────────────────────────────────────────
//  Returns { fromOffset, toOffset, includeTerminal, mode } or { error }.
//
//  PRECEDENCE — stated, not implied: if either `from` or `to` is present
//  the caller is in window mode and `days` is ignored entirely. Absent
//  both, the legacy `days` contract applies unchanged, so every existing
//  caller (which sends nothing at all) resolves to today-only exactly as
//  before. That backward compatibility is asserted in the harness, not
//  assumed here.
//
//  Dishonest requests FAIL rather than being silently reinterpreted. A
//  reversed window is a caller bug; swapping it would hide the bug and
//  return data the caller did not ask for.
function resolveTourWindow(query) {
  const q = query || {};
  const rawFrom = intOrNull(q.from);
  const rawTo = intOrNull(q.to);
  const includeTerminal = truthy(q.include_terminal);

  if (rawFrom === null && rawTo === null) {
    const days = intOrNull(q.days);
    const span = days === null ? 0 : Math.min(Math.max(days, 0), MAX_OFFSET);
    return { fromOffset: 0, toOffset: span, includeTerminal, mode: "legacy_days" };
  }

  // Either edge alone anchors against today: from=-1 means yesterday
  // through today; to=6 means today through six days out.
  const fromOffset = clampOffset(rawFrom === null ? 0 : rawFrom);
  const toOffset = clampOffset(rawTo === null ? 0 : rawTo);

  if (fromOffset > toOffset) {
    return {
      error: {
        code: "TOUR_WINDOW_REVERSED",
        receipt: `The window starts after it ends (from=${fromOffset}, to=${toOffset}). Nothing was read.`,
      },
    };
  }
  if (toOffset - fromOffset > MAX_SPAN) {
    return {
      error: {
        code: "TOUR_WINDOW_TOO_WIDE",
        receipt: `That window covers ${toOffset - fromOffset + 1} days; the board reads at most ${MAX_SPAN + 1}. Nothing was read.`,
      },
    };
  }
  return { fromOffset, toOffset, includeTerminal, mode: "window" };
}

// ── THE SQL ──────────────────────────────────────────────────────────
//  Generators rather than constants so the same clause can be dropped
//  into queries with different parameter numbering. `tourAlias` is the
//  table alias the caller uses for leasing_tours.

//  Day membership is decided on the tour's OPERATING DATE — its
//  scheduled_for rendered into the property's timezone — never on a UTC
//  date. A tour at 8pm Eastern is 00:00 UTC the following day; deciding
//  membership in UTC puts it on the wrong day of the board.
function windowPredicate(tzParam, fromParam, toParam, tourAlias = "t") {
  return `(${tourAlias}.scheduled_for at time zone ${tzParam})::date
            between ((now() at time zone ${tzParam})::date + (${fromParam})::int)
                and ((now() at time zone ${tzParam})::date + (${toParam})::int)`;
}

//  When includeTerminal is true the status filter drops away entirely —
//  the row still carries is_terminal so the caller can tell the two
//  apart without re-deriving the rule.
function statusPredicate(includeTerminalParam, tourAlias = "t") {
  const live = LIVE_STATUSES.map((s) => `'${s}'`).join(",");
  return `(${includeTerminalParam}::boolean or ${tourAlias}.status in (${live}))`;
}

function operatingDateExpr(tzParam, tourAlias = "t") {
  return `(${tourAlias}.scheduled_for at time zone ${tzParam})::date`;
}

function isTerminalExpr(tourAlias = "t") {
  const terminal = TERMINAL_STATUSES.map((s) => `'${s}'`).join(",");
  return `(${tourAlias}.status in (${terminal}))`;
}

module.exports = {
  LIVE_STATUSES,
  TERMINAL_STATUSES,
  MAX_OFFSET,
  MAX_SPAN,
  resolveTourWindow,
  windowPredicate,
  statusPredicate,
  operatingDateExpr,
  isTerminalExpr,
};
