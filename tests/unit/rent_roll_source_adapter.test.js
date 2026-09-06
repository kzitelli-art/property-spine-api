#!/usr/bin/env node
"use strict";

/*
 * Pure contract proof for the retained-byte rent-roll adapter.
 *
 * Fixtures are generated in memory and contain no real property or resident
 * data.  The adapter interprets bytes only; mapRows remains the sole owner of
 * source-header meaning and canonical field shaping.
 */
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const { parseRentRollSource } = require("../../src/onboarding/rent_roll_source_adapter.js");
const { mapRows } = require("../../src/onboarding/rent_roll_field_map.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.stack || error}`);
    process.exitCode = 1;
  }
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code,
    `expected refusal code ${code}`);
}

const HEADER_1 = [
  "Unit", "Room", "Unit/Room", "Resident", "Total", "Sq Ft", "Market",
  "Actual", "Resident", "Other", "Move", "Lease", "Lease", "Move", "Balance",
];
const HEADER_2 = [
  null, null, "Type", null, "Beds", null, "Rent", "Rent", "Deposit", "Deposit",
  "In", "From", "To", "Out", null,
];
const JOINED_HEADERS = [
  "Unit", "Room", "Unit/Room Type", "Resident", "Total Beds", "Sq Ft",
  "Market Rent", "Actual Rent", "Resident Deposit", "Other Deposit", "Move In",
  "Lease From", "Lease To", "Move Out", "Balance",
];

function standardGrid({ asOf = "07/31/2026", title = "Arbitrary Synthetic Source" } = {}) {
  return [
    ["Rent Roll"],
    [title],
    [`As Of = ${asOf}`],
    ["Month Year = 07/2026"],
    ["Summarize By = Room"],
    HEADER_1,
    HEADER_2,
    ["Current/Notice/Vacant Residents"],
    ["A-101", "Room1", "Studio", "Example Current (r0001001)", 1, 420, 1000, null,
      500, 0, "07/01/2026", "07/01/2026", "06/30/2027", null, 0],
    ["A-101", "Room2", "Studio", "VACANT", 1, 420, 900, null,
      0, 0, null, null, null, null, 0],
    [null, null, null, null, null, "MARKET RENT", "1,900.00", "800.00", "500.00"],
    [null, null, null, null, null, "VACANT", "1,900.00"],
    [],
    ["Future Residents/Applicants"],
    ["A-101", "Room1", "Studio", "Example Successor (r0001002)", 1, 420, 1100, null,
      600, 0, "08/15/2026", "08/15/2026", "07/31/2027", null, 0],
    [null, null, null, "Example Applicant (r0001003)", null, null, null, null,
      300, 0, null, null, null, null, 0],
    ["Total: Arbitrary Synthetic Source", null, null, null, 2, 840, 3000, 0,
      1400, 0, null, null, null, null, 0],
    [],
    ["Summary Groups", null, null, null, null, null, "Square", "Market", "Actual"],
    ["Future Residents/Applicants", null, null, null, null, null, "N/A", "N/A", 0],
  ];
}

function workbookBuffer(sheets, bookType = "xlsx") {
  const workbook = XLSX.utils.book_new();
  for (const [name, grid] of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(grid), name);
  }
  return XLSX.write(workbook, { type: "buffer", bookType });
}

function standardBuffer(options = {}, bookType = "xlsx") {
  return workbookBuffer([["Report1", standardGrid(options)]], bookType);
}

test("standard two-row XLSX preserves source rows, sections, date, and joined headers", () => {
  const parsed = parseRentRollSource({
    buffer: standardBuffer(),
    filename: "synthetic-source.xlsx",
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  assert.equal(parsed.format, "xlsx");
  assert.equal(parsed.sheet_name, "Report1");
  assert.equal(parsed.source_as_of_date, "2026-07-31");
  assert.equal(parsed.rows.length, 4, "totals and summary rows are not source records");
  assert.deepEqual(parsed.rows.map((row) => row.__row_number), [9, 10, 15, 16]);
  assert.deepEqual(parsed.rows.map((row) => row.__section),
    ["current", "current", "future", "future"]);
  assert.deepEqual(Object.keys(parsed.rows[0]).filter((key) => !key.startsWith("__")), JOINED_HEADERS);
  assert.equal(parsed.rows[2].Unit, "A-101", "future assignment retains its spatial source value");
  assert.equal(parsed.rows[3].Unit, null, "unassigned future applicant remains unassigned");
  assert.equal(parsed.rows[3].Resident, "Example Applicant (r0001003)");

  const hostile = standardGrid();
  hostile.splice(9, 0,
    [null, null, null, null, null, "99.00", "$88.00", "(77.00)", "66.00"]);
  const retained = parseRentRollSource({
    buffer: workbookBuffer([["Report1", hostile]]), filename: "unidentified-row.xlsx",
  });
  assert.equal(retained.rows.length, 5, "an in-body unidentified numeric row remains evidence");
  assert.equal(retained.rows[1].__row_number, 10);
  assert.equal(retained.rows[1]["Sq Ft"], "99.00");
});

test("normal CSV defaults to current and preserves quoted cells and logical row numbers", () => {
  const csv = Buffer.from(
    "Unit,Tenant,Market Rent,Actual Rent\r\n" +
    'B-1,"Example, One",1200,\r\n' +
    ",,1400,\r\n" +
    "Total:,Example Two,1300,0\r\n",
    "utf8");
  const parsed = parseRentRollSource({ buffer: csv, filename: "ordinary.csv", mime_type: "text/csv" });

  assert.equal(parsed.format, "csv");
  assert.equal(parsed.sheet_name, null);
  assert.equal(parsed.source_as_of_date, null);
  assert.equal(parsed.rows.length, 3, "a CSV row containing only rent remains reviewable evidence");
  assert.deepEqual(parsed.rows.map((row) => row.__row_number), [2, 3, 4]);
  assert(parsed.rows.every((row) => row.__section === "current"));
  assert.equal(parsed.rows[0].Tenant, "Example, One");
  assert.equal(parsed.rows[1]["Market Rent"], "1400");
  assert.equal(parsed.rows[2].Unit, "Total:", "a populated data row is not mistaken for a footer");
});

test("normal CSV may transition from implicit current rows to an explicit future section", () => {
  const csv = Buffer.from(
    "Unit,Room,Tenant,Market Rent,Actual Rent\n" +
    "F-1,Room1,Example Current,900,800\n" +
    "Future Residents/Applicants,,,,\n" +
    "F-1,Room1,Example Successor,950,\n" +
    ",,Example Applicant,,\n",
    "utf8");
  const parsed = parseRentRollSource({ buffer: csv, filename: "current-then-future.csv" });

  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows.map((row) => row.__row_number), [2, 4, 5]);
  assert.deepEqual(parsed.rows.map((row) => row.__section), ["current", "future", "future"]);
  assert.equal(parsed.rows[1].Unit, "F-1");
  assert.equal(parsed.rows[2].Unit, null);
  assert.equal(parsed.rows[2].Tenant, "Example Applicant");
});

test("the installed SheetJS reader admits genuine XLS bytes", () => {
  const parsed = parseRentRollSource({
    buffer: standardBuffer({}, "biff8"),
    filename: "synthetic-source.xls",
    mime_type: "application/vnd.ms-excel",
  });
  assert.equal(parsed.format, "xls");
  assert.equal(parsed.sheet_name, "Report1");
  assert.equal(parsed.rows.length, 4);
});

test("mapRows preserves section and resident source code without filling actual rent", () => {
  const parsed = parseRentRollSource({ buffer: standardBuffer(), filename: "synthetic-source.xlsx" });
  const mapped = mapRows(parsed.rows).mapped;

  assert.equal(mapped[0].section, "current");
  assert.equal(mapped[0].name, "Example Current");
  assert.equal(mapped[0].resident_id, "r0001001");
  assert.equal(mapped[0].resident_id_source, "embedded_in_name");
  assert.equal(mapped[0].market_rent, 1000);
  assert.equal(mapped[0].actual_rent, null);
  assert.equal(mapped[0].rent ?? null, null, "asking rent must not become contract rent");
  assert.equal(mapped[0]._raw.Resident, "Example Current (r0001001)");

  assert.equal(mapped[2].section, "future");
  assert.equal(mapped[2].resident_id, "r0001002");
  assert.equal(mapped[3].section, "future");
  assert.equal(mapped[3].unit_number, null);
});

test("literal zero actual rent survives as a known source value", () => {
  const csv = Buffer.from("Unit,Tenant,Market Rent,Actual Rent\nC-1,Example Zero,800,0\n");
  const parsed = parseRentRollSource({ buffer: csv, filename: "zero.csv" });
  const row = mapRows(parsed.rows).mapped[0];
  assert.equal(row.actual_rent, 0);
  assert.equal(row.rent, 0);
});

test("source columns cannot spoof adapter metadata", () => {
  for (const reserved of ["__section", "__row_number", "__source_override"]) {
    const csv = Buffer.from(`Unit,Tenant,Rent,${reserved}\nD-1,Example Resident,700,future\n`);
    throwsCode(() => parseRentRollSource({ buffer: csv, filename: "spoof.csv" }),
      "reserved_source_header");
  }
});

test("two supported sheets refuse rather than choosing one", () => {
  const buffer = workbookBuffer([
    ["First", standardGrid({ title: "First Synthetic Source" })],
    ["Second", standardGrid({ title: "Second Synthetic Source" })],
  ]);
  throwsCode(() => parseRentRollSource({ buffer, filename: "ambiguous.xlsx" }),
    "ambiguous_rent_roll_sheet");
});

test("two supported tables in one sheet refuse rather than choosing one", () => {
  const first = standardGrid();
  const second = standardGrid({ title: "Second Synthetic Source" });
  const buffer = workbookBuffer([["Report1", [...first, [], ...second]]]);
  throwsCode(() => parseRentRollSource({ buffer, filename: "two-tables.xlsx" }),
    "ambiguous_rent_roll_header");
});

test("conflicting or invalid content dates refuse", () => {
  const conflicting = standardGrid();
  conflicting.splice(3, 0, ["As Of = 08/31/2026"]);
  throwsCode(() => parseRentRollSource({
    buffer: workbookBuffer([["Report1", conflicting]]), filename: "conflicting-date.xlsx",
  }), "ambiguous_source_as_of_date");

  throwsCode(() => parseRentRollSource({
    buffer: standardBuffer({ asOf: "2026/31/07" }), filename: "invalid-date.xlsx",
  }), "invalid_source_as_of_date");
});

test("unknown and contradictory section structures refuse", () => {
  const unknown = standardGrid();
  unknown.splice(9, 0, ["Renewal Residents"]);
  throwsCode(() => parseRentRollSource({
    buffer: workbookBuffer([["Report1", unknown]]), filename: "unknown-section.xlsx",
  }), "unsupported_section");

  const reversed = standardGrid();
  reversed.splice(12, 0, ["Current/Notice/Vacant Residents"]);
  throwsCode(() => parseRentRollSource({
    buffer: workbookBuffer([["Report1", reversed]]), filename: "reversed-sections.xlsx",
  }), "unsupported_section_order");
});

test("duplicate headers, unsupported headers, formats, and corrupt workbooks refuse explicitly", () => {
  throwsCode(() => parseRentRollSource({
    buffer: Buffer.from("Unit,Unit,Tenant\nE-1,E-2,Example Resident\n"),
    filename: "duplicates.csv",
  }), "duplicate_source_header");

  throwsCode(() => parseRentRollSource({
    buffer: Buffer.from("Building,Amount\nOne,10\n"), filename: "not-a-rent-roll.csv",
  }), "unsupported_rent_roll_header");

  throwsCode(() => parseRentRollSource({ buffer: Buffer.from("%PDF-1.4"), filename: "source.pdf" }),
    "unsupported_source_format");
  throwsCode(() => parseRentRollSource({ buffer: Buffer.from("not a workbook"), filename: "broken.xlsx" }),
    "unreadable_source");
});

process.on("exit", () => {
  if (!process.exitCode) console.log(`${passed} retained-byte adapter tests passed`);
});
