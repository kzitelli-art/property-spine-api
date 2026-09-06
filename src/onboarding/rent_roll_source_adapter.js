"use strict";

/*
 * Retained rent-roll bytes -> source rows.
 *
 * This adapter owns file shape only: workbook sheets, header rows, structural
 * sections, source row numbers and the content's own as-of date.  It does not
 * decide what a source column means.  Header recognition is delegated to the
 * existing rent_roll_field_map vocabulary, and the returned rows retain those
 * source headers unchanged for mapRows and for row-level evidence.
 */
const path = require("node:path");
const XLSX = require("xlsx");
const { planFor, fieldForHeader } = require("./rent_roll_field_map.js");

const CURRENT_HEADING = "current/notice/vacant residents";
const FUTURE_HEADING = "future residents/applicants";
const SUPPORTED = new Set(["csv", "xlsx", "xls"]);

function refusal(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function text(value) {
  return value == null ? "" : String(value).trim().replace(/\s+/g, " ");
}

function nonblankCells(row) {
  const cells = [];
  for (let index = 0; index < (row || []).length; index += 1) {
    if (text(row[index])) cells.push({ index, value: text(row[index]) });
  }
  return cells;
}

function soleFirstCell(row, expected) {
  const cells = nonblankCells(row);
  return cells.length === 1 && cells[0].index === 0 && cells[0].value.toLowerCase() === expected;
}

function sourceFormat(filename) {
  const ext = path.extname(String(filename || "")).slice(1).toLowerCase();
  if (!SUPPORTED.has(ext)) {
    throw refusal("unsupported_source_format",
      `Rent-roll interpretation supports CSV, XLSX and XLS sources; received ${ext || "no extension"}.`);
  }
  return ext;
}

function assertReadableBytes(buffer, format) {
  if (!Buffer.isBuffer(buffer)) {
    if (buffer instanceof Uint8Array) buffer = Buffer.from(buffer);
    else throw refusal("unreadable_source", "The retained source is not a byte buffer.");
  }
  if (buffer.length === 0) throw refusal("unreadable_source", "The retained source is empty.");

  const zip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
    [[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].some(([a, b]) => buffer[2] === a && buffer[3] === b);
  const ole = buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if ((format === "xlsx" && !zip) || (format === "xls" && !ole)) {
    throw refusal("unreadable_source", `The retained bytes are not a readable ${format.toUpperCase()} workbook.`);
  }
  if (format === "csv" && buffer.includes(0)) {
    throw refusal("unreadable_source", "The retained CSV contains binary bytes.");
  }
  return buffer;
}

function gridFromSheet(sheet) {
  const ref = sheet && sheet["!ref"];
  if (!ref) return { grid: [], firstRow: 0 };
  const range = XLSX.utils.decode_range(ref);
  return {
    grid: XLSX.utils.sheet_to_json(sheet, {
      header: 1, defval: null, blankrows: true, raw: false, range,
    }),
    firstRow: range.s.r,
  };
}

function readWorkbook(buffer, format) {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
    if (!workbook || !Array.isArray(workbook.SheetNames) || workbook.SheetNames.length === 0) {
      throw new Error("workbook has no sheets");
    }
    return workbook;
  } catch (error) {
    throw refusal("unreadable_source", `The retained ${format.toUpperCase()} source could not be read.`,
      { cause: error });
  }
}

function joinedHeaders(first, second = null) {
  const width = Math.max((first || []).length, (second || []).length);
  const headers = [];
  for (let index = 0; index < width; index += 1) {
    const parts = [text(first && first[index]), text(second && second[index])].filter(Boolean);
    headers.push(parts.join(" "));
  }
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  return headers;
}

function inspectHeaders(headers) {
  if (!headers.length || headers.some((header) => !header)) {
    return { supported: false, reason: "blank" };
  }
  const reserved = headers.find((header) => header.startsWith("__"));
  const seen = new Set();
  const duplicate = headers.find((header) => {
    const key = header.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  const object = Object.fromEntries(headers.map((header) => [header, null]));
  const plan = planFor([object]);
  const fields = new Set(headers.map(fieldForHeader).filter(Boolean));
  const headerLike = fields.has("unit_number") && (fields.has("name") || fields.has("status"));
  return {
    supported: headerLike && !reserved && !duplicate,
    headerLike,
    reserved: reserved || null,
    duplicate: duplicate || null,
    plan,
  };
}

function spreadsheetCandidates(grid) {
  const candidates = [];
  for (let index = 0; index + 2 < grid.length; index += 1) {
    // The supported standard spreadsheet shape explicitly has a split header
    // followed by the current-residents structural heading.  This avoids a
    // fuzzy "best looking row" choice and prevents the partially meaningful
    // first header row from competing with its complete two-row form.
    if (!soleFirstCell(grid[index + 2], CURRENT_HEADING)) continue;
    const headers = joinedHeaders(grid[index], grid[index + 1]);
    const inspected = inspectHeaders(headers);
    if (inspected.supported) {
      candidates.push({ headerStart: index, headerEnd: index + 1,
        rowsStart: index + 2, headers, plan: inspected.plan, shape: "standard_split" });
    }
  }
  return candidates;
}

function csvCandidates(grid) {
  const candidates = [];
  let malformed = null;
  for (let index = 0; index < grid.length; index += 1) {
    const headers = joinedHeaders(grid[index]);
    const inspected = inspectHeaders(headers);
    if (inspected.headerLike && inspected.reserved) {
      malformed = malformed || refusal("reserved_source_header",
        `Source header ${inspected.reserved} is reserved for adapter metadata.`);
      continue;
    }
    if (inspected.headerLike && inspected.duplicate) {
      malformed = malformed || refusal("duplicate_source_header",
        `Source header ${inspected.duplicate} occurs more than once.`);
      continue;
    }
    if (inspected.supported) {
      candidates.push({ headerStart: index, headerEnd: index,
        rowsStart: index + 1, headers, plan: inspected.plan, shape: "csv_header" });
    }
  }
  if (!candidates.length && malformed) throw malformed;
  return candidates;
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseDate(value) {
  const source = text(value);
  let match = source.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match.map(Number);
    return validDate(year, month, day) ? source : null;
  }
  match = source.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match.map(Number);
  if (!validDate(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function sourceDate(grid, beforeIndex) {
  const found = new Set();
  for (let rowIndex = 0; rowIndex < beforeIndex; rowIndex += 1) {
    for (const value of grid[rowIndex] || []) {
      const match = text(value).match(/^as of\s*=\s*(.+)$/i);
      if (!match) continue;
      const parsed = parseDate(match[1]);
      if (!parsed) {
        throw refusal("invalid_source_as_of_date", `The source As Of value is not a valid calendar date.`);
      }
      found.add(parsed);
    }
  }
  if (found.size > 1) {
    throw refusal("ambiguous_source_as_of_date", "The source contains conflicting As Of dates.");
  }
  return found.size ? [...found][0] : null;
}

function fieldIndex(headers, plan, field) {
  const header = plan && plan.mapped && plan.mapped[field];
  return header == null ? -1 : headers.indexOf(header);
}

function isTotalFooter(row, headers, plan) {
  const first = text(row && row[0]);
  if (!/^total:\s+\S/i.test(first)) return false;
  const nameIndex = fieldIndex(headers, plan, "name");
  const statusIndex = fieldIndex(headers, plan, "status");
  if ((nameIndex >= 0 && text(row[nameIndex])) || (statusIndex >= 0 && text(row[statusIndex]))) {
    return false;
  }
  return (row || []).slice(1).some((value) => text(value));
}

function numericSourceValue(value) {
  const source = text(value);
  if (!source) return false;
  return /^-?\$?\s*\d[\d,]*(?:\.\d+)?$/.test(source) ||
    /^\(\s*\$?\s*\d[\d,]*(?:\.\d+)?\s*\)$/.test(source);
}

function isNumericSubtotalShape(row, headers, plan) {
  const cells = nonblankCells(row);
  if (!cells.length) return false;

  // The standard report places section subtotals before the future heading.
  // They have no spatial or resident identity and populate only numeric fact
  // columns.  Match that complete shape: an unassigned applicant still has a
  // resident cell, and a real unit row still has a unit/room/status identity.
  const numericFields = new Set([
    "sqft", "market_rent", "actual_rent", "deposit", "other", "balance",
  ]);
  const numericColumns = new Set();
  for (const field of numericFields) {
    const index = fieldIndex(headers, plan, field);
    if (index >= 0) numericColumns.add(index);
  }
  if (!numericColumns.size || !cells.every(({ index }) => numericColumns.has(index))) return false;

  const nonnumeric = cells.filter(({ value }) => !numericSourceValue(value));
  if (!nonnumeric.length) return true;
  const labels = new Set(["market rent", "vacant"]);
  return nonnumeric.length === 1 && nonnumeric[0] === cells[0] &&
    nonnumeric[0].index === fieldIndex(headers, plan, "sqft") &&
    labels.has(nonnumeric[0].value.toLowerCase()) && cells.length > 1;
}

function isTerminalNumericSubtotal(grid, index, candidate) {
  if (candidate.shape !== "standard_split" ||
      !isNumericSubtotalShape(grid[index], candidate.headers, candidate.plan)) return false;

  // A numeric-only row is structural only as part of the terminal subtotal
  // block supported by this report shape. The same row inside the evidence,
  // or in an ordinary CSV, remains evidence for review.
  for (let cursor = index + 1; cursor < grid.length; cursor += 1) {
    const row = grid[cursor] || [];
    if (!nonblankCells(row).length ||
        isNumericSubtotalShape(row, candidate.headers, candidate.plan)) continue;
    return soleFirstCell(row, FUTURE_HEADING) ||
      text(row[0]).toLowerCase() === "summary groups" ||
      isTotalFooter(row, candidate.headers, candidate.plan);
  }
  return true;
}

function rowsFromCandidate(grid, firstRow, candidate) {
  const rows = [];
  let section = "current";
  let sawData = false;
  let sawCurrentHeading = false;
  let sawFutureHeading = false;

  for (let index = candidate.rowsStart; index < grid.length; index += 1) {
    const source = grid[index] || [];
    const cells = nonblankCells(source);
    if (!cells.length) continue;

    if (soleFirstCell(source, CURRENT_HEADING)) {
      if (sawCurrentHeading || sawData || sawFutureHeading) {
        throw refusal("unsupported_section_order", "The current section appears out of order or more than once.");
      }
      sawCurrentHeading = true;
      section = "current";
      continue;
    }
    if (soleFirstCell(source, FUTURE_HEADING)) {
      if (sawFutureHeading) {
        throw refusal("unsupported_section_order", "The future section appears more than once.");
      }
      sawFutureHeading = true;
      section = "future";
      continue;
    }

    if (text(source[0]).toLowerCase() === "summary groups" ||
        isTotalFooter(source, candidate.headers, candidate.plan)) {
      break;
    }

    if (isTerminalNumericSubtotal(grid, index, candidate)) continue;

    // A sole first-column label inside the table has no supported meaning.
    // Treating it as a unit-only record or silently skipping it would both be
    // guesses, so the adapter names the unsupported section instead.
    if (cells.length === 1 && cells[0].index === 0) {
      throw refusal("unsupported_section", `Unsupported rent-roll section: ${cells[0].value}.`);
    }

    const row = {};
    for (let column = 0; column < candidate.headers.length; column += 1) {
      row[candidate.headers[column]] = source[column] == null ? null : source[column];
    }
    row.__row_number = firstRow + index + 1;
    row.__section = section;
    rows.push(row);
    sawData = true;
  }
  return rows;
}

function parseRentRollSource({ buffer, filename, mime_type: _mimeType = null } = {}) {
  const format = sourceFormat(filename);
  const bytes = assertReadableBytes(buffer, format);
  const workbook = readWorkbook(bytes, format);
  const sheets = [];

  for (const sheetName of workbook.SheetNames) {
    const { grid, firstRow } = gridFromSheet(workbook.Sheets[sheetName]);
    const candidates = format === "csv" ? csvCandidates(grid) : spreadsheetCandidates(grid);
    if (candidates.length > 1) {
      throw refusal("ambiguous_rent_roll_header",
        `Sheet ${sheetName} contains more than one supported rent-roll table.`);
    }
    if (candidates.length === 1) sheets.push({ sheetName, grid, firstRow, candidate: candidates[0] });
  }

  if (sheets.length > 1) {
    throw refusal("ambiguous_rent_roll_sheet", "More than one sheet contains a supported rent-roll table.");
  }
  if (!sheets.length) {
    throw refusal("unsupported_rent_roll_header", "No supported rent-roll header was found in the retained source.");
  }

  const chosen = sheets[0];
  const rows = rowsFromCandidate(chosen.grid, chosen.firstRow, chosen.candidate);
  return {
    rows,
    source_as_of_date: sourceDate(chosen.grid, chosen.candidate.headerStart),
    format,
    sheet_name: format === "csv" ? null : chosen.sheetName,
  };
}

module.exports = { parseRentRollSource };
