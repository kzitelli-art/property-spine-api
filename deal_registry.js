// ============================================================
// deal_registry.js — the six deals, as fixed facts.
//
// Leasing model is STORED here, never inferred from a rent roll.
//   Solo, UNO            = unit
//   Greenery, Temple Nest, Skyline, 1850 = bed
//
// This is the source of truth the property surface reads to know:
//   - what to call the property
//   - whether to count by unit or by bed
//   - which canonical key / id resolves it
//   - whether a historical snapshot has been loaded (filled at runtime)
// ============================================================

const DEALS = [
  { key: "solo",      name: "Solo",        canonical_key: "4233-CHESTNUT", property_id: "9e2bb96e-08e2-41db-81c2-91055ceb50a3", model: "unit", match: ["solo","4233"] },
  { key: "uno",       name: "UNO",         canonical_key: "4125-CHESTNUT", property_id: "260b6bac-4738-47c4-b86d-511b726adc48", model: "unit", match: ["uno","4125"] },
  { key: "greenery",  name: "Greenery",    canonical_key: "1325-N-15",     property_id: null, model: "bed",  match: ["greenery","1325"] },
  { key: "templenest",name: "Temple Nest", canonical_key: "TEMPLE-NEST",   property_id: null, model: "bed",  match: ["temple nest","temple-nest","nest"] },
  { key: "skyline",   name: "Skyline",     canonical_key: "1417",          property_id: null, model: "bed",  match: ["skyline","1417"] },
  { key: "n1850",     name: "1850",        canonical_key: "1850-BERKS",    property_id: null, model: "bed",  match: ["1850","berks"] },
];

function byKey(k){ return DEALS.find(d => d.key === k) || null; }
function byPropertyId(id){ return DEALS.find(d => d.property_id === id) || null; }
function byCanonical(c){ return DEALS.find(d => d.canonical_key === c) || null; }

module.exports = { DEALS, byKey, byPropertyId, byCanonical };
