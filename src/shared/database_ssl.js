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
//  PRODUCTION BEHAVIOUR IS UNCHANGED. Neon is not a local host, so it
//  still gets SSL with the same options it always had. Only a connection
//  to 127.0.0.1 / localhost / ::1 / a unix socket relaxes, and only
//  because such a host is by definition not crossing a network.
// ════════════════════════════════════════════════════════════════════

"use strict";

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1", ""];

function databaseSsl(url) {
  try {
    //  URL.hostname keeps the brackets on an IPv6 literal — "[::1]", not
    //  "::1" — so the ::1 entry in the list below never matched and IPv6
    //  loopback was being told to use SSL. Carried over from the original
    //  in server.js and found by checking the rule's answers one by one
    //  rather than assuming a list membership test did what it read like.
    const host = new URL(String(url || "")).hostname.replace(/^\[|\]$/g, "");
    if (LOCAL_HOSTS.includes(host)) return false;
  } catch (_) { /* unparseable — fall through to the safe default */ }
  return { rejectUnauthorized: false };
}

module.exports = { databaseSsl, LOCAL_HOSTS };
