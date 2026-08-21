"use strict";

// Nationwide legal public holidays from 5 U.S.C. 6103, with the standard
// Monday-Friday observed-day rule published by OPM. Skyline closes on both the
// legal calendar date and its observed weekday when those differ because
// Saturday is otherwise a tour day.

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function fixedDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function nthWeekday(year, monthIndex, weekday, occurrence) {
  const first = fixedDate(year, monthIndex, 1);
  const day = 1 + ((7 + weekday - first.getUTCDay()) % 7) + ((occurrence - 1) * 7);
  return fixedDate(year, monthIndex, day);
}

function lastWeekday(year, monthIndex, weekday) {
  const last = fixedDate(year, monthIndex + 1, 0);
  const day = last.getUTCDate() - ((7 + last.getUTCDay() - weekday) % 7);
  return fixedDate(year, monthIndex, day);
}

function legalFederalHolidays(year) {
  return [
    { name: "New Year's Day", date: fixedDate(year, 0, 1), observed: true },
    { name: "Birthday of Martin Luther King, Jr.", date: nthWeekday(year, 0, 1, 3) },
    { name: "Washington's Birthday", date: nthWeekday(year, 1, 1, 3) },
    { name: "Memorial Day", date: lastWeekday(year, 4, 1) },
    { name: "Juneteenth National Independence Day", date: fixedDate(year, 5, 19), observed: true },
    { name: "Independence Day", date: fixedDate(year, 6, 4), observed: true },
    { name: "Labor Day", date: nthWeekday(year, 8, 1, 1) },
    { name: "Columbus Day", date: nthWeekday(year, 9, 1, 2) },
    { name: "Veterans Day", date: fixedDate(year, 10, 11), observed: true },
    { name: "Thanksgiving Day", date: nthWeekday(year, 10, 4, 4) },
    { name: "Christmas Day", date: fixedDate(year, 11, 25), observed: true },
  ];
}

function observedDate(holiday) {
  const out = new Date(holiday.date);
  if (!holiday.observed) return out;
  if (out.getUTCDay() === 6) out.setUTCDate(out.getUTCDate() - 1);
  else if (out.getUTCDay() === 0) out.setUTCDate(out.getUTCDate() + 1);
  return out;
}

function federalHolidayClosures(year) {
  const closures = new Map();
  for (const sourceYear of [year - 1, year, year + 1]) {
    for (const holiday of legalFederalHolidays(sourceYear)) {
      for (const [date, suffix] of [[holiday.date, "legal"], [observedDate(holiday), "observed"]]) {
        if (date.getUTCFullYear() !== year) continue;
        const key = isoDate(date);
        const label = suffix === "observed" && isoDate(date) !== isoDate(holiday.date)
          ? `${holiday.name} (observed)`
          : holiday.name;
        if (!closures.has(key)) closures.set(key, label);
      }
    }
  }
  return closures;
}

function federalHolidayClosure(dateString) {
  if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
  const year = Number(dateString.slice(0, 4));
  return federalHolidayClosures(year).get(dateString) || null;
}

module.exports = { federalHolidayClosure, federalHolidayClosures, legalFederalHolidays, observedDate };
