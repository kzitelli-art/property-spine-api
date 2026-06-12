// ════════════════════════════════════════════════════════════════════
//  INTAKE — DOOR 2: text / email / web field-event capture.
//
//  THE THESIS THIS SERVES: record the truth at the moment of the event,
//  and reporting becomes a read, not a project.
//
//  THE CAPTURE STANDARD:
//    Tech texts: "Unit 3B toilet fixed. Replaced fill valve. $18.72 Home Depot."
//    + photo of the receipt.
//    System extracts property / unit / amount / vendor / kind / proof, and
//    replies with ONE confirmation + ONE question, max:
//    "Got it — 3B toilet repair, $18.72 materials, receipt captured.
//     Was this tenant-caused? Yes / No / Not sure."
//
//  THE RULES (locked):
//    • AI can SUGGEST the fact. A human / proof source CONFIRMS the fact.
//      Only confirmed facts hit reporting.
//    • One question per event, maximum. Everything else AI is unsure about
//      goes silently to the review queue — the field gets one tap, the back
//      office absorbs the ambiguity.
//    • Intake NEVER writes institutional state. The review queue's buttons
//      call the REAL existing endpoints (/work-orders, /money-events) through
//      their own gates, then record the tie back here (routed_kind/routed_id).
//      If capturing is harder than texting a photo, people batch — and
//      batching is reconstruction.
//
//  ROUTES:
//    GET  /intake                       — the capture page (mobile, thread-style)
//    GET  /intake/review                — the review queue page (door 3)
//    POST /intake/capture               — capture an event (text + optional photo)
//    POST /intake/twilio                — Twilio SMS webhook adapter (TwiML reply)
//    POST /intake/events/:id/answer     — record the one-question answer
//    GET  /intake/queue                 — queue JSON (unrouted events)
//    POST /intake/events/:id/routed     — record the tie to a real record
//    POST /intake/events/:id/dismiss    — not a real event; close it
//    GET  /intake/media/:id             — serve the captured proof photo
//
//  GATE: INTAKE_PASSWORD env var (falls back to PUBLIC_REVIEW_PASSWORD so
//  zero new config is needed to start). Twilio route is gated instead by an
//  optional INTAKE_ALLOWED_NUMBERS allowlist (comma-separated; if unset,
//  any sender is accepted and the sender string is simply recorded).
//
//  Mount in server.js (after registryInstance exists, near the other mounts):
//    const intakeModule = require("./intake");
//    app.use("/", intakeModule({ pool, anthropic, INGEST_MODEL, registryInstance, upload }));
// ════════════════════════════════════════════════════════════════════

module.exports = function intake(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool, anthropic, INGEST_MODEL, registryInstance, upload } = deps;

  if (!pool) throw new Error("intake requires a pool");
  if (!anthropic) throw new Error("intake requires the anthropic client");
  if (!registryInstance || !registryInstance.resolveOnly) throw new Error("intake requires registryInstance with resolveOnly");
  if (!upload) throw new Error("intake requires the multer upload instance");

  const PASSWORD = process.env.INTAKE_PASSWORD || process.env.PUBLIC_REVIEW_PASSWORD || null;
  const MEDIA_MAX_BYTES = 8 * 1024 * 1024; // 8 MB photo cap

  function checkPassword(req, res) {
    if (!PASSWORD) {
      res.status(503).json({ error: "Intake is not configured (no password set). Set INTAKE_PASSWORD or PUBLIC_REVIEW_PASSWORD." });
      return false;
    }
    const given = req.get("x-intake-password") || (req.body && req.body.password) || req.query.password;
    if (given !== PASSWORD) {
      res.status(401).json({ error: "Wrong or missing password." });
      return false;
    }
    return true;
  }

  // ── THE EXTRACTION PROMPT — the field-event sibling of ingestPrompt ──
  // Strict JSON. Never invent. One question max. The question is the single
  // highest-value missing PROOF, not curiosity.
  function fieldEventPrompt(rawText, hasPhoto) {
    return [
      "You structure a single field event from a property-operations message.",
      "Reply with ONLY a JSON object — no prose, no markdown fences.",
      "",
      "MESSAGE:",
      '"""',
      String(rawText || "").slice(0, 4000),
      '"""',
      hasPhoto ? "A photo/receipt IS attached." : "No photo is attached.",
      "",
      "Return exactly this shape:",
      "{",
      '  "event_kind": "maintenance" | "purchase" | "move_out" | "leasing" | "note",',
      '  "property_string": the literal string in the message that names the property (address, building name, or code), or null,',
      '  "unit": the unit label as written (e.g. "3B"), or null,',
      '  "amount": number (dollars) ONLY if an amount is explicitly stated, else null — NEVER invent or estimate,',
      '  "vendor": store/vendor name if stated (e.g. "Home Depot"), else null,',
      '  "title": a 3-8 word operational title (e.g. "3B toilet fill valve replaced"),',
      '  "summary": one plain sentence of what happened,',
      '  "billback_likely": true | false | null — only from explicit signals (tenant-caused, damage, chargeback),',
      '  "confirmation": one short friendly line confirming what was captured, mentioning the receipt/photo if attached,',
      '  "question": ONE question — the single highest-value missing proof — or null if nothing important is missing.',
      "}",
      "",
      "Rules for the question (pick AT MOST one, by event kind):",
      "- maintenance with a cost: was this tenant-caused? (drives billback)",
      "- purchase with no photo: is there a receipt?",
      "- maintenance with no completion signal: is the work complete?",
      "- move_out: were keys returned?",
      "- leasing: what is the next step / follow-up date?",
      "- If the message already answers it, or kind is note: null.",
      "Never ask two things. Never ask what is already stated.",
    ].join("\n");
  }

  async function extractEvent(rawText, hasPhoto) {
    const ai = await anthropic.messages.create({
      model: INGEST_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: fieldEventPrompt(rawText, hasPhoto) }],
    });
    const out = (ai.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const raw = out.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  // ── shared capture core: text (+ optional stored media) → claim row + reply ──
  async function captureCore({ channel, sender, rawText, mediaId, sourceUrl }) {
    const hasPhoto = Boolean(mediaId || sourceUrl);
    const ex = (await extractEvent(rawText, hasPhoto)) || {};

    // Advisory identity: the ONE resolver, read-only. Never guesses, never writes.
    let propertyId = null, resolution = "skipped";
    if (ex.property_string) {
      try {
        const r = await registryInstance.resolveOnly(pool, { value: ex.property_string });
        resolution = r.status || "skipped";
        if (r.status === "resolved") propertyId = r.property_id;
      } catch { resolution = "skipped"; }
    }

    const amount = (typeof ex.amount === "number" && isFinite(ex.amount)) ? ex.amount : null;

    const row = await pool.query(
      `insert into intake_events
         (channel, sender, raw_text, media_id, extracted, event_kind,
          property_guess, property_id, property_resolution, unit_label,
          amount, vendor, title, summary, question, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'captured')
       returning id, created_at`,
      [
        channel, sender || null, rawText || null, mediaId || null,
        ex, ex.event_kind || "note",
        ex.property_string || null, propertyId, resolution, ex.unit || null,
        amount, ex.vendor || null, ex.title || null, ex.summary || null,
        ex.question || null,
      ]
    );

    const confirmation = ex.confirmation
      || ("Got it — " + (ex.title || "event captured") + (hasPhoto ? ", photo captured." : "."));

    return {
      event_id: row.rows[0].id,
      confirmation,
      question: ex.question || null,
      event_kind: ex.event_kind || "note",
      property_resolution: resolution,
      note: "Captured as a claim. It becomes a real record only when a human routes it from the review queue.",
    };
  }

  const photoUpload = upload.single("photo");

  // ════════════════════════════════════════════════════════════════
  //  CAPTURE — the web/app door. multipart (photo optional) or JSON.
  // ════════════════════════════════════════════════════════════════
  router.post("/intake/capture", (req, res, next) => {
    photoUpload(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Photo too large — keep it under 8 MB." });
        return res.status(400).json({ error: "Upload failed: " + err.message });
      }
      next();
    });
  }, express.json(), async (req, res) => {
    if (!checkPassword(req, res)) return;
    const rawText = (req.body && req.body.text) || "";
    if (!rawText.trim() && !req.file) {
      return res.status(400).json({ error: "Send some text, a photo, or both." });
    }

    try {
      let mediaId = null;
      if (req.file && req.file.buffer) {
        if (req.file.size > MEDIA_MAX_BYTES) return res.status(413).json({ error: "Photo too large — keep it under 8 MB." });
        const m = await pool.query(
          "insert into intake_media (mime, byte_size, bytes) values ($1,$2,$3) returning id",
          [req.file.mimetype || "application/octet-stream", req.file.size, req.file.buffer]
        );
        mediaId = m.rows[0].id;
      }

      const result = await captureCore({
        channel: "web",
        sender: (req.body && req.body.sender) || null,
        rawText,
        mediaId,
      });
      res.json(result);
    } catch (e) {
      console.error("intake capture error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  TWILIO ADAPTER — SMS webhook. Replies TwiML so the tech gets the
  //  confirmation + one question back as a text. Media URLs are recorded
  //  (fetching them requires Twilio credentials — a later wiring step).
  // ════════════════════════════════════════════════════════════════
  router.post("/intake/twilio", express.urlencoded({ extended: false }), async (req, res) => {
    const from = req.body.From || "unknown";
    const allow = (process.env.INTAKE_ALLOWED_NUMBERS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(from)) {
      return res.type("text/xml").send("<Response></Response>"); // silent drop for unknown senders
    }
    try {
      const body = req.body.Body || "";
      const numMedia = parseInt(req.body.NumMedia || "0", 10) || 0;
      let mediaId = null;
      if (numMedia > 0 && req.body.MediaUrl0) {
        const m = await pool.query(
          "insert into intake_media (mime, source_url) values ($1,$2) returning id",
          [req.body.MediaContentType0 || null, req.body.MediaUrl0]
        );
        mediaId = m.rows[0].id;
      }
      const result = await captureCore({ channel: "sms", sender: from, rawText: body, mediaId, sourceUrl: req.body.MediaUrl0 || null });
      const reply = result.confirmation + (result.question ? (" " + result.question + " (reply Yes / No / Not sure)") : "");
      res.type("text/xml").send("<Response><Message>" + xmlEscape(reply) + "</Message></Response>");
    } catch (e) {
      console.error("intake twilio error", e);
      res.type("text/xml").send("<Response><Message>Couldn't capture that — try again or send it to the office.</Message></Response>");
    }
  });

  function xmlEscape(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ════════════════════════════════════════════════════════════════
  //  ANSWER — record the reply to the one question.
  // ════════════════════════════════════════════════════════════════
  router.post("/intake/events/:id/answer", express.json(), async (req, res) => {
    if (!checkPassword(req, res)) return;
    const answer = (req.body && req.body.answer) || null;
    if (!answer) return res.status(400).json({ error: "answer is required." });
    try {
      const r = await pool.query(
        `update intake_events set answer=$1,
                status = case when status='captured' then 'answered' else status end
          where id=$2 returning id, status`,
        [String(answer).slice(0, 500), req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: "event not found." });
      res.json({ id: r.rows[0].id, status: r.rows[0].status, note: "Answer recorded." });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  //  QUEUE — door 3 feed: everything not yet routed/recorded/dismissed.
  // ════════════════════════════════════════════════════════════════
  router.get("/intake/queue", async (req, res) => {
    if (!checkPassword(req, res)) return;
    try {
      const rows = (await pool.query(
        `select e.id, e.channel, e.sender, e.raw_text, e.media_id, e.event_kind,
                e.property_guess, e.property_id, e.property_resolution, e.unit_label,
                e.amount, e.vendor, e.title, e.summary, e.question, e.answer,
                e.status, e.created_at, p.name as property_name
           from intake_events e
           left join properties p on p.id = e.property_id
          where e.status in ('captured','answered')
          order by e.created_at desc
          limit 200`
      )).rows;
      res.json({ count: rows.length, events: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  //  ROUTED — record the tie AFTER the human created the real record
  //  through the real endpoint. This is the promotion of the claim.
  // ════════════════════════════════════════════════════════════════
  router.post("/intake/events/:id/routed", express.json(), async (req, res) => {
    if (!checkPassword(req, res)) return;
    const { routed_kind, routed_id, reviewed_by } = req.body || {};
    if (!routed_kind || !["work_order", "money_event", "none"].includes(routed_kind)) {
      return res.status(400).json({ error: "routed_kind must be work_order, money_event, or none." });
    }
    if (routed_kind !== "none" && !routed_id) {
      return res.status(400).json({ error: "routed_id is required (the id of the real record you created)." });
    }
    try {
      const r = await pool.query(
        `update intake_events
            set routed_kind=$1, routed_id=$2, reviewed_by=$3, reviewed_at=now(),
                status = case when $1='none' then 'recorded' else 'routed' end
          where id=$4 returning id, status`,
        [routed_kind, routed_id || null, reviewed_by || null, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: "event not found." });
      res.json({ id: r.rows[0].id, status: r.rows[0].status, note: "Tie recorded." });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post("/intake/events/:id/dismiss", express.json(), async (req, res) => {
    if (!checkPassword(req, res)) return;
    try {
      const r = await pool.query(
        `update intake_events set status='dismissed', reviewed_by=$1, reviewed_at=now()
          where id=$2 returning id`,
        [(req.body && req.body.reviewed_by) || null, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: "event not found." });
      res.json({ id: r.rows[0].id, status: "dismissed" });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  //  MEDIA — serve the proof photo (password in query for <img> tags).
  // ════════════════════════════════════════════════════════════════
  router.get("/intake/media/:id", async (req, res) => {
    if (!checkPassword(req, res)) return;
    try {
      const r = await pool.query("select mime, bytes, source_url from intake_media where id=$1", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "media not found." });
      const m = r.rows[0];
      if (m.bytes) return res.type(m.mime || "application/octet-stream").send(m.bytes);
      if (m.source_url) return res.json({ note: "Media lives at the carrier and isn't fetched yet.", source_url: m.source_url });
      res.status(404).json({ error: "media row has no content." });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  //  THE PAGES — capture (field) + review (office). Inline HTML, same
  //  pattern as the parsing bench: the page is open, every call is gated.
  // ════════════════════════════════════════════════════════════════
  router.get("/intake", (_req, res) => res.type("html").send(CAPTURE_HTML));
  router.get("/intake/review", (_req, res) => res.type("html").send(REVIEW_HTML));

  const CAPTURE_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Field Capture</title>
<style>
  :root{--bg:#101314;--panel:#1B2022;--ink:#EDEAE2;--muted:#8A938F;--me:#2E6B4F;--sys:#26302B;--line:#2A3234;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16px}
  .top{position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--line);padding:12px 16px}
  .top h1{font-size:16px;margin:0}
  .top p{margin:2px 0 0;font-size:12px;color:var(--muted)}
  .setup{padding:12px 16px;display:flex;gap:8px;background:var(--panel);border-bottom:1px solid var(--line)}
  .setup input{flex:1;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;font-size:14px}
  .thread{padding:16px 14px 130px;max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:10px}
  .msg{max-width:86%;padding:10px 14px;border-radius:16px;line-height:1.4;white-space:pre-wrap;word-break:break-word;font-size:15px}
  .msg.me{background:var(--me);align-self:flex-end;border-bottom-right-radius:5px}
  .msg.sys{background:var(--sys);align-self:flex-start;border-bottom-left-radius:5px}
  .msg img{max-width:100%;border-radius:10px;display:block;margin-top:6px}
  .qbtns{display:flex;gap:8px;align-self:flex-start;flex-wrap:wrap}
  .qbtns button{font:inherit;font-size:14px;padding:8px 16px;border-radius:18px;border:1px solid var(--me);background:transparent;color:var(--ink);cursor:pointer}
  .qbtns button:active{background:var(--me)}
  .bar{position:fixed;bottom:0;left:0;right:0;background:var(--panel);border-top:1px solid var(--line);padding:10px 12px calc(10px + env(safe-area-inset-bottom))}
  .barin{max-width:640px;margin:0 auto;display:flex;gap:8px;align-items:flex-end}
  textarea{flex:1;resize:none;padding:10px 12px;border-radius:18px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;font-size:15px;max-height:110px}
  .icon{width:44px;height:44px;border-radius:50%;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-size:19px;cursor:pointer;flex:none}
  .send{background:var(--me);border-color:var(--me)}
  .hint{text-align:center;color:var(--muted);font-size:12px;padding:4px 16px 0}
  .pill{display:inline-block;background:var(--sys);border:1px solid var(--line);color:var(--muted);border-radius:10px;font-size:12px;padding:2px 10px;margin-top:4px}
</style>
</head>
<body>
  <div class="top"><h1>Field Capture</h1><p>Say what happened. Attach the receipt. One tap to confirm. Done.</p></div>
  <div class="setup">
    <input type="password" id="pw" placeholder="Access password" autocomplete="off">
    <input type="text" id="who" placeholder="Your name" style="max-width:140px">
  </div>
  <div class="thread" id="thread">
    <div class="msg sys">Example: &ldquo;Unit 3B toilet fixed. Replaced fill valve. $18.72 Home Depot.&rdquo; &mdash; attach the receipt photo and send.</div>
  </div>
  <div class="bar">
    <div class="barin">
      <button class="icon" id="camBtn" title="Attach photo">&#128247;</button>
      <input type="file" id="photo" accept="image/*" capture="environment" style="display:none">
      <textarea id="txt" rows="1" placeholder="What happened?"></textarea>
      <button class="icon send" id="sendBtn" title="Send">&#10148;</button>
    </div>
    <div class="hint" id="hint"></div>
  </div>
<script>
(function(){
  "use strict";
  var thread = document.getElementById("thread");
  var photoInput = document.getElementById("photo");
  var pendingPhoto = null;
  var lastEventId = null;

  function el(id){ return document.getElementById(id); }
  function bubble(cls, text){
    var d = document.createElement("div");
    d.className = "msg " + cls;
    d.textContent = text;
    thread.appendChild(d);
    window.scrollTo(0, document.body.scrollHeight);
    return d;
  }

  el("camBtn").addEventListener("click", function(){ photoInput.click(); });
  photoInput.addEventListener("change", function(){
    pendingPhoto = photoInput.files[0] || null;
    el("hint").textContent = pendingPhoto ? ("Attached: " + pendingPhoto.name) : "";
  });

  el("txt").addEventListener("input", function(){
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 110) + "px";
  });

  function askButtons(question){
    var wrap = document.createElement("div");
    wrap.className = "qbtns";
    ["Yes","No","Not sure"].forEach(function(label){
      var b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", function(){
        wrap.remove();
        bubble("me", label);
        fetch("/intake/events/" + lastEventId + "/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-intake-password": el("pw").value },
          body: JSON.stringify({ answer: label })
        }).then(function(r){ return r.json(); }).then(function(){
          bubble("sys", "Noted. All set \u2014 it\u2019s in the queue.");
        }).catch(function(){ bubble("sys", "Couldn\u2019t save that answer \u2014 the office can set it in review."); });
      });
      wrap.appendChild(b);
    });
    thread.appendChild(wrap);
    window.scrollTo(0, document.body.scrollHeight);
  }

  el("sendBtn").addEventListener("click", function(){
    var text = el("txt").value.trim();
    if (!el("pw").value) { el("hint").textContent = "Enter the access password first."; return; }
    if (!text && !pendingPhoto) { el("hint").textContent = "Type what happened or attach a photo."; return; }

    var mine = bubble("me", text || "(photo)");
    if (pendingPhoto) {
      var img = document.createElement("img");
      img.src = URL.createObjectURL(pendingPhoto);
      mine.appendChild(img);
    }
    el("txt").value = ""; el("txt").style.height = "auto";
    el("hint").textContent = "";

    var fd = new FormData();
    fd.append("password", el("pw").value);
    fd.append("text", text);
    if (el("who").value) fd.append("sender", el("who").value);
    if (pendingPhoto) fd.append("photo", pendingPhoto);
    pendingPhoto = null; photoInput.value = "";

    var typing = bubble("sys", "\u2026");
    fetch("/intake/capture", { method: "POST", body: fd })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        typing.remove();
        if (!res.ok) { bubble("sys", res.j.error || "Couldn\u2019t capture that \u2014 try again."); return; }
        lastEventId = res.j.event_id;
        bubble("sys", res.j.confirmation);
        if (res.j.question) { bubble("sys", res.j.question); askButtons(res.j.question); }
        var pill = document.createElement("div");
        pill.className = "pill";
        pill.textContent = "captured as a claim \u00b7 " + (res.j.event_kind || "event");
        thread.appendChild(pill);
        window.scrollTo(0, document.body.scrollHeight);
      })
      .catch(function(){ typing.remove(); bubble("sys", "Network hiccup \u2014 try again."); });
  });
})();
</script>
</body>
</html>`;

  const REVIEW_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Intake Review Queue</title>
<style>
  :root{--paper:#FAF8F3;--ink:#1C1B18;--muted:#6B675E;--line:#DDD8CC;--green:#2E6B4F;--green-soft:#E4EEE8;
    --amber:#9A6B14;--amber-soft:#F4EAD4;--red:#A3372E;--blue:#2D5575;--blue-soft:#E2EAF1;
    --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.45}
  .wrap{max-width:980px;margin:0 auto;padding:26px 18px 80px}
  header{border-bottom:3px double var(--ink);padding-bottom:12px;margin-bottom:18px}
  header h1{font-size:20px;margin:0}
  header p{margin:4px 0 0;color:var(--muted);font-size:13px}
  .gate{display:flex;gap:10px;margin-bottom:18px}
  .gate input{padding:9px 11px;border:1px solid var(--line);border-radius:4px;font:inherit;background:#fff;flex:1;max-width:280px}
  button{font:inherit;cursor:pointer;border-radius:4px;border:1px solid var(--ink);background:var(--ink);color:#fff;padding:8px 16px;font-weight:600}
  button.ghost{background:#fff;color:var(--ink)}
  button.green{background:var(--green);border-color:var(--green)}
  button.blue{background:var(--blue);border-color:var(--blue)}
  button.danger{background:#fff;color:var(--red);border-color:var(--red)}
  button:disabled{opacity:.45;cursor:default}
  .card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:16px 18px;margin-bottom:14px}
  .kind{display:inline-block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
    padding:2px 8px;border-radius:9px;background:var(--blue-soft);color:var(--blue);margin-right:8px}
  .kind.purchase{background:var(--amber-soft);color:var(--amber)}
  .kind.maintenance{background:var(--green-soft);color:var(--green)}
  .meta{font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:2px}
  .raw{border-left:3px solid var(--line);padding:6px 12px;margin:10px 0;color:var(--muted);font-size:13.5px;white-space:pre-wrap}
  .fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0}
  .fields label{display:block;font-size:11px;color:var(--muted);margin-bottom:3px}
  .fields input,.fields select{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:4px;font:inherit;font-size:13.5px;background:var(--paper)}
  .qa{background:var(--blue-soft);border-radius:4px;padding:8px 12px;font-size:13.5px;margin:8px 0}
  .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .photo{max-width:240px;border-radius:6px;border:1px solid var(--line);display:block;margin-top:8px}
  .stat{font-family:var(--mono);font-size:12.5px;margin-top:8px;min-height:16px}
  .stat.ok{color:var(--green)} .stat.err{color:var(--red)}
  .empty{color:var(--muted);text-align:center;padding:40px 0}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Intake Review Queue</h1>
    <p>AI suggested these facts. Nothing below is real until you route it &mdash; the buttons call the live endpoints through their own gates.</p>
  </header>
  <div class="gate">
    <input type="password" id="pw" placeholder="Access password" autocomplete="off">
    <input type="password" id="opkey" placeholder="Operator key" autocomplete="off">
    <button id="loadBtn">Load queue</button>
  </div>
  <div id="list"></div>
</div>
<script>
(function(){
  "use strict";
  var properties = [];
  function el(id){ return document.getElementById(id); }
  function pw(){ return el("pw").value; }
  function opkey(){ return el("opkey").value; }

  function loadProperties(){
    return fetch("/owner/properties", { headers: { "x-operator-key": opkey() } }).then(function(r){ return r.json(); })
      .then(function(j){ properties = (j.properties || j || []); })
      .catch(function(){ properties = []; });
  }

  function propOptions(selectedId){
    var html = '<option value="">\u2014 pick property \u2014</option>';
    properties.forEach(function(p){
      var id = p.id, name = p.name || p.address || id;
      html += '<option value="' + id + '"' + (id === selectedId ? ' selected' : '') + '>' + escapeHtml(name) + '</option>';
    });
    return html;
  }
  function escapeHtml(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  el("loadBtn").addEventListener("click", function(){
    el("list").innerHTML = '<div class="empty">Loading\u2026</div>';
    loadProperties().then(function(){
      return fetch("/intake/queue?password=" + encodeURIComponent(pw()));
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (!res.ok) { el("list").innerHTML = '<div class="empty">' + escapeHtml(res.j.error || "Couldn\u2019t load.") + '</div>'; return; }
        render(res.j.events || []);
      });
  });

  function render(events){
    var list = el("list");
    list.innerHTML = "";
    if (!events.length) { list.innerHTML = '<div class="empty">Queue is clear. Truth is up to date.</div>'; return; }
    events.forEach(function(ev){ list.appendChild(card(ev)); });
  }

  function card(ev){
    var d = document.createElement("div");
    d.className = "card";
    var kindClass = ev.event_kind === "purchase" ? "purchase" : (ev.event_kind === "maintenance" ? "maintenance" : "");
    var html = "";
    html += '<span class="kind ' + kindClass + '">' + escapeHtml(ev.event_kind || "note") + '</span>';
    html += '<strong>' + escapeHtml(ev.title || "(untitled event)") + '</strong>';
    html += '<div class="meta">' + escapeHtml(ev.channel) + ' \u00b7 ' + escapeHtml(ev.sender || "unknown sender") + ' \u00b7 ' + new Date(ev.created_at).toLocaleString() + '</div>';
    if (ev.raw_text) html += '<div class="raw">' + escapeHtml(ev.raw_text) + '</div>';
    if (ev.summary) html += '<div>' + escapeHtml(ev.summary) + '</div>';
    if (ev.question) {
      html += '<div class="qa"><b>Asked:</b> ' + escapeHtml(ev.question) + ' &mdash; <b>Answer:</b> ' + escapeHtml(ev.answer || "(none yet)") + '</div>';
    }
    if (ev.media_id) {
      html += '<img class="photo" src="/intake/media/' + ev.media_id + '?password=' + encodeURIComponent(pw()) + '" alt="proof photo">';
    }
    html += '<div class="fields">'
      + '<div><label>Property</label><select data-f="property_id">' + propOptions(ev.property_id) + '</select></div>'
      + '<div><label>Unit</label><input data-f="unit" value="' + escapeHtml(ev.unit_label) + '"></div>'
      + '<div><label>Amount ($)</label><input data-f="amount" value="' + escapeHtml(ev.amount) + '"></div>'
      + '<div><label>Vendor</label><input data-f="vendor" value="' + escapeHtml(ev.vendor) + '"></div>'
      + '<div><label>Title</label><input data-f="title" value="' + escapeHtml(ev.title) + '"></div>'
      + '</div>';
    html += '<div class="actions">'
      + '<button class="green" data-act="wo">Create work order</button>'
      + '<button class="blue" data-act="money">Create money event</button>'
      + '<button class="ghost" data-act="record">Just record</button>'
      + '<button class="danger" data-act="dismiss">Dismiss</button>'
      + '</div><div class="stat"></div>';
    d.innerHTML = html;

    var stat = d.querySelector(".stat");
    function val(f){ var n = d.querySelector('[data-f="' + f + '"]'); return n ? n.value.trim() : ""; }
    function setStat(msg, ok){ stat.textContent = msg; stat.className = "stat " + (ok ? "ok" : "err"); }
    function tie(kind, id){
      return fetch("/intake/events/" + ev.id + "/routed", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-intake-password": pw() },
        body: JSON.stringify({ routed_kind: kind, routed_id: id || null })
      }).then(function(r){ return r.json(); });
    }
    function done(msg){ setStat(msg, true); d.style.opacity = "0.55"; d.querySelectorAll("button").forEach(function(b){ b.disabled = true; }); }

    d.querySelectorAll("button[data-act]").forEach(function(btn){
      btn.addEventListener("click", function(){
        var act = btn.dataset.act;
        if (act === "dismiss") {
          fetch("/intake/events/" + ev.id + "/dismiss", { method: "POST", headers: { "Content-Type": "application/json", "x-intake-password": pw() }, body: "{}" })
            .then(function(){ done("Dismissed."); });
          return;
        }
        if (act === "record") {
          tie("none", null).then(function(){ done("Recorded \u2014 no further routing."); });
          return;
        }
        var propertyId = val("property_id");
        if (!propertyId) { setStat("Pick a property first \u2014 identity before data.", false); return; }
        if (act === "wo") {
          fetch("/work-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-operator-key": opkey() },
            body: JSON.stringify({
              property_id: propertyId,
              title: val("title") || "Field-captured work order",
              description: (ev.raw_text || "") + (ev.answer ? (" | Field answer: " + ev.answer) : ""),
              est_cost: val("amount") ? Number(val("amount")) : undefined,
              source: "intake"
            })
          }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
            .then(function(res){
              if (!res.ok) { setStat(res.j.error || "Work order failed.", false); return; }
              var newId = res.j.id || (res.j.work_order && res.j.work_order.id);
              tie("work_order", newId).then(function(){ done("Work order created + tied."); });
            });
        }
        if (act === "money") {
          var amt = Number(val("amount"));
          if (!(amt > 0)) { setStat("Money event needs a positive amount.", false); return; }
          fetch("/money-events", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-operator-key": opkey() },
            body: JSON.stringify({
              property_id: propertyId,
              amount: amt,
              vendor: val("vendor") || null,
              occurred_on: ev.created_at ? ev.created_at.slice(0, 10) : null
            })
          }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
            .then(function(res){
              if (!res.ok) { setStat(res.j.error || "Money event failed.", false); return; }
              var newId = res.j.id || (res.j.money_event && res.j.money_event.id) || (res.j.event && res.j.event.id);
              tie("money_event", newId).then(function(){ done("Money event created (quarantined, as it should be) + tied."); });
            });
        }
      });
    });
    return d;
  }
})();
</script>
</body>
</html>`;

  return router;
};
