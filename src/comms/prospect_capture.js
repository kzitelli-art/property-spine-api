"use strict";
/**
 * prospect_capture.js — SLICE 2: the AI gathers what the prospect VOLUNTEERS.
 *
 * WHAT THIS IS
 *   After the agent drafts a reply to an inbound, this service reads the
 *   prospect's own words (inbound messages ONLY) and extracts the handful of
 *   facts they explicitly stated — budget, unit type, occupants, pets, move
 *   timing, reason for moving — into the typed person_attributes store
 *   (migration 061). The Person Card's vitals light up as facts arrive.
 *
 * DOCTRINE GUARDS (each one load-bearing):
 *   • VOLUNTEERED ONLY. The model is instructed to extract nothing that the
 *     prospect did not explicitly state. Uncertain → null. It never infers
 *     ("student housing" ≠ "they are a student"), never guesses, never fills.
 *   • PROSPECT WORDS ONLY. Outbound/AI/staff messages are excluded from the
 *     input — the system never "extracts" facts it planted itself.
 *   • HONEST BLANK. A null slot writes NOTHING. Absence of a row = unknown.
 *   • ACCRETIVE, NEVER DESTRUCTIVE. A new value retires the prior active row
 *     and inserts; history is preserved. Same value twice = no-op.
 *   • SOURCED. Every row carries source='ai_conversation' + the comm_event id
 *     of the latest inbound it was extracted from (the receipt).
 *   • FAIL-SOFT. This runs fire-and-forget after the draft is created. Any
 *     failure (model, parse, missing table) is logged and swallowed — capture
 *     can NEVER break the conversation loop it rides on.
 *   • NEVER protected-class or sensitive data. The prompt whitelists the six
 *     keys; anything else the prospect says is ignored by construction.
 *
 * Deps: { pool, anthropic, INGEST_MODEL }. Exposes { captureFromConversation }.
 * No routes. No obligations. Reads comm_events; writes person_attributes only.
 */
module.exports = function prospectCapture(deps) {
  const { pool, anthropic, INGEST_MODEL } = deps || {};
  if (!pool) throw new Error("prospect_capture requires { pool }");
  const MODEL = INGEST_MODEL || "claude-sonnet-4-6";

  const KEYS = ["move_month", "budget", "unit_type", "occupants", "pets", "reason"];

  function extractionPrompt(inboundLines) {
    return (
      "You extract structured facts a rental PROSPECT explicitly volunteered in their own text messages. " +
      "Below are ONLY the prospect's messages (newest last), from one conversation with an apartment community.\n\n" +
      "Return ONLY valid JSON (no prose, no fences) with EXACTLY these keys:\n" +
      '{ "move_month": null, "budget": null, "unit_type": null, "occupants": null, "pets": null, "reason": null }\n\n' +
      "RULES — each is absolute:\n" +
      "- A value ONLY when the prospect EXPLICITLY stated it. If not clearly stated: null. NEVER infer, guess, or fill.\n" +
      "- move_month: 'YYYY-MM' if they named a month/timeframe that maps to one clearly (assume the CURRENT or NEXT year, whichever is upcoming), or 'flexible' if they said they're flexible. Vague ('soon', 'asap') → null.\n" +
      "- budget: their stated budget, short verbatim-ish text (e.g. '$1,400/mo', 'under $1,600', '$800 per person'). No number stated → null.\n" +
      "- unit_type: what they asked for (e.g. 'studio', '1 bedroom', '2BR', 'room in a shared unit'). Not stated → null.\n" +
      "- occupants: how many people will live there, as short text (e.g. '2', 'just me', 'me + roommate'). Not stated → null.\n" +
      "- pets: what they said about pets (e.g. '1 dog', 'cat', 'no pets'). Not mentioned → null.\n" +
      "- reason: why they're moving IF they said it (e.g. 'starting at Drexel in fall', 'new job in the city'). Not stated → null.\n" +
      "- NEVER include race, religion, national origin, familial status beyond a plain occupant count, disability, or any protected-class detail — even if mentioned. Those are null.\n" +
      "- Keep every value under 60 characters.\n\n" +
      "Prospect's messages:\n\"\"\"\n" + inboundLines + "\n\"\"\""
    );
  }

  // Normalize + validate model output down to safe short strings. Anything
  // malformed → null (honest blank). This is the last line of defense: even a
  // misbehaving model cannot write junk shapes into the store.
  function sanitize(parsed) {
    const out = {};
    for (const k of KEYS) {
      let v = parsed && parsed[k];
      if (v == null) { out[k] = null; continue; }
      v = String(v).trim();
      if (!v || v.toLowerCase() === "null" || v.length > 60) { out[k] = null; continue; }
      if (k === "move_month" && v !== "flexible" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) { out[k] = null; continue; }
      // reason / unit_type / pets are descriptive text — a value with no letters is
      // junk, not a fact ("123" is never a reason someone is moving). occupants and
      // budget stay numeric-friendly ("2", "$1,500").
      if ((k === "reason" || k === "unit_type" || k === "pets") && !/[a-zA-Z]/.test(v)) { out[k] = null; continue; }
      out[k] = v;
    }
    return out;
  }

  // Fact writing is no longer hand-rolled here. recordPersonFact
  // (src/identity/person_facts.js) is the ONE canonical write — the same
  // one the form intake and the tour capture use — so every fact carries
  // identical provenance instead of three different partial versions.
  const { recordPersonFact } = require("../identity/person_facts");

  /**
   * captureFromConversation — the whole slice-2 write path.
   * Fire-and-forget safe: catches everything, returns a receipt object either way.
   *   { ok, captured: {key: value}, changed: [keys], skipped_reason? }
   */
  async function captureFromConversation({ conversationId, personId, propertyId }) {
    try {
      if (!anthropic) return { ok: false, skipped_reason: "no_model_client", changed: [] };
      if (!conversationId || !personId) return { ok: false, skipped_reason: "missing_ids", changed: [] };

      // PROSPECT WORDS ONLY: inbound messages, newest last, capped window.
      // occurred_at is now SELECTED, not just sorted on. A fact's occurred
      // time is the moment the prospect actually said it — the inbound
      // message's own business time — not the moment we got around to
      // extracting it. Every writer in this codebase previously passed
      // write time for both, which made a proxy indistinguishable from a
      // real observation.
      const inbound = (await pool.query(
        `select id, body, occurred_at from comm_events
          where conversation_id=$1 and channel='text' and direction='inbound' and body is not null
          order by occurred_at desc nulls last, id desc limit 12`,
        [conversationId]
      )).rows.reverse();
      if (inbound.length === 0) return { ok: true, changed: [], skipped_reason: "no_inbound" };

      const latestInbound = inbound[inbound.length - 1];
      const latestInboundId = latestInbound.id;
      const latestInboundAt = latestInbound.occurred_at || null;
      const lines = inbound.map((m) => "- " + String(m.body).slice(0, 400)).join("\n");

      const r = await anthropic.messages.create({
        model: MODEL, max_tokens: 300,
        messages: [{ role: "user", content: extractionPrompt(lines) }],
      });
      const raw = (r.content || []).filter((x) => x.type === "text").map((x) => x.text).join("").trim()
        .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (_) { return { ok: false, skipped_reason: "unparseable_extraction", changed: [] }; }

      const facts = sanitize(parsed);
      const changed = [];
      const client = await pool.connect();
      try {
        await client.query("begin");
        for (const k of KEYS) {
          if (facts[k] == null) continue;                    // honest blank: write nothing
          // SAVEPOINT PER FACT. recordPersonFact is retire-then-insert against a
          // partial unique index, so a concurrent capture (an inbound text racing
          // a tour close on the same person+key) raises 23505. Without a savepoint
          // that one collision aborts this transaction and discards ALL the other
          // facts extracted from the same message — five good facts lost to one
          // race. Now a collision costs exactly the fact that collided, and says so.
          await client.query("savepoint pa_fact");
          try {
            const u = await recordPersonFact(client, {
              personId, propertyId: propertyId || null,
              attrKey: k, attrValue: facts[k],
              source: "ai_conversation",              // the capture CHANNEL
              sourceRecordType: "comm_event",         // the receipt, TYPED
              sourceRecordId: latestInboundId,
              // when they said it, not when we extracted it
              occurredAt: latestInboundAt || null,
              occurredAtBasis: latestInboundAt ? "source_record" : null,
              actorType: "agent",                     // the AI recorded this
              claimStrength: "asserted",              // a prospect's self-report
              verb: "captured",
              // a retried inbound (Twilio redelivery) must not accrete a
              // second identical claim, nor retire a value it will not replace
              idempotencyKey: `captured:comm_event:${latestInboundId}:${k}`,
            });
            await client.query("release savepoint pa_fact");
            if (u.written) changed.push(k);
          } catch (e) {
            await client.query("rollback to savepoint pa_fact").catch(() => {});
            console.error(`[prospect_capture] fact '${k}' not written (non-fatal):`, (e && e.message) || "unknown");
          }
        }
        await client.query("commit");
      } catch (e) {
        try { await client.query("rollback"); } catch (_) {}
        throw e;
      } finally { client.release(); }

      return { ok: true, captured: facts, changed };
    } catch (e) {
      // FAIL-SOFT: capture must never break the loop it rides on.
      console.error("[prospect_capture] capture failed (non-fatal):", (e && e.message) || "unknown");
      return { ok: false, skipped_reason: "error", changed: [] };
    }
  }

  // _upsertAttribute is gone: fact writing moved to the ONE canonical
  // service (src/identity/person_facts.js). Nothing in the repo imported
  // it — verified by grep before removal.
  return { captureFromConversation, _sanitize: sanitize };
};
