/*  TEST FIXTURE — NOT PRODUCTION TRUTH, NOT A LEGAL INSTRUMENT.
    A stand-in governing lease body whose sha256 is a REAL hash of its own
    bytes, placed on the property's lease_config so the packet generator
    establishes it at generation — the order the existing versioning and
    snapshot-hash machinery requires. Carries no Skyline lease language. */
module.paths.unshift(require("path").join(__dirname, "..", "..", "node_modules"));
const crypto = require("crypto");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL || "postgres://postgres:spineproof@127.0.0.1:5432/spine_e2e" });

const TEST_BODY = [
  "TEST GOVERNING LEASE BODY — FIXTURE ONLY. THIS IS NOT A LEASE.",
  "It exists solely to give the instrument-identity mechanism real bytes to",
  "hash and real bytes for a signature to be a signature ON. It is not the",
  "Skyline form of record, is not legal proof, and has no legal effect.",
].join("\n");
const SHA = crypto.createHash("sha256").update(TEST_BODY, "utf8").digest("hex");

(async () => {
  const r = await pool.query(
    `update properties
        set lease_config = coalesce(lease_config,'{}'::jsonb) || jsonb_build_object(
              'governing_instrument', jsonb_build_object(
                'form_code',    'TEST-FIXTURE-FORM',
                'form_version', '0-test',
                'body_sha256',  $1::text))
      where name='Skyline E2E' returning id`, [SHA]);
  console.log(`fixture: governing_instrument on ${r.rowCount} property · sha256 ${SHA}`);
  await pool.end();
})();
