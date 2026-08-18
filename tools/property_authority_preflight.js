#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
 *  property_authority_preflight.js — READ-ONLY. Answers the database
 *  half of the property-identity blocker, and the "can Mike be let in"
 *  question, without writing anything.
 *
 *  WHY THIS EXISTS
 *  The blocker says a signed-in session reported Skyline in the chrome
 *  while the server-scoped Rent Roll returned Solo, and that which side
 *  is wrong is NOT established. The server source says the three
 *  identity/scoped endpoints all read req.operator.property_id off one
 *  resolveStaffSession(token), so given ONE token they cannot disagree
 *  (docs/PROPERTY_IDENTITY_AUTHORITY_TRACE.md §2). What remains is a
 *  question about TOKENS, and tokens live here.
 *
 *  THE JOIN THAT SETTLES IT
 *  staff_sessions stores sha256(token) in token_digest and — since
 *  migration 070 — no raw token at all. So a browser holding a session
 *  can compute sha256 of the token it is presenting, print the first 12
 *  hex, and that prefix names EXACTLY ONE row here.
 *
 *      tools/property_identity_truth_table.console.js   (app repo)
 *          prints  digest_fp = sha256(token)[0..12]
 *      this tool
 *          prints  digest_fp = left(token_digest, 12)
 *
 *  Neither side ever holds or prints the token. The digest cannot be
 *  presented as a credential — the server hashes what it is GIVEN and
 *  compares — so a prefix of it is safe to paste into a receipt.
 *
 *  Two live sessions for one user, bound to two properties, IS the
 *  evidence for hypothesis A. This is the only place that fact exists.
 *
 *  SAFE AGAINST PRODUCTION BY CONSTRUCTION, not by argument. It opens a
 *  transaction proven unable to write BEFORE it reads anything
 *  (tools/activation/_readonly.js), so it is legitimate in the Render
 *  Shell where DATABASE_URL is production. It is deliberately exempt
 *  from the concern in docs/DB_HARNESS_ISOLATION.md: that document
 *  blocks harnesses that COMMIT. This one cannot.
 *
 *  USAGE
 *    DATABASE_URL="<neon url>" node tools/property_authority_preflight.js
 *    DATABASE_URL="..." node tools/property_authority_preflight.js \
 *        --property-like 'solo|skyline'  --user-like 'mike'
 *
 *  CLASS 3 — diagnostic. Removal condition: the property-switch
 *  regression exists as a real test AND the blocker has a receipt.
 * ════════════════════════════════════════════════════════════════════ */
"use strict";

const { Client } = require("pg");
const { beginProvenReadOnly } = require("./activation/_readonly.js");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const PROPERTY_LIKE = arg("property-like", "solo|skyline");
const USER_LIKE     = arg("user-like", null);

const NL = () => console.log("");
function head(t) {
  console.log("");
  console.log("── " + t + " " + "─".repeat(Math.max(0, 66 - t.length)));
}
/*  Absence is a finding, and it must not render as an empty section
 *  that reads like "nothing wrong here" (PHILOSOPHY §5, §40.7).  */
function rows(list, emptySentence) {
  if (!list || !list.length) { console.log("   NOT ESTABLISHED — " + emptySentence); return false; }
  console.table(list);
  return true;
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("\n  REFUSED: DATABASE_URL is not set. This tool reads; it cannot guess.\n");
    process.exit(1);
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  /*  THE PROBE RUNS BEFORE ANY READ. A safety check that runs after the
   *  data has been read is a report, not a guard.  */
  const ro = await beginProvenReadOnly(client, "authority_preflight");
  if (!ro.ok) {
    console.error("\n  REFUSED: " + ro.reason);
    console.error("  This tool will not read production outside a proven read-only transaction.\n");
    await client.end();
    process.exit(1);
  }

  console.log("════════════════════════════════════════════════════════════════");
  console.log("  PROPERTY AUTHORITY PREFLIGHT — read-only, proven before reading");
  console.log("  property filter: /" + PROPERTY_LIKE + "/i" + (USER_LIKE ? "   user filter: /" + USER_LIKE + "/i" : ""));
  console.log("════════════════════════════════════════════════════════════════");

  let exitCode = 0;

  try {
    /* ── 1 · WHICH PROPERTIES ─────────────────────────────────────────
     *  Duplicate empty rows exist for Skyline (handoff, 07-25). Naming
     *  a property by its name is how the wrong one gets operated, so
     *  every row is shown with its inventory count, not just its id. */
    head("1 · PROPERTIES MATCHING THE FILTER");
    const props = (await client.query(
      `select p.id,
              p.name,
              p.display_name,
              (select count(*) from units u where u.property_id = p.id)            as units,
              (select count(*) from property_team_assignments a
                where a.property_id = p.id and a.active)                            as active_team,
              p.created_at
         from properties p
        where p.name ~* $1 or coalesce(p.display_name,'') ~* $1
        order by p.created_at asc`,
      [PROPERTY_LIKE]
    )).rows;
    rows(props, "no property matches /" + PROPERTY_LIKE + "/i in this database.");
    const propIds = props.map((r) => r.id);
    const propName = (id) => {
      const p = props.find((x) => String(x.id) === String(id));
      return p ? (p.display_name || p.name) : String(id).slice(0, 8) + "… (outside the filter)";
    };

    /* ── 2 · WHO IS ASSIGNED, AND IS IT ACTIVE ────────────────────────
     *  `active = false` is not a missing row. issueStaffSession reads
     *  this FOR SHARE and refuses with 403, so an inactive assignment
     *  makes a property UNSWITCHABLE while still looking present in
     *  every list that does not check the flag. */
    head("2 · TEAM ASSIGNMENTS ON THOSE PROPERTIES");
    let assigns = [];
    if (propIds.length) {
      assigns = (await client.query(
        `select u.name              as user_name,
                u.email,
                u.is_active         as user_active,
                a.property_id,
                a.role_title,
                a.active            as assignment_active,
                a.allowed_modules,
                a.scope_type
           from property_team_assignments a
           join users u on u.id = a.user_id
          where a.property_id = any($1::uuid[])
            and ($2::text is null or u.name ~* $2 or coalesce(u.email,'') ~* $2)
          order by u.name asc`,
        [propIds, USER_LIKE]
      )).rows.map((r) => { const o = { ...r, property: propName(r.property_id) }; delete o.property_id; return o; });
    }
    rows(assigns, "nobody is assigned to those properties" + (USER_LIKE ? " under /" + USER_LIKE + "/i." : "."));

    const inactive = assigns.filter((a) => a.assignment_active === false);
    if (inactive.length) {
      console.log("");
      console.log("   ⚠ " + inactive.length + " assignment(s) are INACTIVE. issueStaffSession refuses these with 403,");
      console.log("     so those operators CANNOT switch into that property — the switch is the grant.");
      inactive.forEach((a) => console.log("       · " + a.user_name + " → " + a.property));
    }

    /* ── 2b · THE NAMED OPERATOR WHO IS NOT THERE ────────────────────
     *  "Get Mike into Skyline" fails silently if Mike has no user row or
     *  no assignment: he simply never appears in section 2, and an
     *  absent row reads like a section that found nothing wrong.
     *  issue_operator_invite.js CREDENTIALS an already-authorized user —
     *  it creates no user, assignment, role or module — so this is the
     *  question that decides whether that tool can be run at all. */
    if (USER_LIKE) {
      head("2b · NAMED OPERATORS AND WHETHER THEY CAN BE LET IN");
      const named = (await client.query(
        `select u.id, u.name, u.email, u.is_active,
                (select count(*) from property_team_assignments a
                  where a.user_id = u.id and a.property_id = any($2::uuid[]))          as assignments_here,
                (select count(*) from property_team_assignments a
                  where a.user_id = u.id and a.property_id = any($2::uuid[]) and a.active) as active_here
           from users u
          where u.name ~* $1 or coalesce(u.email,'') ~* $1
          order by u.name asc`,
        [USER_LIKE, propIds]
      )).rows;
      if (!named.length) {
        console.log("   NOT ESTABLISHED — no user matches /" + USER_LIKE + "/i.");
        console.log("   There is no one to credential. issue_operator_invite.js REFUSES to create a user,");
        console.log("   an assignment, a role or a module — authority is established elsewhere, first.");
      } else {
        console.table(named);
        named.forEach((u) => {
          if (Number(u.active_here) > 0) {
            console.log("   · " + u.name + " CAN be credentialed — " + u.active_here + " active assignment(s) here.");
          } else if (Number(u.assignments_here) > 0) {
            console.log("   · " + u.name + " has an assignment here but it is INACTIVE. A session cannot be");
            console.log("     issued for it: issueStaffSession reads the assignment and refuses with 403.");
          } else {
            console.log("   · " + u.name + " has NO assignment to these properties. Nothing to credential yet.");
          }
        });
      }
    }

    /* ── 3 · LIVE SESSIONS — THE ACTUAL DISCRIMINATOR ─────────────────
     *  One user holding two unrevoked, unexpired sessions bound to two
     *  properties is hypothesis A, with evidence. digest_fp joins to the
     *  browser harness. */
    head("3 · LIVE STAFF SESSIONS (unrevoked, unexpired)");
    const sessions = (await client.query(
      `select u.name                                as user_name,
              s.property_id,
              left(coalesce(s.token_digest,''), 12) as digest_fp,
              (s.token_digest is null)              as legacy_raw_token_row,
              s.issuance_purpose,
              s.created_at,
              s.expires_at
         from staff_sessions s
         join users u on u.id = s.user_id
        where s.revoked = false
          and s.expires_at > now()
          and ($1::text is null or u.name ~* $1 or coalesce(u.email,'') ~* $1)
        order by u.name asc, s.created_at asc`,
      [USER_LIKE]
    )).rows.map((r) => { const o = { ...r, property: propName(r.property_id) }; delete o.property_id; return o; });
    rows(sessions, "no live staff session exists right now" + (USER_LIKE ? " under /" + USER_LIKE + "/i." : ".") +
                   " If the browser still shows a signed-in app, it is holding a session this query says is dead.");

    const byUser = new Map();
    sessions.forEach((s) => {
      const k = s.user_name;
      if (!byUser.has(k)) byUser.set(k, []);
      byUser.get(k).push(s);
    });
    const multi = [...byUser.entries()].filter(([, v]) => v.length > 1);

    /* ── 4 · WHAT THIS ESTABLISHES — computed, never eyeballed ────────── */
    head("4 · WHAT THIS ESTABLISHES");
    if (!sessions.length) {
      console.log("   Nothing about the blocker. There is no live session to attribute a read to.");
    } else if (multi.length) {
      exitCode = 0; // a finding, not a failure — this tool reports, it does not judge
      console.log("   MULTIPLE LIVE SESSIONS FOR ONE USER:");
      multi.forEach(([user, list]) => {
        const distinct = [...new Set(list.map((s) => s.property))];
        console.log("     · " + user + " holds " + list.length + " live sessions across " +
                    distinct.length + " propert" + (distinct.length === 1 ? "y" : "ies") + ": " + distinct.join(", "));
        list.forEach((s) => console.log("         " + s.digest_fp + "  " + s.property +
                                        "  minted " + new Date(s.created_at).toISOString()));
      });
      if (multi.some(([, l]) => new Set(l.map((s) => s.property)).size > 1)) {
        console.log("");
        console.log("   THIS IS HYPOTHESIS A WITH EVIDENCE. A switch mints a new session and revokes only");
        console.log("   the one it authenticated with, so a second live session bound to the previous");
        console.log("   property survives and keeps answering. Match digest_fp against the browser table");
        console.log("   to say WHICH of these the affected tab was presenting.");
      }
    } else {
      console.log("   Every user holds at most ONE live session. That is the intended shape and it does");
      console.log("   NOT reproduce the blocker — say that rather than reading it as the answer. If the");
      console.log("   bad state was observed earlier, the second session may since have expired or been");
      console.log("   revoked; this query cannot see a session that is already gone.");
    }

    const legacy = sessions.filter((s) => s.legacy_raw_token_row);
    if (legacy.length) {
      console.log("");
      console.log("   NOTE " + legacy.length + " live session(s) predate migration 070 and store a raw token");
      console.log("        (token_digest IS NULL). Their digest_fp is blank and CANNOT be joined to the");
      console.log("        browser table. That is a gap in this evidence, not a clean row.");
    }
  } catch (e) {
    console.error("\n  READ_FAILED — " + (e && e.message ? e.message : String(e)));
    console.error("  A failed read is a fact about Spine, not about the property. Nothing above is a verdict.\n");
    exitCode = 2;
  } finally {
    try { await client.query("rollback"); } catch (_) { /* read-only txn, nothing to unwind */ }
    await client.end();
  }

  NL();
  process.exit(exitCode);
})();
