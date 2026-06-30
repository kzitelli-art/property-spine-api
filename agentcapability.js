// agentcapability.js — STAGE 0: model capability proof.
//
// Purpose: prove the live backend can actually reach Anthropic and get a
// generation — BEFORE any agent architecture is built on that assumption.
// "The key is present" (an env var) is NOT proof the model path works.
//
// This is deliberately tiny and SAFE:
//   • Sits BEHIND the operator gate (NOT on the public /demo/ allowlist).
//   • Makes ONE real anthropic.messages.create call.
//   • Returns ONLY { ok, reachable, model } — never the key, never raw provider
//     error text, never anything sensitive. Errors are logged server-side only.
//   • No database, no schema change, no migration. Pure capability check.
//
// Mount (server.js), alongside the other anthropic-backed modules:
//   const agentCapabilityModule = require("./agentcapability");
//   app.use("/", agentCapabilityModule({ anthropic, INGEST_MODEL }));

module.exports = function agentCapabilityModule({ anthropic, INGEST_MODEL }) {
  const router = require("express").Router();
  const MODEL = INGEST_MODEL || "claude-sonnet-4-6";

  // GET /agent/capability — protected (operator gate). One real generation.
  router.get("/agent/capability", async (_req, res) => {
    if (!anthropic) {
      // honest: no client constructed at all (key missing at boot)
      console.error("[agent/capability] no anthropic client — ANTHROPIC_API_KEY likely unset");
      return res.json({ ok: false, reachable: false, model: MODEL, reason: "client_unavailable" });
    }
    try {
      const r = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with exactly the word: ready" }],
      });
      const text = (r.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim()
        .toLowerCase();
      const got = text.includes("ready");
      // server-side log ONLY — provider reachable, model selected, request ok, response received
      console.log(`[agent/capability] reachable=true model=${MODEL} request=ok response=${got ? "received" : "unexpected"}`);
      return res.json({ ok: true, reachable: true, model: MODEL, response_ok: got });
    } catch (e) {
      // log the real reason server-side; NEVER leak it (or the key) to the caller
      console.error("[agent/capability] generation failed:", e && e.message ? e.message : e);
      return res.status(502).json({ ok: false, reachable: false, model: MODEL, reason: "generation_failed" });
    }
  });

  return router;
};
