// ════════════════════════════════════════════════════════════════════
//  maintenance_urgency.js — the NARROW urgency decision for tenant-
//  submitted maintenance. NOT general interpretation: the resident has
//  already declared "this is maintenance" by opening the form. The only
//  decision is safety urgency, over a FIXED emergency-signal list.
//
//  Output: { urgency: 'emergency'|'regular'|'needs_confirmation',
//            basis, emergency_type|null, clarifying_question|null }
//
//  Doctrine: narrowest SAFE decision.
//    · a STRONG emergency signal → emergency (the resident cannot downgrade it)
//    · only an AMBIGUOUS signal, no strong → needs_confirmation (ask ONE question)
//    · neither → regular
//  Never silently drop to regular on ambiguity; never cry emergency on ambiguity.
//  emergency_type aligns with the operator EMERGENCY_TYPES vocabulary so a tenant
//  emergency opens the SAME kind of work order + obligation as an operator one.
// ════════════════════════════════════════════════════════════════════
function classifyUrgency(text) {
  const t = (text || "").toLowerCase();
  const has = (re) => re.test(t);
  const E = (emergency_type, basis) => ({ urgency: "emergency", basis, emergency_type, clarifying_question: null });
  const R = (basis) => ({ urgency: "regular", basis, emergency_type: null, clarifying_question: null });
  const Q = (basis, q) => ({ urgency: "needs_confirmation", basis, emergency_type: null, clarifying_question: q });

  // ── STRONG emergency signals (fixed list) ────────────────────────
  // Smoke/fire-ALARM nuisance (the device) vs actual smoke/fire. Check the
  // nuisance first: a chirping "smoke alarm" is not a fire — but any active
  // word (coming/smell/flames/burning) makes it real again.
  if (has(/(smoke|fire)\s*(alarm|detector)/) && has(/chirp|beep|low\s*batt|battery|won'?t\s*stop|keeps\s*going/) &&
      !has(/coming|smell|flames?|burning|actual\s*(smoke|fire)/))
    return Q("smoke/fire-alarm nuisance vs real alarm",
             "Is there any actual smoke or fire, or is the alarm just chirping/beeping (e.g. low battery)?");
  // fire / smoke (exclude obvious non-emergency 'fireplace')
  if (has(/\bsmoke\b/) || has(/\bflames?\b/) || (has(/\bfire\b/) && !has(/fireplace|fire ?pit/)))
    return E("fire_life_safety", "fire/smoke reported");
  if (has(/gas\s*(smell|leak|odou?r)|smell(s|ing)?\s*(of\s*)?gas|rotten\s*egg/))
    return E("fire_life_safety", "possible gas leak reported");
  // active water / flooding (STRONG). pouring/gushing are active by definition.
  if (has(/flood(ing|ed)?/) || has(/burst\s*pipe/) || has(/\b(pouring|gushing)\b/) ||
      has(/water\s*everywhere/) || has(/water\s*coming\s*(in|down|through)/) || has(/active\s*leak/))
    return E("active_leak", "active leak / flooding reported");
  // electrical hazard
  if (has(/spark(s|ing|ed)?/) || has(/exposed\s*(wire|wiring)/) || has(/live\s*wire/) ||
      has(/electrical\s*(fire|burning|smell)/) || has(/(getting|got)\s*shock(ed|s)?/) || has(/outlet\s*(smoking|burning|sparking)/))
    return E("electrical_hazard", "electrical hazard reported");
  // security — can't secure the unit / break-in
  if (has(/break[\s-]?in|broke\s*in|intruder|someone\s*(broke|got)\s*in/) ||
      has(/can'?t\s*(lock|secure|close)/) || has(/(door|window)\s*(won'?t|wont|can'?t)\s*(lock|close|secure)/) ||
      has(/(door|lock)\s*(is\s*)?broken/) || has(/unit\s*(isn'?t|not|won'?t)\s*secur/))
    return E("security_issue", "unit cannot be secured / break-in reported");
  // sewage
  if (has(/sewage|sewer\s*back|raw\s*sewage/) || (has(/toilet/) && has(/overflow/) && has(/floor|everywhere/)))
    return E("sewer_backup", "sewage backup reported");
  // explicit immediate danger / major active property damage
  if (has(/immediate\s*danger|someone('?s)?\s*(hurt|in\s*danger)|ceiling\s*(is\s*)?(falling|collapsed|caving)/))
    return E("fire_life_safety", "immediate danger / major active damage reported");

  // ── AMBIGUOUS signals → ask ONE clarifying question ──────────────
  if (has(/leak|drip/) && !has(/slow|minor|small/))
    return Q("leak reported without active/severity detail",
             "Is water actively leaking or flooding right now, or is it a slow/minor drip?");
  if ((has(/\bsmell\b|odou?r/) ) && !has(/gas|smoke/))
    return Q("unspecified smell", "What does the smell seem to be — gas, smoke/burning, or something else?");
  if (has(/no\s*(power|electric|electricity)|power\s*(is\s*)?out|lost\s*power/))
    return Q("power out — hazard vs outage unknown",
             "Is there any sparking, burning smell, or exposed wiring — or is the power simply out?");
  if (has(/water/) && has(/ceiling|wall/) && !has(/stain|spot/))
    return Q("water at ceiling/wall — active vs stain unknown",
             "Is water actively coming in right now, or is it a stain/damp spot?");
  if (has(/(window|door)/) && has(/broken|cracked|shattered/) && !has(/secur|lock|close/))
    return Q("broken window/door — securable unknown",
             "Is your unit still securable (able to lock/close), or is it open to the outside?");

  // ── otherwise: routine ───────────────────────────────────────────
  return R("no emergency signals detected — routine request");
}
module.exports = { classifyUrgency };
