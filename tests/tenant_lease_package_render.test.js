"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = path.join(__dirname, "..", "src", "applications", "tenant_lease_packet.html");
const html = fs.readFileSync(file, "utf8");
const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi));
assert(scripts.length > 0, "tenant page carries its runtime");
for (const [index, match] of scripts.entries()) {
  new vm.Script(match[1], { filename: `tenant_lease_packet.html#${index + 1}` });
}

assert(/Official lease package/.test(html));
assert(/Download original/.test(html));
assert(/data-signature-name/.test(html));
assert(/Type your full legal name before signing/.test(html));
assert(/complete lease package is recorded/.test(html));
assert(!/letter-spacing:-/.test(html));

console.log("\n6 tenant lease package render assertions passed\n");
