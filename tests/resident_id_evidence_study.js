/* ════════════════════════════════════════════════════════════════════
   resident_id_evidence_study.js — READ-ONLY MEASUREMENT

   Before any architecture is designed around `s0005738`, measure what the
   real artifacts actually give us. No database, no writes, no product
   change: this reads files and counts.

   The question is not "does the regex work". It is whether the identifier
   behaves EMPIRICALLY like a durable source identity, and what namespace
   it lives in.

   CLASS 3 — investigation. Delete when the Person ingress rule is ruled.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { mapRows } = require("../src/onboarding/rent_roll_field_map.js");
const snap = require("../src/shared/snapshot_loader.js");

const SKY_XLSX = process.env.SKYLINE_XLSX
  || "/root/.claude/uploads/27e16502-554d-5a14-9258-903418ff09cd/d657f655-RentRoll07_1417.xlsx";

const say = (s = "") => console.log(s);
const head = (t) => { say(""); say("── " + t + " " + "─".repeat(Math.max(0, 68 - t.length))); };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

//  The ID token, deliberately LOOSE so the study measures what is there
//  rather than what the production regex happens to accept.
const ID_TOKEN = /\b([A-Za-z]\d{3,})\b/;

function readSkyline(file) {
  const wb = XLSX.readFile(file);
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
  const meta = {};
  for (const r of grid.slice(0, 6)) {
    const a = String(r[0] || ""); const m = a.match(/^(As Of)\s*=\s*(.+)$/); if (m) meta[m[1]] = m[2].trim();
  }
  const h1 = grid[5] || [], h2 = grid[6] || [];
  const headers = h1.map((h, i) => [h, h2[i]].filter(Boolean).join(" ").trim() || `col${i}`);
  const out = []; let section = null;
  grid.forEach((r, i) => {
    const a = String(r[0] || "").trim();
    const lone = a && r.slice(1).filter((x) => x != null).length === 0;
    if (lone && /^Current\/Notice\/Vacant/.test(a)) { section = "current"; return; }
    if (lone && /^Future Residents/.test(a)) { section = "future"; return; }
    if (a === "Summary Groups") { section = null; return; }
    if (!section || !/^\d{3,4}-\d{2,3}$/.test(a)) return;
    const row = { __row: i + 1, __section: section };
    headers.forEach((h, c) => { row[h] = c === 0 ? a : r[c]; });
    out.push(row);
  });
  return { meta, headers, rows: out };
}

(async () => {
  say("");
  say("════════════════════════════════════════════════════════════════════");
  say("  RESIDENT-ID EVIDENCE STUDY — read-only measurement");
  say("════════════════════════════════════════════════════════════════════");

  // ══ ARTIFACT INVENTORY — say what exists before concluding from it ══
  head("1. ARTIFACT INVENTORY");
  const artifacts = [];
  if (fs.existsSync(SKY_XLSX)) artifacts.push(["Skyline 07/31/2026", "REAL XLSX", SKY_XLSX]);
  artifacts.push(["Skyline 04/30/2026", "TRANSCRIPTION (seeds/data_skyline.js)", "in repo"]);
  artifacts.push(["Solo June 2026", "SEED (seeds/data_solo.js) — DIFFERENT PROPERTY", "in repo"]);
  artifacts.forEach(([a, b, c]) => say(`      ${a.padEnd(22)} ${b.padEnd(42)} ${c === "in repo" ? "" : ""}`));
  say("");
  say("      ONLY ONE dated artifact per property carries IDs. Cross-artifact");
  say("      stability for a SINGLE property therefore CANNOT be measured here.");
  say("      That limit is stated rather than worked around.");

  // ══ SKYLINE — the real export ══════════════════════════════════════
  const sky = readSkyline(SKY_XLSX);
  head("2. SKYLINE 07/31 — where the identifier lives");
  const idColumns = sky.headers.filter((h) => /resident\s*id|tenant\s*id|t-?code|code/i.test(h));
  say(`      columns in the file: ${sky.headers.length}`);
  say(`      a dedicated resident-id column? ${idColumns.length ? idColumns.join(", ") : "NONE"}`);
  const nameCol = sky.headers.find((h) => /^resident$/i.test(h.trim())) || sky.headers[3];
  say(`      the id travels inside: "${nameCol}" (the display-name column)`);

  const skyRows = sky.rows.map((r) => {
    const raw = String(r[nameCol] == null ? "" : r[nameCol]).trim();
    const m = raw.match(/^(.*?)\s*\(([A-Za-z]\d{3,})\)\s*$/);
    const loose = raw.match(ID_TOKEN);
    return {
      unit: String(r[sky.headers[0]]).trim(), section: r.__section, raw,
      name: m ? m[1].trim() : raw,
      id: m ? m[2] : null,
      looseId: loose ? loose[1] : null,
      room: String(r[sky.headers.find((h) => /room/i.test(h)) || ""] || "").trim() || null,
      from: r[sky.headers.find((h) => /lease from|move.?in/i.test(h)) || ""] || null,
      to: r[sky.headers.find((h) => /lease to|lease end/i.test(h)) || ""] || null,
    };
  });
  const bearing = skyRows.filter((r) => r.raw && !/^(vacant|model|down|applicant)$/i.test(r.raw));

  head("3. THE EVIDENCE STUDY — Skyline 07/31");
  say(`      total rows                                  ${skyRows.length}`);
  say(`      resident-bearing rows                       ${bearing.length}`);
  const withId = bearing.filter((r) => r.id);
  const noId = bearing.filter((r) => !r.id);
  say(`      rows with a parsable PMS resident ID        ${withId.length}  (${pct(withId.length, bearing.length)}%)`);
  say(`      rows WITHOUT one                            ${noId.length}  (${pct(noId.length, bearing.length)}%)`);
  if (noId.length) {
    say(`        first few without an id:`);
    noId.slice(0, 5).forEach((r) => say(`          ${r.unit} ${String(r.room || "").padEnd(6)} ${JSON.stringify(r.raw)}`));
  }
  const looseOnly = bearing.filter((r) => !r.id && r.looseId);
  say(`      rows where a LOOSER regex would find one    ${looseOnly.length}`);

  const byId = new Map();
  withId.forEach((r) => { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r); });
  say(`      unique PMS resident IDs                     ${byId.size}`);
  const multi = [...byId.entries()].filter(([, v]) => v.length > 1);
  say(`      IDs appearing on MULTIPLE rows              ${multi.length}`);
  multi.slice(0, 6).forEach(([id, v]) =>
    say(`          ${id}  ×${v.length}  ${v.map((x) => x.unit + "/" + (x.room || "-") + " " + x.section).join("  ")}`));
  const bothSections = multi.filter(([, v]) => new Set(v.map((x) => x.section)).size > 1);
  say(`      IDs appearing in BOTH current and future    ${bothSections.length}`);
  bothSections.slice(0, 6).forEach(([id, v]) =>
    say(`          ${id}  ${v.map((x) => x.section + ":" + x.unit + "/" + (x.room || "-")).join("  ")}`));

  const idNameConflict = multi.filter(([, v]) => new Set(v.map((x) => x.name.toLowerCase())).size > 1);
  say(`      same PMS ID with DIFFERENT display names    ${idNameConflict.length}`);
  idNameConflict.slice(0, 6).forEach(([id, v]) =>
    say(`          ${id}  ${[...new Set(v.map((x) => x.name))].join("  |  ")}`));

  const byName = new Map();
  withId.forEach((r) => { const k = r.name.toLowerCase(); if (!byName.has(k)) byName.set(k, new Set()); byName.get(k).add(r.id); });
  const nameMultiId = [...byName.entries()].filter(([, s]) => s.size > 1);
  say(`      duplicate display names w/ DIFFERENT IDs    ${nameMultiId.length}`);
  nameMultiId.slice(0, 6).forEach(([n, s]) => say(`          ${n}  ->  ${[...s].join(", ")}`));

  const nameSameIdDiff = [...byName.entries()].filter(([, s]) => s.size === 1)
    .filter(([n]) => withId.filter((r) => r.name.toLowerCase() === n).length > 1);
  say(`      same name + same single ID on >1 row        ${nameSameIdDiff.length}`);

  say("");
  say("      ROOM / UNIT and LEASE-DATE change across artifacts: NOT MEASURABLE.");
  say("      Only one ID-bearing Skyline artifact exists. Stated, not estimated.");

  // ══ THE 04/30 TRANSCRIPTION ════════════════════════════════════════
  head("4. SKYLINE 04/30 — the second dated artifact");
  const oldSky = require("../seeds/data_skyline.js");
  const oldRows = [].concat(oldSky.CURRENT || [], oldSky.FUTURE || []);
  const oldNamed = oldRows.filter((r) => r[3]);
  const oldWithId = oldNamed.filter((r) => ID_TOKEN.test(String(r[3])));
  say(`      named rows                                  ${oldNamed.length}`);
  say(`      rows carrying any id-shaped token           ${oldWithId.length}`);
  say(`      -> the 04/30 TRANSCRIPTION carries NO resident IDs at all.`);
  say(`         Whether the 04/30 SOURCE carried them is unknown: the`);
  say(`         transcription may have dropped them. Do not conclude the`);
  say(`         export format changed.`);
  const skyNames = new Set(withId.map((r) => r.name.toLowerCase()));
  const carriedOver = oldNamed.filter((r) => skyNames.has(String(r[3]).toLowerCase()));
  say(`      names present in BOTH 04/30 and 07/31       ${carriedOver.length}`);
  say(`      -> these are the humans whose identity we would most want to`);
  say(`         carry across imports, and the only evidence linking them is`);
  say(`         the display name — which we have ruled is not identity.`);

  // ══ NAMESPACE — a DIFFERENT property ═══════════════════════════════
  head("5. NAMESPACE — the same identifier space at another property?");
  const solo = require("../seeds/data_solo.js");
  const soloRows = (solo.ROWS || []).filter((r) => r.resident_id && !/^(vacant|model|down)$/i.test(String(r.resident_id)));
  say(`      Solo (${solo.source_file || "seed"}) resident-bearing rows   ${soloRows.length}`);
  const soloIdCol = soloRows.length ? "resident_id (a DEDICATED COLUMN)" : "none";
  say(`      Solo carries its id in:                     ${soloIdCol}`);
  say(`      Skyline carries its id in:                  the display-name string`);
  say("      -> SAME VENDOR, TWO EXPORT SHAPES. The parser cannot assume either.");

  const soloIds = new Set(soloRows.map((r) => String(r.resident_id).trim()));
  const skyIds = new Set([...byId.keys()]);
  const prefix = (s) => { const m = String(s).match(/^([A-Za-z]+)/); return m ? m[1] : "?"; };
  const soloPrefixes = new Map(); soloIds.forEach((i) => soloPrefixes.set(prefix(i), (soloPrefixes.get(prefix(i)) || 0) + 1));
  const skyPrefixes = new Map(); skyIds.forEach((i) => skyPrefixes.set(prefix(i), (skyPrefixes.get(prefix(i)) || 0) + 1));
  say(`      Solo    id prefixes: ${[...soloPrefixes].map(([p, n]) => p + "×" + n).join(", ")}`);
  say(`      Skyline id prefixes: ${[...skyPrefixes].map(([p, n]) => p + "×" + n).join(", ")}`);

  const collide = [...skyIds].filter((i) => soloIds.has(i));
  say("");
  say(`      LITERAL COLLISIONS between the two properties: ${collide.length}`);
  if (collide.length) collide.slice(0, 10).forEach((i) => {
    const s = withId.find((r) => r.id === i), o = soloRows.find((r) => String(r.resident_id).trim() === i);
    say(`          ${i}   Skyline: ${s.name}   |   Solo: ${o.resident || o.resident_name}`);
  });
  const soloNums = new Set([...soloIds].map((i) => String(i).replace(/^[A-Za-z]+/, "")));
  const skyNums = [...skyIds].map((i) => String(i).replace(/^[A-Za-z]+/, ""));
  const numCollide = skyNums.filter((n) => soloNums.has(n));
  say(`      NUMERIC-PART collisions (prefix ignored):    ${numCollide.length}`);
  if (numCollide.length) say(`          e.g. ${numCollide.slice(0, 8).join(", ")}`);
  say("");
  say("      Solo and Skyline are DIFFERENT PROPERTIES in the same portfolio,");
  say("      exported from the same vendor. What collides here is the strongest");
  say("      available local evidence about how wide the namespace really is.");

  // ══ THE TWO PARSERS ════════════════════════════════════════════════
  head("6. THE TWO PARSERS, ON THE SAME INPUT");
  const probe = { unit: "101", resident: "Jordan Vale (s0005738)", "lease from": "8/3/2026" };
  const fm = mapRows([probe]).mapped[0];
  const nr = snap.normalizeRow({ unit: "101", resident: "Jordan Vale (s0005738)" });
  say(`      rent_roll_field_map     name=${JSON.stringify(fm.name)}  resident_id=${JSON.stringify(fm.resident_id)}`);
  say(`      snapshot_loader         name=${JSON.stringify(nr.name)}  resident_id=${JSON.stringify(nr.resident_id)}`);
  const probeSolo = { unit: "203", resident_id: "t0005459", resident: "Sungmin Choi" };
  const fm2 = mapRows([probeSolo]).mapped[0];
  const nr2 = snap.normalizeRow(probeSolo);
  say("");
  say(`      Solo shape (id in its own column):`);
  say(`      rent_roll_field_map     name=${JSON.stringify(fm2.name)}  resident_id=${JSON.stringify(fm2.resident_id)}`);
  say(`      snapshot_loader         name=${JSON.stringify(nr2.name)}  resident_id=${JSON.stringify(nr2.resident_id)}`);

  say("");
  say("════════════════════════════════════════════════════════════════════");
  process.exit(0);
})().catch((e) => { console.error("STUDY ERROR", e); process.exit(1); });
