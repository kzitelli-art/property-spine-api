// ════════════════════════════════════════════════════════════════════
//  database_ssl.js — ONE ANSWER TO "DOES THIS CONNECTION USE SSL?"
//
//  SSL IS ON EVERYWHERE EXCEPT A LOCAL HOST. That is correct for every
//  deployed environment and wrong for exactly one case: a Postgres that
//  does not speak SSL at all, which answers a client asking for it with
//  "The server does not support SSL connections" and nothing else.
//
//  ── WHY THIS IS A MODULE AND NOT A LINE ──────────────────────────────
//  It was a private function inside server.js, discovered when CI's
//  postgres:16 container refused the server's first query. This machine's
//  Postgres has `ssl = on`; the container's does not — so the distinction
//  is invisible locally and fatal in CI, every time, in whatever file
//  forgets it.
//
//  It then happened AGAIN, in tools/apply_unit_type_mapping.js, because
//  the rule lived where nothing else could reach it: the tool hardcoded
//  SSL, ran fine against Neon and against this machine, and took CI red
//  for four consecutive runs. A rule that has to be remembered per file
//  is a rule that will be forgotten per file. It is stated here once.
//
//  ══ THE RULE, STATED ONCE ════════════════════════════════════════════
//  SSL is ON unless the connection itself declares it should not be:
//    · a local host (127.0.0.1 / localhost / ::1 / a unix socket) — by
//      definition not crossing a network, or
//    · an explicit `sslmode=disable` in the URL — the Postgres-standard
//      way for a caller to say "this host does not speak SSL". Added for
//      docker-compose local dev, where the API container reaches the
//      database by its service name (`db`) — not a local host, and a
//      postgres:16 container with no TLS. The caller declares it in the
//      URL; this module respects the declaration. `sslmode=require` (Neon)
//      is untouched and still gets SSL with the options it always had.
// ════════════════════════════════════════════════════════════════════

"use strict";

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1", ""];

function databaseSsl(url) {
  try {
    const parsed = new URL(String(url || ""));
    //  URL.hostname keeps the brackets on an IPv6 literal — "[::1]", not
    //  "::1" — so the ::1 entry in the list below never matched and IPv6
    //  loopback was being told to use SSL. Carried over from the original
    //  in server.js and found by checking the rule's answers one by one
    //  rather than assuming a list membership test did what it read like.
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (LOCAL_HOSTS.includes(host)) return false;
    if (parsed.searchParams.get("sslmode") === "disable") return false;
  } catch (_) { /* unparseable — fall through to the safe default */ }
  return { rejectUnauthorized: false };
}

module.exports = { databaseSsl, LOCAL_HOSTS };
