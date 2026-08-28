// tools/proofs/proof_lease_packet_operator_static.js
// Source-structure proof. No database or server required.

const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const lp = fs.readFileSync(path.join(root, "lease_packets.js"), "utf8");
const op = fs.readFileSync(path.join(root, "operator.js"), "utf8");
const sv = fs.readFileSync(path.join(root, "server.js"), "utf8");

let pass = 0;
function has(name, text, needle) {
  if (!text.includes(needle)) throw new Error(`${name}: missing ${needle}`);
  pass += 1;
  console.log("  ok  " + name);
}
function lacks(name, text, needle) {
  if (text.includes(needle)) throw new Error(`${name}: forbidden ${needle}`);
  pass += 1;
  console.log("  ok  " + name);
}

has("service export", lp, "router._service = Object.freeze");
has("canonical generate service", lp, "async function generateLeasePacket");
has("canonical issue service", lp, "async function issueLeasePacketLink");
has("generation uses confirmation rent", lp, "monthly_rent: confirmation.rent");
has("draft update writes lineage", lp, "proposed_terms_confirmation_id=$5");
has("new packet insert writes lineage", lp, "supersedes_packet_id, proposed_terms_confirmation_id");
has("issue locks packet and application", lp, "for update of pk, la");
has("already-issued stop", lp, "already_issued: true");
has("issue only updates draft", lp, "where id=$1 and status='draft' and superseded_at is null");
lacks("old token-rotation update removed", lp, "status = case when status='draft' then 'sent' else status end");

has("generate operator route", op, '"/operator/leasing/applications/:id/lease-packet"');
has("issue operator route", op, '"/operator/leasing/lease-packets/:id/send"');
has("operator service injection", op, "leasePacketsService = null");
has("generate uses canonical service", op, "leasePacketsService.generateLeasePacket");
has("issue uses canonical service", op, "leasePacketsService.issueLeasePacketLink");
has("packet route has staff session gate", op, "requireOperator");
has("packet route has leasing entitlement", op, "requireLeasingModuleAccess");
has("packet route has activation perimeter", op, "operatorGeneratePacketPerimeter");
has("issue route has packet perimeter", op, "operatorIssuePacketPerimeter");

has("single packet module instance", sv, "const __leasePackets = leasePacketsModule");
has("single instance mounted", sv, 'app.use("/", __leasePackets)');
has("packet service injected", sv, "leasePacketsService: __leasePackets._service");

console.log(`\nPASS — ${pass} static checks.`);
