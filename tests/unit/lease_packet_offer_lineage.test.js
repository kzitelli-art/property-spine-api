#!/usr/bin/env node
"use strict";

// Source-level contract for the packet consumer. The packet module is an
// Express composition with database, PDF and retained-artifact dependencies;
// these assertions keep the narrow lineage/fee seam reviewable without
// manufacturing a second packet fixture or a fake retained lease source.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "applications", "lease_packets.js"),
  "utf8"
);

assert.match(source, /readBoundApplicationOffer\(client, app\)/,
  "packet generation must read the existing offer owner with exact app scope");
assert.match(source, /application_offer_id, application_terms_hash/,
  "packet SQL must carry offer lineage");
assert.match(source, /fees: boundOffer \? boundOffer\.terms\.fees : null/,
  "bound packet terms must carry the accepted offer fee list");
assert.match(source, /fees: boundFees \? terms\.fees : null/,
  "rendered governing schedule must retain the accepted fee list");
assert.match(source, /application_fee: boundFees \? null : cfg\.application_fee/,
  "bound packets must not read mutable property application fees");
assert.match(source, /amenity_fee: boundFees \? null : cfg\.amenity_fee/,
  "bound packets must not read mutable property amenity fees");
assert.match(source, /utility_fee_total: boundFees \? null/,
  "bound packets must not read mutable property utility fee totals");
assert.match(source, /String\(confirmation\.application_terms_hash \|\| \"\"\) !== String\(boundOffer\.hash\)/,
  "packet generation must refuse a confirmation with a different offer hash");
assert.match(source, /packet_terms_lineage_conflict/,
  "an existing packet with different offer lineage must fail closed");
assert.match(source, /application_offer_id: packet\.application_offer_id \|\| null/,
  "the public packet must expose its offer lineage");

console.log("lease_packet_offer_lineage: PASS (9 source contracts)");
