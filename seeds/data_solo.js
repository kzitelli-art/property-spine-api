// data_solo.js — combines Solo parts 1-3 into the full real rent roll
const p1 = require("./data_solo_part1.js").CURRENT;
const p2 = require("./data_solo_part2.js").CURRENT;
const p3 = require("./data_solo_part3.js");

const CURRENT = [...p1, ...p2, ...p3.CURRENT];
const FUTURE = p3.FUTURE;

module.exports = {
  property_key: "4233-CHESTNUT",
  property_match: ["solo", "4233"],
  source_file: "4233_Chesnut_RentRoll_2026_03_31.xlsx",
  source_as_of_date: "2026-03-31",
  leasing_model: "unit",
  confidence: "confirmed",
  badge: "HISTORICAL SNAPSHOT · Source: Solo Rent Roll 03/31/2026",
  CURRENT, FUTURE,
};
