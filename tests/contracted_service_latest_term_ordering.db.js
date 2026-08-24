"use strict";

/*  ════════════════════════════════════════════════════════════════════
 *  WHICH GOVERNING TERM IS CURRENT — a real-Postgres proof.  CLASS 3.
 *
 *  contracted_service_projection.js decides which executed governing term
 *  governs an engagement right now. Among the terms that COVER as_of it
 *  takes the newest by (commencement_date, recorded_at):
 *
 *      const selected = newest(active, ["commencement_date", "recorded_at"]);
 *
 *  `commencement_date` is a `date` column (migration 171) and this repo
 *  installs NO node-pg type parser, so node-pg hands back a JS **Date**.
 *  A comparator that coerces with String() therefore compares
 *
 *      "Wed Jan 07 2026 00:00:00 GMT+0000 (…)"
 *      "Fri Mar 06 2026 00:00:00 GMT+0000 (…)"
 *
 *  which sorts on the WEEKDAY NAME first. Descending, "Wed" beats "Fri",
 *  so a term that commenced in JANUARY outranks one that commenced in
 *  MARCH — and the wrong contract governs.
 *
 *  This harness does not reimplement any of that. It seeds two overlapping
 *  executed governing terms, reads them back through the canonical
 *  contracted-service Postgres reader, and requires the chronologically
 *  later one to govern.
 *
 *  ⚠ NOT CI-WIRED. tests/e2e/verify_all.sh is not this lane's to edit, so
 *  a green parent run is NOT evidence that this ran. The honest rung is
 *  LOCALLY_EXERCISED with real Postgres.
 *
 *  Everything it creates — including the property — is created inside one
 *  transaction and ROLLED BACK, on success and on failure alike.
 *  ════════════════════════════════════════════════════════════════════ */

const assert = require("assert");
const { Client } = require("pg");

const runReceipt = require("./_run_receipt.js");
const positionRead = require("../src/asset/contracted_service_position_read.js");
const artifactService = require("../src/onboarding/source_artifact_service.js");

const PREFIX = "camp-term-ordering";

//  The two commencement dates the whole proof turns on. Chronological
//  order and String(Date) order DISAGREE here, and the harness asserts
//  that disagreement below rather than trusting this comment.
const EARLY_COMMENCEMENT = "2026-01-07";   // a Wednesday
const LATE_COMMENCEMENT = "2026-03-06";    // a Friday — later, but "Fri" < "Wed"
const SHARED_END = "2026-12-31";
const AS_OF = "2026-06-15";                // both terms cover this day

function refuse(lines) {
  console.error("");
  console.error("  ✘ REFUSED");
  for (const line of lines) console.error(`    ${line}`);
  console.error("");
  process.exit(2);
}

/*  REQUIREMENT: refuse a non-local database. This harness writes real rows.
    Two independent refusals, because they catch different mistakes:

      harnessConnectionString()  refuses when the harness target RESOLVES to
        the same host/port/database as DATABASE_URL. Requiring the variable
        is not the same as refusing the wrong value — two different spellings
        of one target compare unequal as strings and identical as targets.
        That check is owned by tests/_run_receipt.js and is not reimplemented
        here; a second, weaker copy of it would become the real one.

      localOnly()  additionally refuses any NON-LOCAL host. The shared guard
        permits a remote disposable branch; this proof does not need one and
        must never reach across the network to write.                        */
function localOnly(url) {
  let host = null;
  try { host = new URL(url).hostname; } catch (error) {
    refuse([`HARNESS_DATABASE_URL is not a parsable URL: ${error.message}`]);
  }
  const LOCAL = ["127.0.0.1", "localhost", "::1", "[::1]", ""];
  if (!LOCAL.includes(String(host).toLowerCase())) {
    refuse([
      `HARNESS_DATABASE_URL points at a NON-LOCAL host: ${host}`,
      "This proof writes real rows and may only ever target a disposable",
      "LOCAL Postgres. Refusing to connect.",
    ]);
  }

  /*  ⚠ RECORDED, NOT FIXED HERE. tests/_run_receipt.js sameTarget()
      compares hostnames LITERALLY, so "127.0.0.1" and "localhost" read as
      different targets even though they are the same server. That file is
      not this slice's to change. Because every host reaching this line is
      already local, comparing port+database is sufficient to close the
      alias hole for THIS harness.                                        */
  const other = process.env.DATABASE_URL;
  if (other) {
    try {
      const mine = new URL(url);
      const theirs = new URL(other);
      const localAlias = (h) => LOCAL.includes(String(h).toLowerCase());
      const port = (u) => u.port || "5432";
      const database = (u) => u.pathname.replace(/^\//, "");
      if (localAlias(theirs.hostname)
          && port(mine) === port(theirs)
          && database(mine) === database(theirs)) {
        refuse([
          "HARNESS_DATABASE_URL and DATABASE_URL name the SAME local database",
          `  port=${port(mine)}  database=${database(mine)}`,
          `  (hosts "${mine.hostname}" and "${theirs.hostname}" are aliases)`,
          "Refusing to write into the database this service reads.",
        ]);
      }
    } catch (_) { /* an unparseable DATABASE_URL is not a same-target claim */ }
  }
  return url;
}

function pdf(label) {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n(${label})\nendobj\n%%EOF`, "utf8");
}

function report(title, rows) {
  console.log(`\n  ── ${title}`);
  for (const [k, v] of rows) console.log(`     ${String(k).padEnd(34)} ${v}`);
}

async function run() {
  const connectionString = localOnly(runReceipt.harnessConnectionString());
  runReceipt.begin(__filename, { url: connectionString, expected: 6 });
  const client = new Client({ connectionString, application_name: PREFIX });
  await client.connect();

  let failed = null;
  try {
    await client.query("begin");

    //  ── FIXTURE. Every row below is created here and rolled back at the
    //     end. Nothing pre-existing is mutated. ──────────────────────────
    const user = (await client.query(
      `insert into users (name, email)
       values ($1, $2) returning id`,
      [`${PREFIX} recorder`, `${PREFIX}@example.invalid`])).rows[0];

    const property = (await client.query(
      `insert into properties (name) values ($1) returning id`,
      [`${PREFIX} property`])).rows[0];

    const artifact = await artifactService.store(client, {
      scope_type: "property",
      scope_id: property.id,
      filename: `${PREFIX}-agreement.pdf`,
      mimetype: "application/pdf",
      buffer: pdf(`${PREFIX}-agreement`),
      uploaded_by_user_id: user.id,
      authority_basis: "disposable local proof of governing-term ordering",
      source_as_of_date: AS_OF,
      artifact_kind: "contracted_service_agreement",
    });

    const provider = (await client.query(
      `insert into contracted_service_providers
         (provider_name, provenance_note, created_by_user_id)
       values ($1, $2, $3) returning id`,
      [`${PREFIX} provider`, "Created by a disposable local proof.", user.id])).rows[0];

    const engagement = (await client.query(
      `insert into contracted_service_engagements
         (property_id, service_class, service_label, provider_id,
          effective_from, provenance_note, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [property.id, "elevator_maintenance", "Elevator maintenance", provider.id,
       "2026-01-01", "Created by a disposable local proof.", user.id])).rows[0];

    const document = (await client.query(
      `insert into contracted_service_documents
         (property_id, engagement_id, source_artifact_id, document_kind,
          execution_state, document_date, confirmed_by_user_id)
       values ($1, $2, $3, 'agreement', 'executed', $4, $5) returning id`,
      [property.id, engagement.id, artifact.id, EARLY_COMMENCEMENT, user.id])).rows[0];

    async function seedTerm(commencement, label) {
      return (await client.query(
        `insert into contracted_service_terms
           (property_id, engagement_id, document_id, term_authority,
            commencement_date, initial_end_date, term_kind,
            provenance_note, recorded_by_user_id)
         values ($1, $2, $3, 'governing', $4, $5, 'fixed', $6, $7)
         returning id, commencement_date, initial_end_date, recorded_at`,
        [property.id, engagement.id, document.id, commencement, SHARED_END,
         `${PREFIX} ${label}`, user.id])).rows[0];
    }

    //  Insert EARLY first so that, if the comparator ever fell back to
    //  insertion order or to recorded_at, it would still be the wrong
    //  answer for a different reason — and the assertion would say so.
    const earlyTerm = await seedTerm(EARLY_COMMENCEMENT, "early-term");
    const lateTerm = await seedTerm(LATE_COMMENCEMENT, "late-term");

    //  ── WHAT NODE-POSTGRES ACTUALLY HANDED BACK ────────────────────────
    const raw = (await client.query(
      `select id, commencement_date, recorded_at
         from contracted_service_terms
        where property_id = $1 order by commencement_date`, [property.id])).rows;
    assert.strictEqual(raw.length, 2, "expected exactly the two seeded terms");

    for (const row of raw) {
      assert.ok(row.commencement_date instanceof Date,
        `commencement_date came back as ${typeof row.commencement_date}, not a JS Date — ` +
        "the premise of this proof (a type parser may have been installed) no longer holds");
      assert.ok(row.recorded_at instanceof Date,
        "recorded_at came back as something other than a JS Date");
    }

    const earlyRaw = raw.find((r) => r.id === earlyTerm.id);
    const lateRaw = raw.find((r) => r.id === lateTerm.id);

    report("what node-postgres returned", [
      ["early term id", earlyTerm.id],
      ["early commencement_date (raw)", `${earlyRaw.commencement_date.toISOString().slice(0, 10)}  [${earlyRaw.commencement_date.constructor.name}]`],
      ["early String(Date)", String(earlyRaw.commencement_date)],
      ["late term id", lateTerm.id],
      ["late commencement_date (raw)", `${lateRaw.commencement_date.toISOString().slice(0, 10)}  [${lateRaw.commencement_date.constructor.name}]`],
      ["late String(Date)", String(lateRaw.commencement_date)],
    ]);

    //  ── THE PRECONDITION THIS PROOF DEPENDS ON ─────────────────────────
    //  Chronological order and String(Date) order must DISAGREE. If they
    //  ever agree (a different TZ, a type parser, different dates), this
    //  harness would pass for a reason that proves nothing — so it says so
    //  loudly instead of going quietly green.
    const chronologicallyLater =
      lateRaw.commencement_date.getTime() > earlyRaw.commencement_date.getTime()
        ? lateTerm.id : earlyTerm.id;
    const stringDescendingPicks =
      String(lateRaw.commencement_date) > String(earlyRaw.commencement_date)
        ? lateTerm.id : earlyTerm.id;
    assert.strictEqual(chronologicallyLater, lateTerm.id,
      "fixture is wrong: the 'late' term is not chronologically later");
    assert.notStrictEqual(stringDescendingPicks, chronologicallyLater,
      "PRECONDITION LOST — chronological order and String(Date) order AGREE here, " +
      "so this harness could not distinguish a correct comparator from a broken one");

    //  ── THE CANONICAL READ. Not a reimplementation. ────────────────────
    const position = await positionRead.readPosition(client, {
      property_id: property.id, as_of: AS_OF,
    });

    const engagementViews = (position.detail && position.detail.engagements) || [];
    assert.strictEqual(engagementViews.length, 1, "expected exactly one engagement view");
    const termStanding = engagementViews[0].term_standing;
    const selected = termStanding.current;
    assert.ok(selected, "no governing term was selected at all");

    const selectedId = selected.id;
    const expectedId = lateTerm.id;

    report("which term the canonical read selected", [
      ["as_of", AS_OF],
      ["expected (chronologically later)", `${expectedId}  commencing ${LATE_COMMENCEMENT}`],
      ["actual (selected by projection)", `${selectedId}  commencing ${selected.commencement_date}`],
      ["term_standing.state", termStanding.state],
      ["term_standing.reason", termStanding.reason],
      ["verdict", selectedId === expectedId ? "CORRECT" : "WRONG TERM GOVERNS"],
    ]);

    assert.strictEqual(selectedId, expectedId,
      `THE WRONG CONTRACT TERM GOVERNS. Expected the term commencing ${LATE_COMMENCEMENT} ` +
      `(${expectedId}) to govern at ${AS_OF}; the projection selected the term commencing ` +
      `${selected.commencement_date} (${selectedId}). Both terms cover ${AS_OF}. ` +
      "The selection ran on String(JS Date), which orders by WEEKDAY NAME: " +
      `"${String(earlyRaw.commencement_date).slice(0, 3)}" outranked ` +
      `"${String(lateRaw.commencement_date).slice(0, 3)}".`);

    assert.strictEqual(selected.commencement_date, LATE_COMMENCEMENT,
      "the selected term's commencement_date is not the later date");

    console.log("\n  ✔ the chronologically later governing term governs.\n");
  } catch (error) {
    failed = error;
  } finally {
    //  REQUIREMENT: clean up every owned row, success or failure.
    try { await client.query("rollback"); } catch (_) { /* connection already gone */ }
    await client.end();
  }

  if (failed) {
    console.error(`\n  ✘ ${failed.message}\n`);
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
