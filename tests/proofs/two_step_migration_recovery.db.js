"use strict";
// Read-only: run separately against canonical owned 194 and 195 manifests.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const { Client } = require("pg");

(async () => {
  await boundary.assertDatabase();
  const expected = process.env.PROOF_EXPECTED_CEILING;
  assert.ok(
    ["194", "195"].includes(expected),
    "explicit 194 or 195 ceiling required",
  );
  assert.ok(
    process.env.MIGRATION_BASELINE_ROOT,
    "explicit baseline checkout required",
  );
  const roots = [
    path.resolve(process.env.MIGRATION_BASELINE_ROOT),
    path.resolve(__dirname, "../.."),
  ];
  const files = roots.map((root) =>
    fs.readdirSync(path.join(root, "migrations")),
  );
  assert.ok(
    !files[0].some((f) => /^195_.*\.sql$/.test(f)),
    "baseline must carry only pre-195 files",
  );
  assert.ok(
    files[1].some((f) => /^195_.*\.sql$/.test(f)),
    "candidate must carry migration 195",
  );
  const db = new Client({
    connectionString: boundary.manifest().url,
    ssl: false,
  });
  await db.connect();
  try {
    const before = (
      await db.query(
        "select version,name from schema_migrations order by version",
      )
    ).rows;
    assert.equal(String(before.at(-1).version).padStart(3, "0"), expected);
    for (const [i, root] of roots.entries()) {
      const env = boundary.serverEnvironment({
        PGOPTIONS: "-c default_transaction_read_only=on",
      });
      const result = spawnSync(
        process.execPath,
        [path.join(root, "migrations/migrate.js")],
        {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 30000,
        },
      );
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      const shouldPass = (expected === "194") === (i === 0);
      assert.equal(
        result.status,
        shouldPass ? 0 : 1,
        `verifier ${i}, ceiling ${expected}: ${output}`,
      );
      assert.match(
        output,
        shouldPass
          ? /SCHEMA VERIFIED/
          : i === 0
            ? /LEDGER VERSION MISSING FROM THIS REPOSITORY/
            : /NOT applied to the target database/,
      );
      console.log(
        `PASS ${i === 0 ? "baseline" : "candidate"} at ${expected}: ${shouldPass ? "verified" : "refused"}`,
      );
    }
    assert.deepEqual(
      (
        await db.query(
          "select version,name from schema_migrations order by version",
        )
      ).rows,
      before,
    );
    console.log("PASS ledger unchanged; both child verifiers forced read-only");
  } finally {
    await db.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
