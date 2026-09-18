#!/usr/bin/env node
/*  The release wrapper refuses to apply a migration whose bytes differ from
 *  the hash it was reviewed against. That is right — and it means the pinned
 *  hash must be of bytes every host reproduces: the git blob, which
 *  .gitattributes holds at LF. On 2026-09-14 the 195–197 pins were found to
 *  be CRLF-checkout hashes; the wrapper passed on Windows and refused on
 *  Linux, and nothing in CI looked. This test looks: it recomputes each
 *  reviewed hash from the tracked file (as git stores it, via git show, and
 *  as checked out on disk) and fails on any drift, either way.
 */
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const WRAPPER = path.join(ROOT, "tools", "release", "migration_194_198_predeploy.js");
const src = fs.readFileSync(WRAPPER, "utf8");
const block = src.match(/const REVIEWED_HASHES = Object\.freeze\(\{([\s\S]*?)\}\);/);
assert.ok(block, "REVIEWED_HASHES block not found in the wrapper");
const pins = Object.fromEntries([...block[1].matchAll(/"([^"]+\.sql)":\s*"([0-9a-f]{64})"/g)].map((m) => [m[1], m[2]]));
assert.deepEqual(Object.keys(pins).sort(), [
  "195_two_step_leasing_authored_offer_basis.sql",
  "196_source_home_identity_review.sql",
  "197_inventory_correction_hardening.sql",
  "198_proposed_source_claim_identity.sql",
]);
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
let checked = 0;
for (const [file, pinned] of Object.entries(pins)) {
  const onDisk = fs.readFileSync(path.join(ROOT, "migrations", file));
  assert.ok(!onDisk.includes("\r"), `${file}: CR bytes on disk — .gitattributes eol=lf is not in effect`);
  assert.equal(sha(onDisk), pinned, `${file}: on-disk bytes differ from the reviewed hash`);
  const blob = execFileSync("git", ["show", `HEAD:migrations/${file}`], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(sha(blob), pinned, `${file}: HEAD git blob differs from the reviewed hash`);
  checked++;
}
console.log(`migration 194-198 reviewed hashes: ${checked} files match their git blobs and on-disk bytes`);
