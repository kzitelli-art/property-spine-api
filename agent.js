// agent.js — AGENT STAGE A: supervised, grounded, draft-first conversation loop.
//
// THE GOVERNING PRINCIPLE: the spine (persons, events, obligations, comm_events,
// conversations, units) is the system of record. This module is the JUDGMENT +
// CONVERSATION layer on top of it. The agent PROPOSES; nothing reaches a lead until
// a human dispatches it.
//
// LOCKED INVARIANTS (from review):
//   • conversation_id is the SOLE thread identity (property/person derived).
//   • Two-transaction model call: NEVER hold a DB txn open across Anthropic.
//   • Monotonic thread_version + row locks → enforceable stale-draft guarantee.
//   • A draft exists ONLY when the model returned text. Runs own pending/failed.
//   • generated_body is IMMUTABLE; manager edits go to dispatch_body.
//   • A draft is NOT a comm_event — only DISPATCH writes an outbound comm_event.
//   • Review obligation born in TX1 → survives a crash between TX1 and the model.
//   • Manager identity is SERVER-DERIVED (seeded demo manager), never from the client.
//   • Curated facts only (agent_facts); live unit truth read from units; absence = handoff.
//   • Fair-housing = conservative risk-routing control (v1), pre- AND post-generation.
//   • No silent AI re-entry after human_takeover.
//
// Deps: { pool, anthropic, INGEST_MODEL, spawnObligationFromEvent, completeObligation }.
// Mount: app.use("/", agentModule({ pool, anthropic, INGEST_MODEL,
//          spawnObligationFromEvent, completeObligation }));

const crypto = require("crypto");

const PROMPT_REVISION = "stage-a-v5"; // v5: SOLO master rewrite — four moves (answer/redirect/defer/handoff), no-silence, dash-strip, §7 persona, tight pre-gate
const POLICY_REVISION = "stage-a-v1";

module.exports = function agentModule(deps) {
  const { pool, anthropic, INGEST_MODEL, spawnObligationFromEvent, completeObligation, leasingLifecycle, commBoundary = null, leasingBookingService = null } = deps;
  // FUNNEL-FLOW: grounded inventory discovery + governed attachment live in
  // leasing_inventory.js (Class 1). The agent gains ONE tool over it; the
  // attach fires only on the prospect's own confirming words (offered ≠ selected).
  const inventory = require("./leasing_inventory")({ pool });
  // SLICE 2: conversational prospect capture — extracts VOLUNTEERED facts from the
  // prospect's own inbound messages into person_attributes, fire-and-forget after
  // a draft is created. Fail-soft by construction (see prospect_capture.js).
  const prospectCapture = require("./prospect_capture")({ pool, anthropic, INGEST_MODEL });
  if (!pool) throw new Error("agent.js requires { pool }");
  const MODEL = INGEST_MODEL || "claude-sonnet-4-6";
  const router = require("express").Router();

  // ── helpers ──────────────────────────────────────────────────────────────
  function httpErr(status, msg, code) {
    const e = new Error(msg); e.httpStatus = status; e.publicMessage = msg; if (code) e.code = code; return e;
  }
  async function tx(fn) {
    const client = await pool.connect();
    try { await client.query("begin"); const out = await fn(client); await client.query("commit"); return out; }
    catch (e) { await client.query("rollback"); throw e; }
    finally { client.release(); }
  }
  function sha(obj) { return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex"); }

  // ── TOOL-LOOP MESSAGE-ASSEMBLY SAFETY ──────────────────────────────────────
  // THE INVARIANT THIS PROTECTS: every `tool_use` block in an assistant turn MUST
  // be immediately followed by a `tool_result` for that exact id in the next
  // (user) message, or the Anthropic API 400s the ENTIRE request
  // ("'tool_use' ids were found without 'tool_result' blocks"). Historically the
  // loop paired only the ONE tool it recognized (inventory OR offer OR book), so
  // when the model emitted a SECOND tool_use in the same turn (narrate + call,
  // or chain offer→book) the extra tool_use went unpaired → 400 → generation
  // threw → run 'failed' → silent AI. These two helpers make the pairing
  // COMPLETE and let the loop detect an unresolved chain. Pure; no I/O.

  // Does this assistant content array contain any tool_use block?
  function hasToolUse(content) {
    return Array.isArray(content) && content.some(x => x && x.type === "tool_use");
  }

  // Build the tool_result content array that pairs EVERY tool_use in `content`.
  // `executed` is a Map<tool_use_id, resultText> for the tool(s) we actually ran;
  // any OTHER tool_use in the same turn gets a benign, honest stub result so the
  // request is well-formed. Nothing is invented for the prospect — a stub result
  // just tells the model that tool wasn't run this turn.
  function pairAllToolResults(content, executed) {
    const out = [];
    for (const blk of (content || [])) {
      if (!blk || blk.type !== "tool_use") continue;
      const id = blk.id;
      if (executed && executed.has(id)) {
        out.push({ type: "tool_result", tool_use_id: id, content: executed.get(id) });
      } else {
        // An extra/unhandled tool_use from the same turn. Pair it so the request
        // is valid; tell the model it wasn't executed so it resolves to text.
        out.push({
          type: "tool_result",
          tool_use_id: id,
          content: JSON.stringify({ note: "This tool was not run this turn. Reply to the prospect in plain text now." }),
        });
      }
    }
    return out;
  }

  // ── PROSPECT-TEXT PUNCTUATION GUARANTEE (§2 / PUNCTUATION) ──────────────────
  // The persona forbids em/en dashes in prospect texts, but a prompt rule is not
  // a guarantee — models emit them constantly. This is the deterministic strip
  // that makes the rule real. ONLY targets em (U+2014) and en (U+2013) dashes;
  // ordinary hyphens (dates, phones, compounds) are untouched. Context-aware:
  // a dash used as a mid-thought break becomes '...'; a dash joining two clauses
  // that reads as a pause becomes ', '. Heuristic, but far better than shipping
  // the AI tell.
  function stripDashes(text) {
    if (!text) return text;
    let s = String(text);
    // Normalize spacing around the dash first: "word — word" / "word—word".
    // A dash with spaces on BOTH sides, OR preceded by a space, reads as a
    // parenthetical/trailing break → '...'. A dash tightly BETWEEN words with no
    // space (word—word) reads as a joining pause → ', '.
    // 1) " — " (spaced both sides): trailing-thought feel → "... "
    s = s.replace(/\s+[—–]\s+/g, (m) => {
      // If what follows looks like a full new clause (starts lowercase 'and/but/
      // so/let/i' or similar) treat as a pause comma; else an ellipsis break.
      return "... ";
    });
    // 2) "word—word" (no spaces): joining → ", "
    s = s.replace(/([^\s])[—–]([^\s])/g, "$1, $2");
    // 3) any stragglers (dash at start/end or odd spacing) → ", "
    s = s.replace(/[—–]/g, ", ");
    // Collapse an accidental ", ..." or double punctuation the swaps can create.
    s = s.replace(/,\s*\.\.\./g, "...").replace(/\.\.\.\s*,/g, "...");
    s = s.replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
    return s;
  }

  // ── NO-SILENCE FALLBACKS (§6) ──────────────────────────────────────────────
  // When the output floor blocks a reply, we NEVER go dark — we send one of
  // these. Kept as constants so they're auditable and in the founder's voice.
  const FALLBACK_FAIRHOUSING =
    "I can give you the practical stuff, SOLO has controlled access, cameras, package lockers, and key-fob entry. For the neighborhood, I can point you to current public data so you can make your own call.";
  const FALLBACK_INVENTORY =
    "Let me check the live inventory before I give you the wrong unit. We can still get you in to see the building.";
  const FALLBACK_GENERAL =
    "Let me verify that and get you the real answer.";

  // The demo manager: SERVER-DERIVED identity. Never trust a client-supplied user_id.
  // Reuses the seeded leasing_manager (demo.js seed creates demo-manager@propertyspine.internal).
  async function demoManagerUserId(client) {
    let m = (await client.query(
      "select id from users where email='demo-manager@propertyspine.internal' limit 1"
    )).rows[0];
    if (!m) {
      m = (await client.query(
        "select id from users where role='leasing_manager'::role_name order by created_at asc limit 1"
      )).rows[0];
    }
    if (!m) throw httpErr(409, "No demo manager user — seed one first (the demo seed creates it).");
    return m.id;
  }

  // resolve-or-create the canonical conversation for (person, property)
  async function ensureConversation(client, { person_id, property_id }) {
    let c = (await client.query(
      "select * from conversations where person_id=$1 and property_id=$2 order by created_at limit 1",
      [person_id, property_id]
    )).rows[0];
    if (!c) {
      c = (await client.query(
        "insert into conversations (property_id, person_id) values ($1,$2) returning *",
        [property_id, person_id]
      )).rows[0];
    }
    return c;
  }

  // ensure a thread-state row for a conversation; returns it (locked if forUpdate)
  async function loadThreadState(client, conversation_id, forUpdate) {
    const lock = forUpdate ? " for update" : "";
    let s = (await client.query(
      `select * from agent_thread_state where conversation_id=$1${lock}`, [conversation_id]
    )).rows[0];
    if (!s) {
      // create then re-select (so we can lock it consistently)
      await client.query(
        "insert into agent_thread_state (conversation_id) values ($1) on conflict (conversation_id) do nothing",
        [conversation_id]
      );
      s = (await client.query(
        `select * from agent_thread_state where conversation_id=$1${lock}`, [conversation_id]
      )).rows[0];
    }
    return s;
  }

  // ── the curated fact resolver + the LIVE unit read ─────────────────────────
  // Returns { facts:[{fact_key,category,rendered_text,source}], unit:{...}|null }.
  // Curated facts come from agent_facts (active). Unit truth is read LIVE from units.
  async function resolveContext(client, { property_id, unit_id }) {
    const facts = (await client.query(
      `select fact_key, category, rendered_text, source_type, source_record_id, confirmed_at
         from agent_facts
        where property_id=$1 and status='active' and (space_id is null)`,
      [property_id]
    )).rows.map(r => ({
      fact_key: r.fact_key, category: r.category, rendered_text: r.rendered_text,
      source: r.source_type, confirmed_at: r.confirmed_at,
    }));

    let unit = null;
    if (unit_id) {
      const u = (await client.query(
        "select unit_number, bedrooms, bathrooms, square_feet, market_rent from units where id=$1",
        [unit_id]
      )).rows[0];
      if (u) unit = {
        unit_number: u.unit_number, bedrooms: u.bedrooms, bathrooms: u.bathrooms,
        square_feet: u.square_feet, market_rent: u.market_rent,
      };
    }
    return { facts, unit };
  }

  // ── DETERMINISTIC risk-routing control (v1) — NOT a compliance engine ──────
  // Pre-generation: classify the inbound. Sensitive categories never get an
  // ordinary Send path. Returns { decision:'safe'|'requires_handoff'|'blocked', code }.
  function preGenerationPolicy(inboundText) {
    const t = (inboundText || "").toLowerCase();
    // PRE-GATE (§5): ONLY requests that require DETERMINISTIC routing bypass the
    // model. Everything else — fees, occupancy, screening timelines, "is it
    // safe", general accessibility — flows to the model, which chooses
    // answer/redirect/defer/handoff per the persona. The post-generation floor
    // still catches unsafe OUTPUT. Each hard-gate carries its pre-approved ack
    // (§5); the ack is only SENT after the obligation write succeeds (the
    // obligation is born in TX1 before we get here, so that holds by construction).
    const hardHandoff = [
      // Active emergency — a person must handle immediately.
      [/\b(emergency|gas leak|fire|flood|broke in|break.?in|911|someone('?s| is) (hurt|in danger)|being threatened|there'?s a threat)\b/,
        "safety_emergency",
        "If anyone is in immediate danger, call 911. I'm getting this to the team now."],
      // Explicit accommodation request (ADA) — legally must be handled right.
      // NOTE: a general accessibility question ("is it wheelchair accessible")
      // is NOT this — that's an answerable building fact, left to the model.
      [/\b(service animal|emotional support animal|esa|reasonable accommodation|request an accommodation|ada request)\b/,
        "accommodation_request",
        "Got it, I'm sending this to the right person on the team now so it's handled properly."],
      // Explicit request for a person.
      [/\b(talk to (a|someone|a real)|speak (to|with) (a|someone)|call me|can i call|get me a (person|human|manager)|real person|human being)\b/,
        "human_requested",
        "Yep, I'll get someone from the team on this."],
      // Direct legal / discrimination complaint.
      [/\b(lawyer|attorney|sue|lawsuit|discriminat|fair housing|hud complaint|filing a complaint|report you)\b/,
        "legal_or_dispute",
        "I'm getting this directly to the right person on the team now."],
    ];
    for (const [re, code, ack] of hardHandoff) if (re.test(t)) return { decision: "requires_handoff", code, ack };
    return { decision: "safe", code: null, ack: null };
  }

  // Post-generation validation: catch unsafe output before it can be sent.
  function postGenerationPolicy(draftText) {
    const t = (draftText || "").toLowerCase();
    // HARD FLOOR on unsafe OUTPUT (§6). Codes prefixed 'fairhousing:' are
    // RECOVERABLE — dispatch replaces the reply with a safe practical redirect
    // and SENDS it (never silence). A unit-grounding block is handled separately
    // (dispatch sends the inventory fallback + raises an internal QA signal).
    const blockPatterns = [
      [/\b(good|bad|safe|dangerous|rough|sketchy|nice|great) (neighborhood|area|part of town|block|side of town)\b/, "fairhousing:neighborhood_character"],
      [/\b(crime rate|crime is|safe to walk|it'?s safe|is safe|very safe|totally safe|perfectly safe)\b/, "fairhousing:safety_claim"],
      [/\b(perfect for|ideal for|suited for|great for|good for) (families|singles|young professionals|students|christian|jewish|muslim|couples)/, "fairhousing:demographic_steering"],
    ];
    for (const [re, code] of blockPatterns) if (re.test(t)) return { decision: "blocked", code };
    return { decision: "safe", code: null };
  }

  // ── build the model context in STRICT AUTHORITY ORDER ──────────────────────
  // (1) safety/fair-housing rules (2) curated facts (3) live unit truth
  // (4) thread history (5) persona. Lead messages are UNTRUSTED content.
  function buildMessages({ persona, facts, unit, history, propertyName }) {
    const factLines = facts.length
      ? facts.map(f => `- ${f.fact_key} (${f.category}; source: ${f.source}): ${f.rendered_text}`).join("\n")
      : "(no curated facts are on file for this property)";
    const unitLine = unit
      ? `Unit ${unit.unit_number || "(unnamed)"}: ${unit.bedrooms ?? "?"}bd/${unit.bathrooms ?? "?"}ba` +
        (unit.market_rent != null ? `, rent $${unit.market_rent}` : ", rent not on the unit record")
      : "(no specific unit is linked to this inquiry yet)";

    const system =
`You are SOLO on Chestnut's leasing contact. You text like a smart, upbeat leasing person helping someone find a place, not like a brochure or support bot. Be warm, informal, lightly witty, and proactive. Never claim to be human.

THE GOAL

Answer the prospect, understand what matters to them, keep momentum, and get them into the building when there is real interest. You are trying to make something happen for them without inventing facts or becoming pushy.

THE FIVE MOVES

Every inbound gets a reply.

1. ANSWER: The fact is verified. Answer it directly.
2. REDIRECT: The question asks for a subjective safety, demographic, or steering judgment. Pivot to practical facts or objective public sources.
3. DEFER: The fact is not verified but YOU could find it yourself (look it up, check live data). Say you are checking the exact answer, then keep the conversation moving. No one else needs to do anything.
4. ESCALATE: A HUMAN must DO something before you can answer — confirm a unit's readiness or move-in date, accelerate a turn, verify parking availability, get an exception or waiver decision, or check an operating fact only staff can confirm. Call the create_staff_obligation tool to put that work on the team. You KEEP the conversation. Do NOT emit a handoff tag — this is not a handoff. Match your words to what the tool tells you: if it says the work was SENT to the team, say you've sent it to the team and will follow up; only say the team is actively working on it if the tool confirms that; only give a specific follow-up time if the tool returns a real due time.
5. HANDOFF: The prospect is frustrated, explicitly wants a person, requests an accommodation, reports an emergency, or raises a direct legal or discrimination complaint. This is when a PERSON must take over the CONVERSATION itself. Say you are getting the team involved and add this exact tag on its own line:

[[HANDOFF: short reason]]

The line between ESCALATE and HANDOFF: ESCALATE means staff has WORK to do while you keep talking. HANDOFF means a human must OWN the conversation. Readiness checks, turns, and exceptions are ESCALATE, never HANDOFF.

GROUNDING

Property-specific facts are strict. Exact units, rents, square footage, availability, readiness, fees, deposits, concessions, pet or parking terms, lease policies, screening time, approval time, and move-in dates must come from LIVE UNIT DATA or VERIFIED PROPERTY FACTS.

Never guess from general leasing knowledge.

Use the APPROVED SOLO PROFILE only for stable building facts.

Use web search for current local questions such as grocery stores, restaurants, transit time, walking distance, and nearby services.

If sources conflict, do not pick the convenient answer. Say you are checking the exact current fact.

Never expose another resident's name, rent, balance, lease, move date, or personal information.

VOICE

Maximum two short sentences, normally under 40 words.

Answer first.

Use contractions and normal texting language.

A little personality is good, but do not force slang or repeat a signature phrase.

Good language:

"I'm on it."

"Let me shake the tree a little."

"Let's see what we can pull off."

"Okay, now you're making my life easy."

"I don't want to make up a date."

"Come take a look."

Avoid:

"I'd be happy to assist."

"Thank you for reaching out."

"Appreciate the urgency."

"That'll get the ball rolling."

"Actually, I was wrong."

"I hear you, but..."

Avoid long apologies, legal lectures, and brochure paragraphs.

PUNCTUATION

Never use an em dash or en dash in a prospect text.

Use a comma, period, or ...

Before sending, scan the reply and remove AI-style dashes.

Normal hyphens are allowed only inside dates, phone numbers, or established compound words.

MEMORY

Remember the prospect's budget, move date, unit type, roommates, pets, furnished preference, parking need, commute, tour availability, and main concern.

Do not ask for the same information twice.

When recommending a unit, explain why it matches what they told you.

TOURS

Keep the tour path open whenever the prospect has active interest or asks about availability, price, layout, or timing.

Offer a real available unit, vacant unit, model, or authorized comparable layout.

The exact move-in unit does not need to be ready for the prospect to see the building and layout.

Do not promise access to an occupied unit.

Do not call it "someone else's apartment."

Say "a comparable layout" or "a unit we can show."

If the prospect clearly declines or says to stop asking, stop asking and keep answering normally.

MOVE-IN SPEED

Solo has sometimes moved people in within a few days when the unit is ready and the application, approval, lease, and payment are completed.

You may communicate that possibility, but never promise an exact date until readiness is confirmed.

Example:

"We've moved pretty quickly before, sometimes within a few days. I need to check which units are actually ready, but let me shake the tree with the team... want to come take a look today while I work on it?"

If they can apply and pay today:

"Okay, now you're making my life easy. That definitely helps, let's get you through the building and I'll push for the fastest-ready option."

If they ask about this weekend:

"Maybe, we're not miles away. I don't want to make up a date before I know which unit is ready, so let me verify it and see what we can pull off."

INVENTORY AND PRICING

Use only live inventory.

Start with the best one or two matches, not the whole roll.

A unit showing available is not a guarantee that nobody reserved it moments ago.

Say:

"It's showing available right now, let me make sure nobody just grabbed it."

Distinguish a floor-plan starting price from a specific unit price.

If the prospect saw another number online:

"You may be seeing the starting price rather than that exact unit. Let me pull both and get you the real number."

FAIR HOUSING

Do not make subjective claims that an area is safe, dangerous, good, bad, rough, or ideal for a type of person.

Do not characterize the residents or steer by protected characteristics.

You may discuss objective information such as controlled access, cameras, key-fob entry, transit, parks, businesses, commute, and consistently sourced public data.

For "Is it safe?":

"I can give you the practical stuff, SOLO has controlled access, cameras, package lockers, and key-fob entry. For the neighborhood, I can point you to current public data so you can make your own call."

For "What kind of people live there?":

"I can't really label the residents like that. I can tell you about the building, the commute, and what's nearby."

HANDOFFS AND PROMISES

A normal unknown fact you could find yourself is a DEFER, not a handoff.

If a HUMAN must do work before you can answer (readiness, a turn, an exception, an operating check only staff can confirm), that is an ESCALATE: call create_staff_obligation, then KEEP the conversation. It is not a handoff — do not emit the tag.

Bring in a person to OWN the conversation (a HANDOFF) only for the handoff conditions above.

Do not promise "I'll call in two hours" or "someone will reach out shortly" unless a real obligation with an owner and due time was created. You only know an obligation was created when the create_staff_obligation tool returns success — never claim it before that. When the tool says the work was SENT to the team, say you've sent it and will follow up; say the team is actively working on it only if the tool confirms that; state a specific time only if the tool returned a real due time.

If the obligation exists, say the team is being brought in.

If it does not, say you are checking now.

CORRECTIONS

Correct errors plainly and briefly.

Do not become defensive or invent an explanation.

"You're right, that price changed. The current number is $1,687."

"That doesn't match what I'm seeing now. Let me verify it before I give you another number."

NEVER

Never invent an operating fact.

Never leave an inbound unanswered.

Never explain or defend Property Spine.

Never repeat the same pitch.

Never make a waiver or exception sound approved.

Never close a lease or request sensitive documents over casual text.

Never reveal private resident information.

Never use AI-style dashes.

FINAL CHECK

Before sending, confirm:

1. I answered the actual question.
2. Every property claim is grounded.
3. I separated what is known from what still needs checking.
4. The reply is no more than two short sentences.
5. It sounds like a real text with good energy.
6. I remembered the thread.
7. I kept the tour path open without ignoring a clear no.
8. I removed every em dash and en dash.
9. I made no promise the system did not record.

APPROVED SOLO PROFILE (stable building facts you may use directly):
- SOLO on Chestnut is at 4233 Chestnut Street in University City.
- Layouts: studio, one-bedroom, one-bedroom-with-den, two-bedroom, three-bedroom.
- Furnished and unfurnished options exist.
- Apartments include in-unit laundry and kitchen appliances.
- Amenities: coworking and study spaces, fitness facilities, rooftop space, recreation areas, an indoor golf simulator, package lockers, controlled access, underground parking.
- Solo is pet friendly, but current restrictions and charges must come from VERIFIED PROPERTY FACTS below.

VERIFIED PROPERTY FACTS:
${factLines}

LIVE UNIT DATA:
${unitLine}

Reply with ONLY the message text.`;

    // history → alternating user/assistant; inbound=prospect=user, outbound=assistant
    const msgs = [];
    for (const h of history) {
      msgs.push({ role: h.direction === "inbound" ? "user" : "assistant", content: h.body || "" });
    }
    // ensure the array ends on the latest inbound (it will, since we just wrote it)
    return { system, messages: msgs.filter(m => m.content && m.content.trim()) };
  }

  // ── POST-BOOKING GOAL SHIFT ────────────────────────────────────────────────
  //  Once a prospect has an UPCOMING booked tour, the conversation's objective is
  //  no longer "earn a tour" — it's "be their helpful point of contact until they
  //  come in." This returns a system-prompt ADDENDUM (appended after buildMessages,
  //  same pattern as the selection_failed note) when this conversation's lead holds
  //  a tour with a live status ('scheduled','confirmed_by_prospect','checked_in')
  //  scheduled for now-or-later. Returns "" when there's no such tour, so the
  //  default earn-a-tour framing stands. A completed/cancelled/past tour does NOT
  //  count — if they toured and want to come again, earning another is fine.
  async function upcomingTourAddendum(conversation_id) {
    if (!conversation_id) return "";
    try {
      // conversation → its lead(s) (same person+property) → any live upcoming tour.
      const row = (await pool.query(
        `select t.scheduled_for
           from conversations c
           join leasing_leads l
             on l.person_id = c.person_id and l.property_id = c.property_id
           join leasing_tours t
             on t.lead_id = l.id
          where c.id = $1
            and t.status in ('scheduled','confirmed_by_prospect','checked_in')
            and t.scheduled_for >= (now() - interval '2 hours')
          order by t.scheduled_for asc
          limit 1`,
        [conversation_id])).rows[0];
      if (!row) return "";
      return `\n\n═══ THEY ARE ALREADY BOOKED — SHIFT YOUR GOAL ═══\n` +
        `This prospect ALREADY HAS A TOUR SCHEDULED. Do NOT ask them to book a tour, do NOT ` +
        `push to schedule, and do NOT call any tour-scheduling tool. Your job now is simply to be ` +
        `their helpful point of contact: answer their questions about the unit, the building, the ` +
        `neighborhood, parking, pets, what to expect at the tour, next steps, and anything else on ` +
        `their mind — same warm, short, human texting voice. If they want to change or cancel their ` +
        `tour time, tell them you'll have someone from the team help with that. Only if THEY bring up ` +
        `wanting a different or additional time should scheduling come up at all.`;
    } catch (_) {
      return ""; // never let a lookup failure change behavior — default framing stands.
    }
  }

  // Stage-A persona, revision stage-a-v3: warm, human, and BRIEF. The agent earns a
  // tour by making the prospect feel heard and building genuine interest over the
  // conversation — NOT by asking for the tour on every message. Conversational first,
  // directional second.
  const PERSONA =
    "A sharp, friendly human leasing person who knows this building and this city and texts like a " +
    "real person — short, direct, casual, contractions, a little personality. Not a bot, not a " +
    "brochure, not a compliance robot. You answer what was actually asked, plainly and without " +
    "ceremony. You're confident about the neighborhood (grocery, food, transit, parks, what it's " +
    "like to live around here) and you check when you're unsure rather than dodging. You're strict " +
    "about building specifics — rent, fees, availability, policies come only from verified data, " +
    "never invented. You work toward a tour by being someone worth texting with, not by pushing " +
    "every message, and you hand off anything sensitive to a person.";

  // ════════════════════════════════════════════════════════════════════════
  //  THE LOOP
  // ════════════════════════════════════════════════════════════════════════

  // POST /agent/threads/:slug-or-ids/inbound  — but for the demo we key off the
  // demo run's tenant person + property. We expose a demo-friendly entry that the
  // tenant browser calls. It does the FULL two-transaction loop.
  //
  // Body: { property_id, person_id, unit_id?, body, idempotency_key?, sms_sid? }
  //   sms_sid: present when this inbound arrived via the SMS door (the Twilio
  //   MessageSid, handed off from the inbound-sms webhook). It is the SAME
  //   idempotency anchor the tenant door uses. A Twilio retry that reaches here
  //   before the first attempt committed must NOT create a second inbound
  //   comm_event — so we dedup on sms_sid FIRST, and STAMP it on the insert so
  //   the anchor persists. (idempotency_key still guards agent_runs below,
  //   preventing a duplicate REPLY; this guards the RECORD.)
  // ── SHARED INBOUND SERVICE (in-process, one owner) ──────────────────
  //  processInbound(b) is the single canonical inbound-agent path. BOTH the
  //  public /agent/inbound route AND the SMS webhook (via _service) call it —
  //  no loopback HTTP, no duplicated logic. It returns { status, body } so the
  //  route can map it to res; callers that don't need HTTP just read body.
  //  Input b: { property_id, person_id, unit_id?, body, idempotency_key?, sms_sid? }
  //   sms_sid: present when this inbound arrived via the SMS door (the Twilio
  //   MessageSid). It is the SAME idempotency anchor the tenant door uses. A
  //   Twilio retry that reaches here before the first attempt committed must
  //   NOT create a second inbound comm_event — we dedup on sms_sid FIRST, and
  //   STAMP it on the insert so the anchor persists (comm_events.sms_sid is
  //   UNIQUE-indexed, so a concurrent double-insert raises 23505, which we
  //   catch and treat as an idempotent replay rather than a 500).
  //   (idempotency_key still guards agent_runs, preventing a duplicate REPLY;
  //   sms_sid guards the RECORD.)
  async function processInbound(b) {
    b = b || {};
    if (!b.property_id || !b.person_id || !b.body) {
      return { status: 400, body: { error: "property_id, person_id, and body are required." } };
    }
    try {
      // SMS IDEMPOTENCY (across the webhook→agent handoff): if this MessageSid
      // already produced an inbound comm_event, this is a retry — ack as a
      // no-op. Never a second record, never a second downstream reply.
      if (b.sms_sid) {
        const dup = (await pool.query(
          `select id from comm_events where sms_sid = $1 limit 1`, [b.sms_sid]
        )).rows[0];
        if (dup) {
          return { status: 200, body: { ok: true, idempotentReplay: true, inbound_comm_event_id: dup.id } };
        }
      }
      // ── TX1: persist canonical inbound, lock state, bump version, create pending
      //         run, create/refresh the review obligation. NO model call here. ──
      const tx1 = await tx(async (client) => {
        const conv = await ensureConversation(client, { person_id: b.person_id, property_id: b.property_id });
        const state = await loadThreadState(client, conv.id, true); // FOR UPDATE

        // persist the canonical inbound comm_event (the real record). sms_sid is
        // stamped when present (SMS door) — the unique idempotency anchor.
        const inbound = (await client.query(
          `insert into comm_events
             (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification, sender_role, sms_sid)
           values ($1,$2,$3,$4,'text','inbound',$5,'leasing','prospect',$6) returning id`,
          [b.property_id, b.person_id, b.unit_id || null, conv.id, b.body, b.sms_sid || null]
        )).rows[0];
        await client.query("update conversations set last_message_at = now() where id=$1", [conv.id]);

        // GENUINE-INBOUND REOPEN: a qualifying prospect inbound persisted above. If this
        // conversation's latest-relevant lifecycle state is closed_not_fit, reopen it in
        // THIS transaction (source_comm_event_id = this inbound). No-op when not closed;
        // idempotent under the conversation lock. (Foundation 054 lifecycle rail.)
        if (leasingLifecycle && b.body && String(b.body).trim() !== "") {
          await leasingLifecycle.maybeReopenOnQualifyingInbound(client, {
            conversationId: conv.id, sourceCommEventId: inbound.id,
          });
        }

        // ── OFFERED → SELECTED (funnel-flow Build 2) ────────────────────
        // If the last DISPATCHED draft carried a real offered-unit set,
        // check whether THIS inbound explicitly confirms one. Only the
        // prospect's own words attach a unit — a mention by the agent
        // never does. Deterministic matcher; ambiguity attaches nothing.
        let selectedUnit = null, selectionFailed = null;
        try {
          const lastOffer = (await client.query(
            `select ar.offered_units_json, d.dispatched_comm_event_id
               from agent_runs ar
               join agent_drafts d on d.agent_run_id = ar.id and d.status = 'dispatched'
              where ar.conversation_id = $1 and ar.offered_units_json is not null
              order by d.dispatched_at desc limit 1`,
            [conv.id]
          )).rows[0];
          const offered = lastOffer && lastOffer.offered_units_json;
          let match = offered ? inventory.matchConfirmationToOffer(b.body, offered) : null;
          // FRESHNESS: a bare affirmative binds only to an offer that is still
          // the LAST outbound in the conversation — "yes" after newer messages
          // must not select from an older offer. (An explicit unit-number
          // citation still binds only to the latest offer set, read above.)
          if (match && lastOffer) {
            const bare = !new RegExp(`(^|[^a-z0-9])${String(match.unit_number).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(String(b.body).toLowerCase());
            if (bare) {
              const newer = (await client.query(
                `select count(*)::int as n from comm_events
                  where conversation_id = $1 and direction = 'outbound'
                    and occurred_at > (select occurred_at from comm_events where id = $2)`,
                [conv.id, lastOffer.dispatched_comm_event_id]
              )).rows[0].n;
              if (newer > 0) {
                console.log(`[agent/inbound] bare affirmative ignored — a newer outbound intervened after the offer (freshness rule).`);
                match = null;
              }
            }
          }
          if (match) {
            const att = await inventory.attachSelectedUnit(
              { property_id: b.property_id, person_id: b.person_id, unit_id: match.id }, client
            );
            if (att.attached) {
              selectedUnit = { id: match.id, unit_number: match.unit_number };
              console.log(`[agent/inbound] prospect SELECTED unit ${match.unit_number} — attached to lead ${att.lead_id} (offered≠selected honored).`);
            } else if (att.reason === "unit_no_longer_available") {
              selectionFailed = { unit_number: match.unit_number, reason: att.reason };
              console.log(`[agent/inbound] prospect chose unit ${match.unit_number} but it is NO LONGER AVAILABLE — nothing attached; agent will say so honestly.`);
            } else {
              console.log(`[agent/inbound] selection matched unit ${match.unit_number} but attach refused: ${att.reason}`);
            }
          }
        } catch (e) { console.error("[agent/inbound] selection check failed (non-fatal):", e.message); }

        const mode = state.mode;
        const newVersion = Number(state.thread_version) + 1;

        // supersede any prior ready draft on this conversation (new inbound invalidates it)
        await client.query(
          `update agent_drafts d set status='superseded', superseded_at=now(), updated_at=now()
             from agent_runs r
            where d.agent_run_id=r.id and r.conversation_id=$1 and d.status='ready'`,
          [conv.id]
        );

        // NO SILENT AI RE-ENTRY: in human_takeover / paused / closed, persist the
        // inbound and refresh the human obligation, but DO NOT create an agent run.
        if (mode === "human_takeover" || mode === "paused" || mode === "closed") {
          await client.query(
            "update agent_thread_state set thread_version=$2, latest_inbound_comm_event_id=$3, updated_at=now() where conversation_id=$1",
            [conv.id, newVersion, inbound.id]
          );
          // refresh (or create) a human obligation so the person owning the thread sees it
          let obId = state.current_review_obligation_id;
          if (!obId && spawnObligationFromEvent) {
            const ob = await spawnObligationFromEvent(client, {
              property_id: b.property_id, person_id: b.person_id, unit_id: b.unit_id || null,
              source_event_id: null, module: "agent", type: "human_thread_reply",
              label: "New prospect message — human-owned thread", owner_type: "human",
              assigned_role: "leasing_manager",
            });
            obId = ob.id;
            await client.query("update agent_thread_state set current_review_obligation_id=$2 where conversation_id=$1", [conv.id, obId]);
          }
          return { skipModel: true, mode, conversation_id: conv.id };
        }

        // active path: create the pending run
        const genNo = 1; // first generation for this (conv, version); regenerate increments separately
        const idem = b.idempotency_key || null;

        // idempotency: if a run already exists for this idem key, reuse it (retry-safe)
        if (idem) {
          const existing = (await client.query(
            "select * from agent_runs where request_idempotency_key=$1 limit 1", [idem]
          )).rows[0];
          if (existing) {
            return { skipModel: false, reuse: true, run: existing, conversation_id: conv.id,
                     inbound_id: existing.inbound_comm_event_id, version: existing.input_thread_version };
          }
        }

        const run = (await client.query(
          `insert into agent_runs
             (conversation_id, inbound_comm_event_id, input_thread_version, generation_no,
              generation_reason, request_idempotency_key, status, prompt_revision, policy_revision, model)
           values ($1,$2,$3,$4,'initial_inbound',$5,'pending',$6,$7,$8) returning *`,
          [conv.id, inbound.id, newVersion, genNo, idem, PROMPT_REVISION, POLICY_REVISION, MODEL]
        )).rows[0];

        // review obligation BORN HERE (survives a crash before the model returns)
        let obId = state.current_review_obligation_id;
        if (spawnObligationFromEvent) {
          if (obId) {
            // refresh the existing one's label; don't create a duplicate
            await client.query(
              "update obligations set label=$2, updated_at=now() where id=$1",
              [obId, "AI reply is being prepared"]
            ).catch(() => {});
          } else {
            const ob = await spawnObligationFromEvent(client, {
              property_id: b.property_id, person_id: b.person_id, unit_id: b.unit_id || null,
              source_event_id: null, module: "agent", type: "agent_review",
              label: "AI reply is being prepared", owner_type: "human",
              assigned_role: "leasing_manager",
            });
            obId = ob.id;
          }
        }

        await client.query(
          "update agent_thread_state set thread_version=$2, latest_inbound_comm_event_id=$3, current_review_obligation_id=$4, updated_at=now() where conversation_id=$1",
          [conv.id, newVersion, inbound.id, obId]
        );

        return { skipModel: false, run, conversation_id: conv.id, inbound_id: inbound.id,
                 version: newVersion, property_id: b.property_id,
                 unit_id: (selectedUnit && selectedUnit.id) || b.unit_id || null,
                 selected_unit: selectedUnit, selection_failed: selectionFailed,
                 person_id: b.person_id, review_obligation_id: obId, inboundText: b.body };
      });

      if (tx1.skipModel) {
        return { status: 200, body: { ok: true, skipped: true, mode: tx1.mode, reason: "thread is human-owned; no agent draft generated" } };
      }
      if (tx1.reuse) {
        return { status: 200, body: { ok: true, reused: true, run_id: tx1.run.id, status: tx1.run.status } };
      }

      // ── pre-generation policy: sensitive inbound → handoff, restricted prompt ──
      const pre = preGenerationPolicy(tx1.inboundText);

      // ── model call OUTSIDE any transaction ──
      let generated = null, providerReqId = null, genErr = null, factSnapshot = [], snapshotHash = "";
      let offeredUnits = null; // real units surfaced by the inventory tool this run (offered ≠ selected)
      let offerableSlots = []; // real tour slots the model MAY present this run (candidates)
      let presentedSlotIds = null; // the EXACT slot ids the model chose to state (offer_tour_slots) — confirmable
      let recordedOfferId = null;  // the agent_tour_offers row id created when the model presented slots (for provenance link)
      try {
        // resolve context fresh (read-only; not in a write txn)
        const client0 = await pool.connect();
        let ctx;
        try { ctx = await resolveContext(client0, { property_id: tx1.property_id, unit_id: tx1.unit_id }); }
        finally { client0.release(); }
        factSnapshot = ctx.facts;
        snapshotHash = sha(factSnapshot);

        // history (the real thread) for context
        const client1 = await pool.connect();
        let history;
        try {
          history = (await client1.query(
            `select direction, body from comm_events
              where conversation_id=$1 and channel='text' and body is not null
              order by occurred_at asc nulls last, id asc limit 40`,
            [tx1.conversation_id]
          )).rows;
        } finally { client1.release(); }

        if (pre.decision === "requires_handoff") {
          // Hard-gate category (§5): do NOT generate leasing copy. Send the
          // category's pre-approved ack. The review obligation was already born
          // in TX1, so promising "getting this to the team" is honest here.
          generated = pre.ack || "Yep, I'll get someone from the team on this.";
        } else if (anthropic) {
          const propName = (await (async () => {
            const c = await pool.connect();
            try { return (await c.query("select coalesce(display_name, name) as name from properties where id=$1", [tx1.property_id])).rows[0]?.name || null; }
            finally { c.release(); }
          })());
          const built = buildMessages({ persona: PERSONA, facts: ctx.facts, unit: ctx.unit, history, propertyName: propName });
          // If they already have an upcoming tour, shift the goal from earn-a-tour
          // to be-their-contact (and below, tour tools are withheld).
          const _tourAddendum = await upcomingTourAddendum(tx1.conversation_id);
          built.system += _tourAddendum;
          const _alreadyBooked = _tourAddendum !== "";
          if (tx1.selection_failed) {
            built.system += `\nIMPORTANT: the prospect just tried to choose Unit ${tx1.selection_failed.unit_number}, but it is NO LONGER AVAILABLE (it was taken after being offered). Apologize briefly, say so plainly, and offer to look for current alternatives (you may use the find_available_units tool). Never pretend it is still available.`;
          }

          // ── GROUNDED INVENTORY TOOL (funnel-flow Build 2) ──────────────
          // Property is SERVER-DERIVED (tx1.property_id) — the model chooses
          // criteria, never the property.
          const INVENTORY_TOOL = {
            name: "find_available_units",
            description: "Search THIS property's real available units (vacant, not out of service) when the prospect asks what's available or states preferences (bedrooms, budget). Returns real units only. If the result is empty, say so honestly — NEVER invent or imply a unit that is not in the result.",
            input_schema: {
              type: "object",
              properties: {
                bedrooms: { type: "integer", description: "exact bedroom count if stated" },
                bathrooms: { type: "number", description: "minimum bathrooms if stated" },
                max_rent: { type: "number", description: "budget ceiling in dollars if stated" },
              },
            },
          };

          // ── GOVERNED TOUR BOOKING (funnel-flow Build 3) ────────────────
          // The agent may book a tour ONLY into a currently-open slot it was
          // shown for THIS property, and only when booking is capability-enabled
          // for the property AND the prospect has confirmed a specific offered
          // time. The tool takes a slot_id the model must copy verbatim from the
          // offered list — the booking service RE-READS and LOCKS that slot and
          // re-verifies all authority server-side; a slot_id in the prompt is
          // proof of nothing. Offered ≠ booked: the model proposes; the service
          // is the sole authority on whether the write happens.
          const bookingEnabled = !!(leasingBookingService
            && typeof leasingBookingService.bookTourIntoSlot === "function"
            && typeof leasingBookingService.propertyAgentBookingEnabled === "function"
            && leasingBookingService.propertyAgentBookingEnabled(tx1.property_id))
            && !_alreadyBooked;  // they already have an upcoming tour → withhold tour tools

          // Read the REAL open slots (property operating tz). readOfferableSlots
          // returns NULL when the property's operating tz is UNCONFIGURED — in
          // that case we do NOT offer times and do NOT expose booking (honest,
          // never an invented local time). null vs [] is meaningful:
          //   null  → tz unconfigured → booking unavailable this turn
          //   []    → tz known, no open slots → "I'll have someone follow up"
          let tzConfigured = true;
          if (bookingEnabled && typeof leasingBookingService.readOfferableSlots === "function") {
            try {
              const sc = await pool.connect();
              let read;
              try { read = await leasingBookingService.readOfferableSlots(sc, { propertyId: tx1.property_id, limit: 4 }); }
              finally { sc.release(); }
              if (read === null) { tzConfigured = false; offerableSlots = []; }
              else offerableSlots = read;
            } catch (e) { console.error("[agent/inbound] slot read failed (non-fatal):", e.message); offerableSlots = []; }
          }

          // book_tour + offer_tour_slots are exposed ONLY when booking is
          // capability-enabled AND the property tz is configured. Unknown tz →
          // neither tool, no offer (honest).
          const bookingUsable = bookingEnabled && tzConfigured;

          // Map of the slots we may present this turn, by id, for validation of
          // what the model chooses to offer. The model may ONLY offer ids from
          // this set (real, open, this-property); it offers a SUBSET it will
          // actually state — and ONLY that subset becomes confirmable later.
          const offerableById = new Map(offerableSlots.map(s => [String(s.slot_id), s]));

          const OFFER_TOUR_SLOTS_TOOL = {
            name: "offer_tour_slots",
            description: "Call this to PRESENT specific tour times to the prospect. Pass ONLY the slot_ids you will actually state in your reply — those exact times become the ones the prospect can later confirm. Do not pass slots you won't mention. After calling, state those same times to the prospect in natural language. Use only slot_ids from the offered slot list in your context.",
            input_schema: {
              type: "object",
              properties: {
                slot_ids: { type: "array", items: { type: "string" }, description: "the exact slot_ids you will state to the prospect (a subset of the available slots)" },
              },
              required: ["slot_ids"],
            },
          };

          const BOOK_TOUR_TOOL = {
            name: "book_tour",
            description: "Book a tour into a SPECIFIC open slot AFTER the prospect has clearly confirmed one of the exact times you previously offered them. Use ONLY a slot_id you actually presented via offer_tour_slots and that the prospect confirmed. Do NOT invent a slot_id, do NOT book a time you did not present, and do NOT book unless the prospect confirmed a specific slot.",
            input_schema: {
              type: "object",
              properties: {
                slot_id: { type: "string", description: "the exact slot_id the prospect confirmed (one you previously presented)" },
              },
              required: ["slot_id"],
            },
          };

          // Surface the AVAILABLE slots to the model (with ids) as candidates it
          // MAY present. Presenting is an explicit act (offer_tour_slots) — the
          // model states a subset; only that subset is later confirmable.
          if (bookingUsable) {
            if (offerableSlots.length) {
              built.system += `\n\nTOUR SCHEDULING: booking is enabled. Below are the real open tour times you MAY present (property local timezone). To offer times, FIRST call offer_tour_slots with ONLY the slot_ids you will actually state, THEN state those exact times to the prospect. When the prospect confirms one you presented, call book_tour with that slot_id. Never state or book a time not in this list:\n` +
                offerableSlots.map(s => `  - ${s.label}  [slot_id: ${s.slot_id}]`).join("\n");
            } else {
              built.system += `\n\nTOUR SCHEDULING: booking is enabled but there are NO open tour slots right now. If the prospect asks to tour, say you'll have someone follow up with times — do NOT invent a time and do NOT call any tour tool.`;
            }
          }

          // ── AREA KNOWLEDGE (Rail 2) ────────────────────────────────────
          // Anthropic-run server-side web search. The model uses it ONLY for
          // neighborhood/city questions (grocery, food, transit, parks, "how
          // far to X", why someone likes the area) — the prompt (Rail 1) keeps
          // property specifics OFF this tool, and Rail 3 keeps answers off
          // protected-category proxies. This is a SERVER-side tool: the model
          // searches and returns final text in the SAME call, so there is no
          // tool_result round-trip to handle here (unlike inventory/booking).
          // Capped to bound latency and cost on an SMS reply. Class 1 primitive.
          const AREA_KNOWLEDGE_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 3 };

          // ── OPERATIONAL ESCALATION (Slice 1) ───────────────────────────
          // When a HUMAN must DO something before the agent can answer —
          // confirm readiness/move-in date, accelerate a turn, verify parking,
          // get an exception/waiver, check a staff-only operating fact — the
          // model calls this to put real WORK on the team. This is NOT a
          // handoff: the AI keeps the conversation. The service write (below)
          // is the sole authority that the work is owned; the model may only
          // tell the prospect "the team is on it" AFTER the tool returns owned,
          // and may only state a time if the tool returns a real due time.
          // Always exposed — an escalation need can arise in any conversation.
          const ESCALATE_TOOL = {
            name: "create_staff_obligation",
            description: "Put real WORK on the leasing team when a HUMAN must DO something before you can answer — confirm a unit's readiness or move-in date, accelerate a turnover, verify parking availability, get an exception or waiver decision, or check an operating fact only staff can confirm. This does NOT hand off the conversation — you keep talking to the prospect. Do NOT call this for a fact you could look up yourself (that's a plain answer/defer), and do NOT call this for frustration, a request for a person, an accommodation, an emergency, or a legal/discrimination complaint (those are a handoff, not this). After this returns, you may tell the prospect the team is on it — but ONLY a specific time if the result includes a due time.",
            input_schema: {
              type: "object",
              properties: {
                reason: { type: "string", description: "short plain-language description of the work the team must do, e.g. 'confirm unit 214 can be ready for Sunday move-in'" },
              },
              required: ["reason"],
            },
          };

          const activeTools = (bookingUsable
            ? [INVENTORY_TOOL, OFFER_TOUR_SLOTS_TOOL, BOOK_TOUR_TOOL]
            : [INVENTORY_TOOL]
          ).concat([ESCALATE_TOOL, AREA_KNOWLEDGE_TOOL]);

          let r = await anthropic.messages.create({
            model: MODEL, max_tokens: 320, system: built.system, messages: built.messages,
            tools: activeTools,
          });
          providerReqId = (r && r.id) || null;

          // The model may call one tool this round. Handle whichever came back.
          const invUse = (r.content || []).find(x => x.type === "tool_use" && x.name === "find_available_units");
          const offerUse = (r.content || []).find(x => x.type === "tool_use" && x.name === "offer_tour_slots");
          const bookUse = (r.content || []).find(x => x.type === "tool_use" && x.name === "book_tour");
          const escUses = (r.content || []).filter(x => x.type === "tool_use" && x.name === "create_staff_obligation");

          if (invUse) {
            const qc = await pool.connect();
            let found;
            try {
              found = await inventory.availableUnits({
                property_id: tx1.property_id,
                bedrooms: invUse.input && invUse.input.bedrooms,
                bathrooms: invUse.input && invUse.input.bathrooms,
                max_rent: invUse.input && invUse.input.max_rent,
              }, qc);
            } finally { qc.release(); }
            offeredUnits = found.units.map(u => ({
              id: u.id, unit_number: u.unit_number, bedrooms: u.bedrooms,
              bathrooms: u.bathrooms, square_feet: u.square_feet, market_rent: u.market_rent,
            }));
            const toolResultText = offeredUnits.length
              ? JSON.stringify({ qualification: found.qualification, units: offeredUnits.map(({ id, ...pub }) => pub) })
              : JSON.stringify({ qualification: found.qualification, units: [], note: "No units match. Tell the prospect honestly; offer to note their preferences." });
            r = await anthropic.messages.create({
              model: MODEL, max_tokens: 320, system: built.system,
              messages: [
                ...built.messages,
                { role: "assistant", content: r.content },
                { role: "user", content: pairAllToolResults(r.content, new Map([[invUse.id, toolResultText]])) },
              ],
              tools: activeTools,
            });
            providerReqId = (r && r.id) || providerReqId;
          } else if (offerUse && bookingUsable) {
            // ── EXPLICIT OFFER ─────────────────────────────────────────────
            // The model states which slots it will PRESENT. Only ids that are
            // real, open, and offerable THIS turn pass. Those exact ids ARE the
            // offer — recorded RIGHT HERE, at tool-execution, as an atomic
            // supersede+insert that owns the active→superseded transition. This
            // is decoupled from dispatch: the authority to confirm is "the model
            // stated these slots," recorded the moment it happens, not deferred
            // to a later dispatch step that may not fire on a reused-draft turn.
            const requested = Array.isArray(offerUse.input && offerUse.input.slot_ids) ? offerUse.input.slot_ids.map(String) : [];
            const valid = requested.filter(id => offerableById.has(id));
            presentedSlotIds = valid; // may be empty → nothing becomes confirmable

            // Record the offer NOW (only if the model actually stated ≥1 real slot).
            if (valid.length && leasingBookingService && typeof leasingBookingService.recordTourOffer === "function") {
              try {
                const offer = await leasingBookingService.recordTourOffer(null, {
                  conversationId: tx1.conversation_id,
                  leadId: tx1.lead_id || null,
                  propertyId: tx1.property_id,
                  agentRunId: (tx1.run && tx1.run.id) || null,
                  outboundCommEventId: null, // linked as provenance after dispatch
                  slotIds: valid,
                  supersede: true, // a new availability offer replaces the old set
                });
                recordedOfferId = offer && offer.id;
              } catch (e) { console.error("[agent/inbound] recordTourOffer failed (non-fatal):", e.message); }
            }

            const confirmed = valid.map(id => {
              const s = offerableById.get(id);
              return { slot_id: id, label: s.label };
            });
            const offerResult = confirmed.length
              ? JSON.stringify({ presented: confirmed, note: "Now state EXACTLY these times to the prospect in natural language. These are the times they can confirm." })
              : JSON.stringify({ presented: [], note: "None of those slot_ids are currently offerable. Do not state any specific time; offer to check availability." });
            r = await anthropic.messages.create({
              model: MODEL, max_tokens: 320, system: built.system,
              messages: [
                ...built.messages,
                { role: "assistant", content: r.content },
                { role: "user", content: pairAllToolResults(r.content, new Map([[offerUse.id, offerResult]])) },
              ],
              tools: activeTools,
            });
            providerReqId = (r && r.id) || providerReqId;
          } else if (bookUse && bookingUsable) {
            // ── GOVERNED BOOKING WRITE ─────────────────────────────────────
            // The model proposed a slot_id. The service re-reads+locks it,
            // re-verifies property/lead/slot authority, and books (or refuses).
            // Idempotency key = the inbound MessageSid (b.sms_sid): a retried
            // delivery of the SAME confirmation converges on the SAME tour.
            // Attribution: EXECUTION actor = system; SUBJECT = the prospect;
            // CAUSE = this inbound comm_event + agent run.
            const proposedSlotId = bookUse.input && bookUse.input.slot_id;

            // OFFER AUTHORITY: the slot must belong to the MOST RECENT still-
            // active, unexpired OFFER for this conversation — the durable record
            // of what was ACTUALLY PRESENTED to the prospect (agent_tour_offers),
            // written when the agent stated those times in an outbound message.
            // This is NOT the whole context pool and NOT a union of history: a
            // superseded or expired offer does not authorize a booking, so a slot
            // from an older offer is refused unless the newest offer re-stated it.
            // Survives the real flow (offer in run A, confirm in run B) because
            // the offer is persisted. Also covers a confirm in the SAME run the
            // offer was made, by unioning this run's freshly-presented ids.
            let offeredIdSet = new Set(Array.isArray(presentedSlotIds) ? presentedSlotIds.map(String) : []);
            try {
              const active = await leasingBookingService.resolveActiveOfferedSlotIds(
                pool, { conversationId: tx1.conversation_id });
              for (const id of active.ids) offeredIdSet.add(String(id));
            } catch (e) { console.error("[agent/inbound] active-offer resolve failed (non-fatal):", e.message); }

            const wasOffered = proposedSlotId && offeredIdSet.has(String(proposedSlotId));
            let bookResult = null, bookErr = null;

            // SERVER-NAMESPACED idempotency key — the model NEVER supplies the
            // durable key, and it is NOT a raw MessageSid. Namespaced by source +
            // conversation + message + slot so a retried confirmation converges,
            // while a different confirmation (different slot / later message)
            // is a distinct action. The demo-link path uses its own namespace.
            const bookingActionKey = (b.sms_sid && tx1.conversation_id && proposedSlotId)
              ? `agent-book-tour:${tx1.conversation_id}:${b.sms_sid}:${proposedSlotId}`
              : null;

            if (!proposedSlotId || !wasOffered) {
              bookErr = { public: "That time isn't one I offered for this conversation. Let me share the current available times." };
              console.error(`[agent/inbound] book_tour refused: slot ${proposedSlotId} not in the persisted offered set for conversation ${tx1.conversation_id} (cross-turn anti-hallucination guard).`);
            } else {
              const bc = await pool.connect();
              try {
                await bc.query("begin");
                const out = await leasingBookingService.bookTourIntoSlot(bc, {
                  leadId: tx1.lead_id || (await bc.query(
                    `select id from leasing_leads where person_id=$1 and property_id=$2 and status not in ('lost','leased') order by created_at limit 1`,
                    [tx1.person_id, tx1.property_id])).rows[0]?.id,
                  slotId: proposedSlotId,
                  subjectPersonId: tx1.person_id,
                  sourceCommEventId: tx1.inbound_id || null,
                  sourceAgentRunId: (tx1.run && tx1.run.id) || null,
                  idempotencyKey: bookingActionKey,
                  via: "agent_book_tour",
                  requireAgentBookingCapability: true, // permanent capability gate
                });
                await bc.query("commit");
                bookResult = out;
              } catch (e) {
                try { await bc.query("rollback"); } catch (_) {}
                // 23505 on the namespaced key = concurrent retry → resolve existing.
                if (e && e.code === "23505" && bookingActionKey) {
                  const ex = (await pool.query(`select id, scheduled_for from leasing_tours where booking_idempotency_key=$1 limit 1`, [bookingActionKey])).rows[0];
                  if (ex) bookResult = { tour: ex, alreadyBooked: true };
                }
                if (!bookResult) { bookErr = { public: e.publicMessage || "I couldn't book that time — it may have just been taken. Want me to offer other times?" }; console.error("[agent/inbound] book_tour service error:", e.message); }
              } finally { bc.release(); }
            }

            const bookToolResult = bookResult
              ? JSON.stringify({
                  booked: true,
                  already_booked: !!bookResult.alreadyBooked,
                  scheduled_for: bookResult.tour && bookResult.tour.scheduled_for,
                  note: "Tour is booked. Confirm the date/time warmly to the prospect in one short message.",
                })
              : JSON.stringify({ booked: false, reason: bookErr ? bookErr.public : "unavailable", note: "Do NOT claim the tour is booked. Tell the prospect honestly and offer alternatives." });

            r = await anthropic.messages.create({
              model: MODEL, max_tokens: 320, system: built.system,
              messages: [
                ...built.messages,
                { role: "assistant", content: r.content },
                { role: "user", content: pairAllToolResults(r.content, new Map([[bookUse.id, bookToolResult]])) },
              ],
              tools: activeTools,
            });
            providerReqId = (r && r.id) || providerReqId;
          } else if (escUses.length) {
            // ── OPERATIONAL ESCALATION WRITE (Slice 1) ─────────────────────
            // A human must DO work before the agent can answer. Create a staff
            // obligation through the SAME canonical service the inbound path
            // already uses (spawnObligationFromEvent) — no new table, no
            // parallel path. The AI keeps the conversation (no [[HANDOFF]]).
            //
            // MULTI-TASK: one inbound may name SEVERAL distinct jobs ("confirm
            // readiness AND check parking") → the model emits ONE
            // create_staff_obligation per task in the SAME turn. We loop EVERY
            // such block, writing one obligation each, and pair ALL their results
            // back. (A single .find() would drop the 2nd task — the exact bug B3
            // caught.) The tour path stays single-call by nature; escalations do not.
            //
            // IDEMPOTENCY (guardrail 2), reason-keyed so it does NOT collapse
            // two DIFFERENT tasks: dedupe_key = sha256(inbound_id + ':' + norm(reason)).
            //   • same inbound + same task (retry / concurrent double) → same
            //     key → unique index (086) converges: 23505 loser resolves to
            //     the existing row, never a duplicate, never a 500.
            //   • same inbound + a DIFFERENT task → different reason → different
            //     key → a SECOND distinct obligation. The DB never merges two real tasks.
            //
            // OWNERSHIP LADDER (guardrail 1) — each result licenses only the
            // language its row supports: routed (role) < accepted (user) < timed (due_at).
            // Slice 1 writes role-only, so the honest default is "sent to the team".
            const escResults = new Map(); // tool_use_id -> result JSON string

            // Write one obligation for a single tool block; return its result JSON.
            async function writeOneEscalation(reasonRaw) {
              const escReason = String(reasonRaw || "").trim() || "operational check requested by prospect";
              const normReason = escReason.toLowerCase().replace(/\s+/g, " ").trim();
              const escDedupeKey = tx1.inbound_id
                ? crypto.createHash("sha256").update(`${tx1.inbound_id}:${normReason}`).digest("hex")
                : null;
              let escOb = null;
              try {
                const ec = await pool.connect();
                try {
                  await ec.query("begin");
                  const existing = escDedupeKey
                    ? (await ec.query(
                        `select * from obligations where dedupe_key = $1 and type = 'operational_escalation' limit 1`,
                        [escDedupeKey]
                      )).rows[0]
                    : null;
                  if (existing) {
                    escOb = existing;
                  } else {
                    escOb = await spawnObligationFromEvent(ec, {
                      property_id: tx1.property_id, person_id: tx1.person_id, unit_id: tx1.unit_id || null,
                      // source_event_id stays NULL: its FK points at the domain-events
                      // table, which a comm_events id does not satisfy — the two working
                      // inbound writes above also pass null. Idempotency is carried by
                      // dedupe_key, DERIVED from tx1.inbound_id via one-way hash (enough
                      // to converge retries; NOT an inspectable audit link — out of
                      // scope for Slice 1).
                      source_event_id: null,
                      module: "agent", type: "operational_escalation",
                      label: escReason.slice(0, 240),
                      owner_type: "human", assigned_role: "leasing_manager",
                      dedupe_key: escDedupeKey,
                    });
                  }
                  await ec.query("commit");
                } catch (e) {
                  try { await ec.query("rollback"); } catch (_) {}
                  if (e && e.code === "23505" && escDedupeKey) {
                    const ex = (await pool.query(
                      `select * from obligations where dedupe_key=$1 and type='operational_escalation' limit 1`,
                      [escDedupeKey]
                    )).rows[0];
                    if (ex) escOb = ex;
                  }
                  if (!escOb) console.error("[agent/inbound] escalation write failed:", e.message);
                } finally { ec.release(); }
              } catch (e) { console.error("[agent/inbound] escalation connect failed:", e.message); }

              const escWritten = !!(escOb && escOb.status === "open");
              const escAccepted = !!(escOb && escOb.assigned_user_id);
              const escRouted = !!(escOb && escOb.assigned_role);
              return escWritten
                ? JSON.stringify({
                    created: true,
                    ownership: escAccepted ? "accepted" : (escRouted ? "routed" : "unassigned"),
                    due_at: escOb.due_at || null,
                    note: escOb.due_at
                      ? "The work is on the team and has a due time. You MAY say the team is working on it and you'll follow up by that time. Keep the conversation — do NOT hand off. One short warm message."
                      : escAccepted
                        ? "A teammate has this. You MAY say the team is working on it. Do NOT promise a specific time (no due time yet). Keep the conversation — do NOT hand off. One short warm message."
                        : escRouted
                          ? "This is SENT to the leasing team (routed, not yet accepted). Say you've sent it to the team and you'll follow up — do NOT say someone is already working on it and do NOT promise a specific time. Keep the conversation — do NOT hand off. One short warm message."
                          : "The work is recorded but not yet owned. Say you've flagged it for the team and you'll follow up. Do NOT promise a time. Keep the conversation — do NOT hand off. One short warm message.",
                  })
                : JSON.stringify({
                    created: false,
                    ownership: "none",
                    note: "The work could NOT be put on the team. Do NOT claim anyone is on it and do NOT promise a follow-up. Tell the prospect honestly that you're checking on it. Keep the conversation — do NOT hand off.",
                  });
            }

            // Process EVERY escalation tool block this turn (multi-task safe).
            for (const eu of escUses) {
              const reason = eu.input && eu.input.reason;
              escResults.set(eu.id, await writeOneEscalation(reason));
            }

            r = await anthropic.messages.create({
              model: MODEL, max_tokens: 320, system: built.system,
              messages: [
                ...built.messages,
                { role: "assistant", content: r.content },
                { role: "user", content: pairAllToolResults(r.content, escResults) },
              ],
              tools: activeTools,
            });
            providerReqId = (r && r.id) || providerReqId;
          }
          // After the tool round, the model's latest response `r` may STILL
          // contain a tool_use — it chained (offer→book), or called a fresh tool
          // in response to the tool_result. If we stopped here, `generated` would
          // be empty (no text block) → the run fails as no_text → silent AI; and
          // the unpaired tool_use would break replay. So: while `r` holds any
          // tool_use, pair ALL of its tool_uses and ask AGAIN — the last such
          // call is made WITHOUT tools, forcing a text-only turn. Bounded so a
          // pathological chain still resolves to plain text rather than looping.
          // We do NOT re-run governed side-effects here (offer/book already fired
          // in the branch above with full authority checks); these follow-ups are
          // purely to land a clean, dispatchable text reply. Each extra tool_use
          // is answered with a benign "not run — reply in text" stub, so the model
          // is nudged to talk, never to invent an unexecuted tool's outcome.
          let _termGuard = 0;
          while (hasToolUse(r.content) && _termGuard < 3) {
            _termGuard++;
            const lastRound = _termGuard >= 2; // final attempt: strip tools entirely
            const priorAssistant = { role: "assistant", content: r.content };
            const results = pairAllToolResults(r.content, new Map()); // none executed here → all benign stubs
            const createArgs = {
              model: MODEL, max_tokens: 320, system: built.system,
              messages: [...built.messages, priorAssistant, { role: "user", content: results }],
            };
            if (!lastRound) createArgs.tools = activeTools; // give one more chance to use a tool, then hard-stop
            r = await anthropic.messages.create(createArgs);
            providerReqId = (r && r.id) || providerReqId;
          }

          generated = (r.content || []).filter(x => x.type === "text").map(x => x.text).join("").trim();
        } else {
          genErr = "no_model_client";
        }
      } catch (e) {
        genErr = (e && e.message) ? e.message : "generation_failed";
        console.error("[agent/inbound] generation failed:", genErr);
      }

      // ── HANDOFF SENTINEL (§7): the model flags a real handoff with a trailing
      //    [[HANDOFF: reason]] tag. Strip it from what the prospect sees; record
      //    the reason so TX2 raises the human obligation. The reply text (the
      //    model's "getting the team involved" line) STILL sends — never silence.
      let modelHandoff = null;
      if (generated) {
        const mh = generated.match(/\[\[HANDOFF:\s*([^\]]*)\]\]/i);
        if (mh) { modelHandoff = (mh[1] || "unspecified").trim(); generated = generated.replace(mh[0], "").trim(); }
      }

      // post-generation policy (only if we have text)
      let policyDecision = pre.decision, policyCode = pre.code;
      if (generated && policyDecision === "safe") {
        const post = postGenerationPolicy(generated);
        if (post.decision !== "safe") { policyDecision = post.decision; policyCode = post.code; }
      }
      // GROUNDING GUARD: if the inventory tool ran, the draft may cite ONLY
      // units it returned (plus the lead's own unit). A fabricated unit number
      // blocks the draft — hallucinated inventory never reaches a prospect.
      if (generated && policyDecision === "safe" && Array.isArray(offeredUnits)) {
        const allowed = new Set(offeredUnits.map(u => String(u.unit_number).toLowerCase()));
        const leadU = tx1.selected_unit && tx1.selected_unit.unit_number;
        if (leadU) allowed.add(String(leadU).toLowerCase());
        const cited = [...generated.matchAll(/\bunit\s+#?([a-z0-9-]+)\b/gi)].map(m => m[1].toLowerCase());
        const bad = cited.find(c => !allowed.has(c));
        if (bad) { policyDecision = "blocked"; policyCode = "hallucinated_unit:" + bad; }
      }

      // ── NO-SILENCE RECOVERY (§6): a blocked reply NEVER becomes silence. Route
      //    by block type to a safe, sendable fallback. Only a fair-housing block
      //    is a normal question the AI can recover from alone; a unit-grounding
      //    block also raises an INTERNAL QA signal (not a prospect handoff).
      let qaSignal = null; // { code } → TX2 logs it; never surfaced to the prospect
      if (policyDecision === "blocked") {
        if (String(policyCode || "").startsWith("fairhousing:")) {
          generated = FALLBACK_FAIRHOUSING;
          policyDecision = "safe"; policyCode = "fairhousing_redirected";
        } else if (String(policyCode || "").startsWith("hallucinated_unit")) {
          generated = FALLBACK_INVENTORY;
          policyDecision = "safe"; policyCode = "inventory_regrounded";
          qaSignal = { code: policyCode, detail: "agent cited a unit not in the offered/available set" };
        } else {
          // Any other future block code: recover with the general fallback rather
          // than go dark. (Add specific handling above as new blocks are introduced.)
          generated = FALLBACK_GENERAL;
          policyDecision = "safe"; policyCode = "general_recovered";
        }
      }

      // If we STILL have no text at this point (model produced nothing and it
      // wasn't a handoff/block), fall back rather than send silence.
      if (!generated || !generated.trim()) {
        if (!genErr) { generated = FALLBACK_GENERAL; policyDecision = "safe"; policyCode = "empty_recovered"; }
        // (a true genErr still routes to the failed/human path in TX2 below.)
      }

      // ── PUNCTUATION GUARANTEE (§2): strip AI-style em/en dashes from the final
      //    prospect-facing text. Deterministic; the prompt rule alone won't do it.
      if (generated) generated = stripDashes(generated);

      // A model-signalled handoff is treated like requires_handoff for TX2's
      // obligation-labelling, while the (already dash-stripped) text still sends.
      if (modelHandoff && policyDecision === "safe") {
        policyDecision = "requires_handoff";
        policyCode = policyCode ? `${policyCode}+model_handoff:${modelHandoff}` : `model_handoff:${modelHandoff}`;
      }

      // ── TX2: re-lock, reject stale, create draft on success / mark failed ──
      const result = await tx(async (client) => {
        const state = await loadThreadState(client, tx1.conversation_id, true); // FOR UPDATE
        const run = (await client.query("select * from agent_runs where id=$1 for update", [tx1.run.id])).rows[0];

        // STALE CHECK: a newer inbound bumped the version → this draft is void.
        if (Number(state.thread_version) !== Number(run.input_thread_version)) {
          await client.query("update agent_runs set status='superseded' where id=$1", [run.id]);
          return { superseded: true };
        }

        // record the resolved fact snapshot + hash + provider id on the run.
        await client.query(
          "update agent_runs set resolved_fact_snapshot_json=$2, fact_snapshot_hash=$3, provider_request_id=$4, policy_decision=$5, handoff_reason_code=$6, offered_units_json=coalesce($7::jsonb, offered_units_json), selected_unit_id=coalesce($8, selected_unit_id) where id=$1",
          [run.id, JSON.stringify(factSnapshot), snapshotHash, providerReqId, policyDecision, policyCode,
           offeredUnits ? JSON.stringify(offeredUnits) : null,
           (tx1.selected_unit && tx1.selected_unit.id) || null]
        );

        if (genErr || (!generated && policyDecision !== "blocked")) {
          // MODEL FAILURE → no reply, obligation flagged attention_required, thread kept for takeover
          await client.query("update agent_runs set status='failed' where id=$1", [run.id]);
          if (run.input_thread_version && state.current_review_obligation_id) {
            await client.query(
              "update obligations set label=$2, priority='high', updated_at=now() where id=$1",
              [state.current_review_obligation_id, "AI reply FAILED — needs a human (attention required)"]
            ).catch(() => {});
          }
          await client.query("update agent_thread_state set mode='awaiting_review', updated_at=now() where conversation_id=$1", [tx1.conversation_id]);
          return { failed: true, reason: genErr || "no_text" };
        }

        if (policyDecision === "blocked") {
          // no dispatchable draft; human obligation only; thread → awaiting_review
          await client.query("update agent_runs set status='ready' where id=$1", [run.id]);
          if (state.current_review_obligation_id) {
            await client.query(
              "update obligations set label=$2, priority='high', updated_at=now() where id=$1",
              [state.current_review_obligation_id, `BLOCKED by policy (${policyCode}) — human must handle`]
            ).catch(() => {});
          }
          await client.query("update agent_thread_state set mode='awaiting_review', updated_at=now() where conversation_id=$1", [tx1.conversation_id]);
          return { blocked: true, code: policyCode };
        }

        // SUCCESS (safe or requires_handoff with a neutral ack): create the immutable draft
        await client.query("update agent_runs set status='ready' where id=$1", [run.id]);
        const draft = (await client.query(
          `insert into agent_drafts (agent_run_id, generated_body, status, review_obligation_id)
           values ($1,$2,'ready',$3) returning *`,
          [run.id, generated, state.current_review_obligation_id]
        )).rows[0];

        // INTERNAL QA SIGNAL (§6): a unit-grounding recovery is a model-quality
        // problem, not a prospect handoff. Log it for QA; the prospect already
        // got the safe inventory fallback. Structured stderr (matches the audit
        // style elsewhere) — no schema change, never the prospect's concern.
        if (qaSignal) {
          console.error(`[agent/qa] grounding_recovery conversation=${tx1.conversation_id} run=${run.id} code=${qaSignal.code} detail="${qaSignal.detail}"`);
        }

        // update the obligation to "review the draft"
        if (state.current_review_obligation_id) {
          const lbl = policyDecision === "requires_handoff"
            ? `Review AI reply (handoff: ${policyCode}) — sensitive, no normal Send`
            : "Review AI reply";
          await client.query(
            "update obligations set label=$2, updated_at=now() where id=$1",
            [state.current_review_obligation_id, lbl]
          ).catch(() => {});
        }
        await client.query("update agent_thread_state set mode='awaiting_review', updated_at=now() where conversation_id=$1", [tx1.conversation_id]);

        return { ok: true, draft_id: draft.id, policy_decision: policyDecision, handoff_reason_code: policyCode };
      });

      // ── AUTO-DISPATCH PERIMETER (funnel-flow 3c) ──────────────────────
      // The agent may dispatch its OWN draft only when ALL hold:
      //   · the property is explicitly named in AGENT_AUTO_DISPATCH_PROPERTY_IDS
      //     (absent env = OFF everywhere; review-only remains the default);
      //   · this run produced a normal safe draft (never blocked, never
      //     requires_handoff — those keep their human obligation);
      //   · dispatch itself re-checks staleness under lock (sendDraftService).
      // Provenance stays honest: dispatch_mode='auto', no borrowed human id.
      // THE NET: the SMS still leaves only through sendPropertySms — consent,
      // classification, and send-mode are enforced there regardless.
      if (result && result.ok && result.draft_id && result.policy_decision === "safe") {
        const perim = (process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS || "")
          .split(",").map(s => s.trim()).filter(Boolean);
        if (perim.includes(String(tx1.property_id))) {
          try {
            const autoOut = await sendDraftService({ draftId: result.draft_id, auto: true });
            result.auto_dispatched = true;
            result.outbound_comm_event_id = autoOut.outbound_comm_event_id;
            result.sms = autoOut.sms;

            // PROVENANCE LINK (not authority): the offer was already recorded at
            // tool-execution time (atomic supersede+insert), so it already
            // authorizes confirmation regardless of dispatch. Here we just link
            // the dispatched outbound comm_event onto that offer row for the
            // audit trail. Fire-and-forget — a dispatch hiccup never un-authorizes
            // a stated offer.
            if (recordedOfferId && autoOut.outbound_comm_event_id
                && leasingBookingService && typeof leasingBookingService.attachOutboundToOffer === "function") {
              try {
                await leasingBookingService.attachOutboundToOffer(null, {
                  offerId: recordedOfferId,
                  outboundCommEventId: autoOut.outbound_comm_event_id,
                });
              } catch (e) { console.error("[agent/inbound] attachOutboundToOffer failed (non-fatal):", e.message); }
            }
          } catch (e) {
            // stale/conflict/etc → the draft simply remains for human review
            result.auto_dispatched = false;
            result.auto_dispatch_reason = e.publicMessage || e.message;
          }
        }
      }

      // ── SLICE 2 hook: capture volunteered prospect facts, fire-and-forget. ──
      // AFTER the draft transaction (never inside it), non-blocking, fail-soft:
      // a capture failure can never delay or break the reply loop.
      try {
        prospectCapture.captureFromConversation({
          conversationId: tx1.conversation_id, personId: tx1.person_id, propertyId: tx1.property_id,
        }).catch(() => {});
      } catch (_) {}

      return { status: 200, body: result };
    } catch (e) {
      // CONCURRENCY: two Twilio deliveries with the same MessageSid can race
      // past the pre-check above and both attempt the inbound insert. The
      // UNIQUE index on comm_events.sms_sid makes the loser raise 23505. That
      // is not a failure — it is the idempotency guarantee firing. Resolve the
      // existing row and return it as an idempotent replay (never a 500).
      if (e && e.code === "23505" && b && b.sms_sid) {
        const existing = (await pool.query(
          `select id from comm_events where sms_sid = $1 limit 1`, [b.sms_sid]
        )).rows[0];
        if (existing) {
          return { status: 200, body: { ok: true, idempotentReplay: true, inbound_comm_event_id: existing.id } };
        }
      }
      console.error("[agent/inbound]", e && e.message ? e.message : e);
      return { status: e.httpStatus || 500, body: { error: e.publicMessage || "agent inbound failed" } };
    }
  }

  // THIN ROUTE: the public door. Delegates to the shared service; both this
  // route and the SMS webhook (via router._service.processInbound) run the
  // SAME in-process path — no loopback HTTP boundary.
  router.post("/agent/inbound", async (req, res) => {
    const out = await processInbound(req.body || {});
    return res.status(out.status).json(out.body);
  });

  // ── manager READ: the current draft + thread state for a conversation ──────
  // Demo-friendly: resolve conversation from (property_id, person_id).
  // ── SHARED ACTION SERVICE: getConversationState (by resolved conversationId) ──
  // Returns the thread read both doors render. Caller resolves+authorizes the
  // conversation first (demo: by person+property; operator: scoped to session).
  async function getConversationStateService({ conversationId }) {
    const client = await pool.connect();
    try {
      const conv = (await client.query("select * from conversations where id=$1", [conversationId])).rows[0];
      if (!conv) return { exists: false, messages: [], draft: null, mode: null };

      const state = (await client.query("select * from agent_thread_state where conversation_id=$1", [conv.id])).rows[0] || null;
      const messages = (await client.query(
        `select id, direction, body, sender_role, ai_drafted_at, sent_by_user_id, occurred_at,
                provider_status, provider_status_updated_at
           from comm_events where conversation_id=$1 and channel='text' and body is not null
           order by occurred_at asc nulls last, id asc`,
        [conv.id]
      )).rows;
      const draft = (await client.query(
        `select d.id, d.generated_body, d.status, r.policy_decision, r.handoff_reason_code, r.status as run_status
           from agent_drafts d join agent_runs r on r.id=d.agent_run_id
          where r.conversation_id=$1 and d.status='ready'
          order by d.created_at desc limit 1`,
        [conv.id]
      )).rows[0] || null;

      return {
        exists: true, conversation_id: conv.id,
        // person + property of THIS conversation — the live detail must carry them
        // so operator actions (e.g. Send application) act on the real person/scope,
        // never a fixture. unit_id lets the send action use the conversation's unit
        // when one is attached (else the operator selects a leaseable one).
        // Additive; existing consumers ignore unknown fields.
        person_id: conv.person_id || null,
        property_id: conv.property_id || null,
        unit_id: conv.unit_id || null,
        mode: state ? state.mode : "ai_active",
        thread_version: state ? Number(state.thread_version) : 0,
        messages, draft,
      };
    } finally { client.release(); }
  }

  // helper: resolve the canonical conversation by (person, property). Used by demo routes.
  async function resolveConversationByPair(person_id, property_id) {
    const c = (await pool.query(
      "select * from conversations where person_id=$1 and property_id=$2 order by created_at limit 1",
      [person_id, property_id]
    )).rows[0];
    return c || null;
  }

  // LEGACY/DEMO adapter route.
  router.get("/agent/thread", async (req, res) => {
    try {
      const property_id = req.query.property_id, person_id = req.query.person_id;
      if (!property_id || !person_id) return res.status(400).json({ error: "property_id and person_id required" });
      const conv = await resolveConversationByPair(person_id, property_id);
      if (!conv) return res.json({ exists: false, messages: [], draft: null, mode: null });
      const out = await getConversationStateService({ conversationId: conv.id });
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── manager ACTIONS ────────────────────────────────────────────────────────
  // All resolve the manager identity SERVER-SIDE. Body carries the draft_id only.

  // SEND (optionally edited): dispatch the draft as a real OUTBOUND comm_event.
  // Enforces the stale-draft invariant: draft.status=ready AND run version == thread version.
  // ── SHARED ACTION SERVICE: sendDraft ──────────────────────────────────────
  // The single source of truth for dispatching a draft. Both the legacy /agent/*
  // route and the authenticated /operator/* route call THIS. The actor identity is
  // supplied by the caller (server-derived) — never inferred from browser input.
  // Enforces: stale-draft guarantee, immutable generated_body vs dispatch_body,
  // canonical outbound comm_event, obligation completion, return-to-ai_active.
  async function sendDraftService({ draftId, editedBody, actorUserId, auto = false }) {
    // HONEST PROVENANCE: a human dispatch requires the human's server-derived
    // identity; an AUTO dispatch must NOT borrow one — dispatched_by stays null
    // and dispatch_mode='auto' says exactly what happened.
    if (!auto && !actorUserId) throw httpErr(400, "actorUserId is required (server-derived).");
    if (auto && actorUserId) throw httpErr(400, "auto dispatch must not carry a human actor.");
    const out = await tx(async (client) => {
      const d = (await client.query("select * from agent_drafts where id=$1 for update", [draftId])).rows[0];
      if (!d) throw httpErr(404, "Draft not found.");
      if (d.status !== "ready") throw httpErr(409, `Draft is '${d.status}', not sendable.`);

      const run = (await client.query("select * from agent_runs where id=$1", [d.agent_run_id])).rows[0];
      const state = await loadThreadState(client, run.conversation_id, true); // FOR UPDATE

      // STALE GUARANTEE: a newer inbound exists → cannot send.
      if (Number(state.thread_version) !== Number(run.input_thread_version)) {
        await client.query("update agent_drafts set status='superseded', superseded_at=now(), updated_at=now() where id=$1", [draftId]);
        throw httpErr(409, "A newer message arrived — this draft is stale and can't be sent. A fresh draft is being prepared.");
      }

      const conv = (await client.query("select * from conversations where id=$1", [run.conversation_id])).rows[0];
      const mgrId = auto ? null : actorUserId;
      const bodyToSend = (!auto && editedBody && editedBody.trim()) ? editedBody.trim() : d.generated_body;
      const person = (await client.query("select id, phone from persons where id=$1", [conv.person_id])).rows[0] || {};

      // dispatch → a REAL outbound comm_event (with AI-drafted + sent-by provenance)
      const outbound = (await client.query(
        `insert into comm_events
           (property_id, person_id, conversation_id, channel, direction, body, classification, sender_role,
            ai_drafted_at, human_approved_by_user_id, human_approved_at, sent_by_user_id, occurred_at)
         values ($1,$2,$3,'text','outbound',$4,'leasing','agent', now(), $5, now(), $5, now())
         returning id`,
        [conv.property_id, conv.person_id, conv.id, bodyToSend, mgrId]
      )).rows[0];
      await client.query("update conversations set last_message_at = now() where id=$1", [conv.id]);

      // mark the draft dispatched; record what was actually sent (immutable generated_body preserved)
      await client.query(
        `update agent_drafts set status='dispatched', dispatch_body=$2, dispatched_comm_event_id=$3,
           dispatched_by_user_id=$4, dispatch_mode=$5, dispatched_at=now(), updated_at=now() where id=$1`,
        [draftId, bodyToSend, outbound.id, mgrId, auto ? "auto" : "human"]
      );

      // complete the review obligation; return thread to ai_active for the next turn
      if (state.current_review_obligation_id && completeObligation) {
        await completeObligation(client, { obligation_id: state.current_review_obligation_id, completed_by: mgrId })
          .catch(e => { if (e.code !== "ALREADY_COMPLETE") throw e; });
      }
      await client.query(
        "update agent_thread_state set mode='ai_active', current_review_obligation_id=null, updated_at=now() where conversation_id=$1",
        [conv.id]
      );

      return { ok: true, outbound_comm_event_id: outbound.id, sent_body: bodyToSend,
               edited: !!(!auto && editedBody && editedBody.trim()),
               property_id: conv.property_id, person_id: conv.person_id, person_phone: person.phone || null,
               dispatch_mode: auto ? "auto" : "human" };
    });

    // ── THE WIRE (funnel-flow 3b): AFTER commit, the dispatched reply leaves
    // through the ONE communications gate. Consent, classification, send-mode,
    // and the property line are enforced there; refusals stamp the comm_event
    // honestly. In Phase A (disabled) this refuses — which is correct.
    if (out && out.ok && commBoundary && out.person_phone) {
      try {
        const wire = await commBoundary.sendPropertySms({
          property_id: out.property_id, recipient: out.person_phone, body: out.sent_body,
          purpose: "ai_reply", person_id: out.person_id, eventId: out.outbound_comm_event_id,
          actor_user_id: actorUserId || null,
        });
        out.sms = { sent: wire.sent, reason: wire.reason };
      } catch (e) {
        console.error("[agent/dispatch] gate call failed (event stamped separately):", e.message);
        out.sms = { sent: false, reason: "gate_error" };
      }
    } else if (out && out.ok) {
      out.sms = { sent: false, reason: commBoundary ? "no_phone_on_person" : "boundary_not_wired" };
    }
    return out;
  }

  // LEGACY/DEMO adapter route — thin wrapper over sendDraftService with the seeded
  // demo manager as actor. (Demo-access restrictions apply via the allowlist; the
  // durable manager interface is /operator/agent-drafts/:id/send.)
  router.post("/agent/drafts/:id/send", async (req, res) => {
    const editedBody = (req.body && typeof req.body.body === "string") ? req.body.body : null;
    try {
      const client0 = await pool.connect();
      let actorUserId;
      try { actorUserId = await demoManagerUserId(client0); }
      finally { client0.release(); }
      const out = await sendDraftService({ draftId: req.params.id, editedBody, actorUserId });
      return res.json(out);
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  // TAKE OVER: thread → human_takeover. AI stops drafting/sending. No silent re-entry.
  // ── SHARED ACTION SERVICE: takeOverConversation ──────────────────────────
  // thread → human_takeover; discards ready draft; redirects obligation. AI stops.
  // Caller resolves+authorizes the conversation; actor supplied server-side.
  async function takeOverConversationService({ conversationId, actorUserId }) {
    if (!actorUserId) throw httpErr(400, "actorUserId is required (server-derived).");
    return tx(async (client) => {
      const conv = (await client.query("select * from conversations where id=$1", [conversationId])).rows[0];
      if (!conv) throw httpErr(404, "No conversation.");
      const state = await loadThreadState(client, conv.id, true);
      const mgrId = actorUserId;

      await client.query(
        `update agent_drafts d set status='discarded', discarded_at=now(), updated_at=now()
           from agent_runs r where d.agent_run_id=r.id and r.conversation_id=$1 and d.status='ready'`,
        [conv.id]
      );
      if (state.current_review_obligation_id) {
        await client.query(
          "update obligations set label='Human takeover — leasing manager owns this thread', updated_at=now() where id=$1",
          [state.current_review_obligation_id]
        ).catch(() => {});
      }
      await client.query("update agent_thread_state set mode='human_takeover', updated_at=now() where conversation_id=$1", [conv.id]);
      return { ok: true, mode: "human_takeover", by: mgrId };
    });
  }

  // HAND BACK: thread human_takeover -> ai_active. The EXPLICIT counterpart to
  // take-over. The no-silent-re-entry invariant holds: only a deliberate,
  // server-authenticated manager action (this service, or an approved draft
  // send) returns a taken-over thread to the AI. Completes the takeover
  // obligation (the human obligation ends when the human hands the thread
  // back) and nulls the pointer -- mirrors sendDraftService's cleanup shape.
  // Caller resolves+authorizes the conversation; actor is server-derived.
  async function handBackConversationService({ conversationId, actorUserId }) {
    if (!actorUserId) throw httpErr(400, "actorUserId is required (server-derived).");
    return tx(async (client) => {
      const conv = (await client.query("select * from conversations where id=$1", [conversationId])).rows[0];
      if (!conv) throw httpErr(404, "No conversation.");
      const state = await loadThreadState(client, conv.id, true);
      if (state.mode !== "human_takeover") throw httpErr(409, "Thread is '" + state.mode + "', not in human takeover.");
      const mgrId = actorUserId;
      if (state.current_review_obligation_id && completeObligation) {
        await completeObligation(client, { obligation_id: state.current_review_obligation_id, completed_by: mgrId })
          .catch(e => { if (e.code !== "ALREADY_COMPLETE") throw e; });
      }
      await client.query(
        "update agent_thread_state set mode='ai_active', current_review_obligation_id=null, updated_at=now() where conversation_id=$1",
        [conv.id]
      );
      return { ok: true, mode: "ai_active", by: mgrId };
    });
  }

  // LEGACY/DEMO adapter route.
  router.post("/agent/thread/takeover", async (req, res) => {
    try {
      const property_id = req.body && req.body.property_id, person_id = req.body && req.body.person_id;
      if (!property_id || !person_id) return res.status(400).json({ error: "property_id and person_id required" });
      const conv = await resolveConversationByPair(person_id, property_id);
      if (!conv) return res.status(404).json({ error: "No conversation." });
      const client0 = await pool.connect();
      let actorUserId;
      try { actorUserId = await demoManagerUserId(client0); } finally { client0.release(); }
      const out = await takeOverConversationService({ conversationId: conv.id, actorUserId });
      return res.json(out);
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  // REGENERATE: new run + new draft (does NOT mutate the old). Supersedes the prior
  // ready draft. SAME review obligation (no duplicate). Re-runs the model.
  // ── SHARED ACTION SERVICE: regenerateDraft ───────────────────────────────
  // New run + new draft (never mutates the old); supersedes prior ready draft; SAME
  // review obligation (no duplicate); re-runs the model via the locked two-tx pattern.
  // Returns plain result data. Both doors call this; caller authorizes the conversation.
  async function regenerateDraftService({ property_id, person_id }) {
    {
      if (!property_id || !person_id) throw httpErr(400, "property_id and person_id required");

      // TX1': supersede prior draft, create a new pending run at the CURRENT version,
      // generation_no = max+1, reason=manager_regenerate. (Same obligation.)
      const prep = await tx(async (client) => {
        const conv = (await client.query(
          "select * from conversations where person_id=$1 and property_id=$2 order by created_at limit 1",
          [person_id, property_id]
        )).rows[0];
        if (!conv) throw httpErr(404, "No conversation.");
        const state = await loadThreadState(client, conv.id, true);
        if (state.mode === "human_takeover" || state.mode === "closed") {
          throw httpErr(409, `Thread is ${state.mode}; AI is off. Re-enable before regenerating.`);
        }
        // the inbound this is responding to = latest inbound on the thread
        const inbound = state.latest_inbound_comm_event_id;
        if (!inbound) throw httpErr(409, "No inbound message to respond to.");

        await client.query(
          `update agent_drafts d set status='superseded', superseded_at=now(), updated_at=now()
             from agent_runs r where d.agent_run_id=r.id and r.conversation_id=$1 and d.status='ready'`,
          [conv.id]
        );
        const maxGen = (await client.query(
          "select coalesce(max(generation_no),0) as m from agent_runs where conversation_id=$1 and input_thread_version=$2",
          [conv.id, state.thread_version]
        )).rows[0].m;

        const run = (await client.query(
          `insert into agent_runs
             (conversation_id, inbound_comm_event_id, input_thread_version, generation_no,
              generation_reason, status, prompt_revision, policy_revision, model)
           values ($1,$2,$3,$4,'manager_regenerate','pending',$5,$6,$7) returning *`,
          [conv.id, inbound, state.thread_version, Number(maxGen) + 1, PROMPT_REVISION, POLICY_REVISION, MODEL]
        )).rows[0];

        // the inbound text + context coordinates
        const inb = (await client.query("select body, unit_id from comm_events where id=$1", [inbound])).rows[0];
        return { conv, run, version: state.thread_version, inboundText: inb.body, unit_id: inb.unit_id,
                 property_id, person_id, review_obligation_id: state.current_review_obligation_id };
      });

      // model OUTSIDE txn (reuse the same generation path)
      const pre = preGenerationPolicy(prep.inboundText);
      let generated = null, providerReqId = null, genErr = null, factSnapshot = [], snapshotHash = "";
      try {
        const c0 = await pool.connect();
        let ctx;
        try { ctx = await resolveContext(c0, { property_id: prep.property_id, unit_id: prep.unit_id }); }
        finally { c0.release(); }
        factSnapshot = ctx.facts; snapshotHash = sha(factSnapshot);
        const c1 = await pool.connect();
        let history;
        try {
          history = (await c1.query(
            `select direction, body from comm_events where conversation_id=$1 and channel='text' and body is not null order by occurred_at asc nulls last, id asc limit 40`,
            [prep.conv.id]
          )).rows;
        } finally { c1.release(); }

        if (pre.decision === "requires_handoff") {
          generated = pre.ack || "Yep, I'll get someone from the team on this.";
        } else if (anthropic) {
          const c2 = await pool.connect();
          let propName;
          try { propName = (await c2.query("select coalesce(display_name, name) as name from properties where id=$1", [prep.property_id])).rows[0]?.name || null; }
          finally { c2.release(); }
          const built = buildMessages({ persona: PERSONA, facts: ctx.facts, unit: ctx.unit, history, propertyName: propName });
          built.system += await upcomingTourAddendum(prep.conv.id);
          const r = await anthropic.messages.create({ model: MODEL, max_tokens: 320, system: built.system, messages: built.messages });
          providerReqId = (r && r.id) || null;
          generated = (r.content || []).filter(x => x.type === "text").map(x => x.text).join("").trim();
        } else { genErr = "no_model_client"; }
      } catch (e) { genErr = (e && e.message) || "generation_failed"; }

      // Same guarantees as the inbound path: strip a handoff sentinel, recover a
      // blocked reply to a safe fallback, and strip AI dashes — because a
      // manager-approved regenerated draft is sent to the prospect verbatim.
      let modelHandoff = null;
      if (generated) {
        const mh = generated.match(/\[\[HANDOFF:\s*([^\]]*)\]\]/i);
        if (mh) { modelHandoff = (mh[1] || "unspecified").trim(); generated = generated.replace(mh[0], "").trim(); }
      }
      let policyDecision = pre.decision, policyCode = pre.code;
      if (generated && policyDecision === "safe") {
        const post = postGenerationPolicy(generated);
        if (post.decision !== "safe") { policyDecision = post.decision; policyCode = post.code; }
      }
      if (policyDecision === "blocked") {
        if (String(policyCode || "").startsWith("fairhousing:")) { generated = FALLBACK_FAIRHOUSING; policyDecision = "safe"; policyCode = "fairhousing_redirected"; }
        else { generated = FALLBACK_GENERAL; policyDecision = "safe"; policyCode = "general_recovered"; }
      }
      if (!generated || !generated.trim()) { if (!genErr) { generated = FALLBACK_GENERAL; policyDecision = "safe"; policyCode = "empty_recovered"; } }
      if (generated) generated = stripDashes(generated);
      if (modelHandoff && policyDecision === "safe") { policyDecision = "requires_handoff"; policyCode = policyCode ? `${policyCode}+model_handoff:${modelHandoff}` : `model_handoff:${modelHandoff}`; }

      // TX2'
      const result = await tx(async (client) => {
        const state = await loadThreadState(client, prep.conv.id, true);
        const run = (await client.query("select * from agent_runs where id=$1 for update", [prep.run.id])).rows[0];
        if (Number(state.thread_version) !== Number(run.input_thread_version)) {
          await client.query("update agent_runs set status='superseded' where id=$1", [run.id]);
          return { superseded: true };
        }
        await client.query(
          "update agent_runs set resolved_fact_snapshot_json=$2, fact_snapshot_hash=$3, provider_request_id=$4, policy_decision=$5, handoff_reason_code=$6 where id=$1",
          [run.id, JSON.stringify(factSnapshot), snapshotHash, providerReqId, policyDecision, policyCode]
        );
        if (genErr || (!generated && policyDecision !== "blocked")) {
          await client.query("update agent_runs set status='failed' where id=$1", [run.id]);
          if (state.current_review_obligation_id) {
            await client.query("update obligations set label='AI reply FAILED — needs a human', priority='high', updated_at=now() where id=$1", [state.current_review_obligation_id]).catch(() => {});
          }
          return { failed: true, reason: genErr || "no_text" };
        }
        if (policyDecision === "blocked") {
          await client.query("update agent_runs set status='ready' where id=$1", [run.id]);
          return { blocked: true, code: policyCode };
        }
        await client.query("update agent_runs set status='ready' where id=$1", [run.id]);
        const draft = (await client.query(
          "insert into agent_drafts (agent_run_id, generated_body, status, review_obligation_id) values ($1,$2,'ready',$3) returning *",
          [run.id, generated, state.current_review_obligation_id]
        )).rows[0];
        return { ok: true, draft_id: draft.id, regenerated: true, policy_decision: policyDecision };
      });

      return result;
    }
  }

  // LEGACY/DEMO adapter route.
  router.post("/agent/thread/regenerate", async (req, res) => {
    try {
      const property_id = req.body && req.body.property_id, person_id = req.body && req.body.person_id;
      const out = await regenerateDraftService({ property_id, person_id });
      return res.json(out);
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  // The SHARED ACTION SERVICES — the single source of truth for the consequential
  // operator actions. Both the legacy /agent/* adapter routes and the authenticated
  // /operator/* routes call THESE. (editAndSend = sendDraftService with editedBody.)
  router._service = {
    preGenerationPolicy, postGenerationPolicy, resolveContext, buildMessages,
    sendDraftService, getConversationStateService, takeOverConversationService,
    handBackConversationService,
    regenerateDraftService, resolveConversationByPair,
    processInbound,
  };
  // TEST-ONLY (Class 3, inert at runtime): exposes the pure tool-loop message-
  // assembly helpers so the proof harness exercises the REAL functions, not a
  // copy. No route, no side effect — safe to ship, used only by prove_*.js.
  router.__test__ = { pairAllToolResults, hasToolUse, stripDashes, preGenerationPolicy, postGenerationPolicy };
  return router;
};
