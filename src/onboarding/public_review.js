// ════════════════════════════════════════════════════════════════════
//  PUBLIC RENT-ROLL REVIEW — a sharable testing link.
//
//  PURPOSE: send a link, let real people upload real rent rolls, capture their
//  corrections, make the PARSER smarter — WITHOUT ever touching live NOI or
//  supported revenue.
//
//  THE WALL (structural, not policy):
//    - This module takes NO property id and NEVER calls runIngest.
//    - It writes ONLY to public_upload_sessions / public_rent_roll_feedback /
//      mapping_memory (migration 013) — none of which reference properties or
//      ingest_candidates.
//    - It therefore CANNOT create candidates, promote, or create supported
//      revenue. Supported revenue still requires the normal promotion gate.
//    - mapping_memory is the only thing that could later inform live parsing,
//      and it is captured here but NOT wired to the live parser in this build
//      (the "hold off" decision). Wiring it in is a deliberate later step.
//
//  GATE: a shared password (PUBLIC_REVIEW_PASSWORD env var). Checked on every
//  write route. No login, no accounts — just a key Kameron hands out.
//
//  Mount in server.js (near the other mounts). It needs the SAME extraction
//  pieces the live ingest uses, passed in as deps so it reuses them verbatim:
//    const publicReview = require("./public_review");
//    app.use("/", publicReview({ pool, anthropic, INGEST_MODEL, fileToText, ingestPrompt, upload }));
// ════════════════════════════════════════════════════════════════════

module.exports = function publicReview(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool, anthropic, INGEST_MODEL, fileToText, ingestPrompt, upload } = deps;

  if (!pool) throw new Error("public_review requires a pool");
  if (!anthropic) throw new Error("public_review requires the anthropic client");
  if (!fileToText) throw new Error("public_review requires fileToText");
  if (!ingestPrompt) throw new Error("public_review requires ingestPrompt");
  if (!upload) throw new Error("public_review requires the multer upload instance");

  const PASSWORD = process.env.PUBLIC_REVIEW_PASSWORD || null;

  // Moderate size cap for the public route: 10 MB (tighter than the 25 MB live
  // cap — public files are rent rolls, not giant OMs, and this limits API cost).
  const PUBLIC_MAX_BYTES = 10 * 1024 * 1024;

  // ── password check (shared secret, sent as header or field) ──
  function checkPassword(req, res) {
    if (!PASSWORD) {
      res.status(503).json({ error: "Public review is not configured (no password set). Set PUBLIC_REVIEW_PASSWORD." });
      return false;
    }
    const given = req.get("x-review-password") || (req.body && req.body.password) || req.query.password;
    if (given !== PASSWORD) {
      res.status(401).json({ error: "Wrong or missing password." });
      return false;
    }
    return true;
  }

  // ── format signature: a stable fingerprint of the file's shape ──
  // Built from detected_system + the sorted top header tokens, so two files in
  // the same layout produce the same signature (the key mapping_memory uses).
  function formatSignature(detectedSystem, sourceText) {
    const firstLines = (sourceText || "").split("\n").slice(0, 25).join(" ");
    const tokens = (firstLines.match(/[A-Za-z][A-Za-z /]{2,}/g) || [])
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length >= 3);
    const top = Array.from(new Set(tokens)).sort().slice(0, 12).join("|");
    return `${detectedSystem || "unknown"}::${top}`;
  }

  // ── parse a file to the extraction result, WITHOUT writing candidates ──
  async function parseOnly(sourceText) {
    const ai = await anthropic.messages.create({
      model: INGEST_MODEL,
      max_tokens: parseInt(process.env.MAX_INGEST_TOKENS, 10) || 64000,
      messages: [{ role: "user", content: ingestPrompt(sourceText) }],
    });
    if (ai.stop_reason === "max_tokens") {
      const err = new Error("This file is too large for single-pass extraction. Try a smaller rent roll or paste the table text.");
      err.truncated = true;
      throw err;
    }
    const rawOutput = (ai.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const raw = rawOutput.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const err = new Error("The parser returned output we couldn't read. Try re-uploading, or paste the table text.");
      err.unparseable = true;
      throw err;
    }
    return parsed;
  }

  // Flatten the extraction to a simple row list for the grading UI (single OR deal).
  function flattenRows(parsed) {
    const out = [];
    const pushUnit = (u, addr) => out.push({
      property_address: addr || null,
      unit_number: u.unit_number ?? null,
      bedrooms: u.bedrooms ?? null,
      market_rent: u.market_rent ?? null,
      actual_rent: u.actual_rent ?? null,
      status: u.status ?? null,
      tenant_name: u.tenant_name ?? null,
      lease_start: u.lease_start ?? null,
      lease_end: u.lease_end ?? null,
      prov: u.prov ?? null,
      note: u.note ?? null,
    });
    if (Array.isArray(parsed.subject_properties)) {
      for (const sp of parsed.subject_properties) {
        const addr = sp.address || sp.name || null;
        for (const u of (sp.units || [])) pushUnit(u, addr);
      }
    } else {
      for (const u of (parsed.units || [])) pushUnit(u, null);
    }
    return out;
  }

  // multer wrapper with the tighter public cap
  const publicUpload = upload.single("file");

  // ════════════════════════════════════════════════════════════════
  //  ROUTE 0: THE PAGE — GET /public/rent-roll serves the grading bench UI.
  //  Inline HTML so there is no static-file step; one URL to share.
  //  The page itself is not gated (it contains no data); every API call it
  //  makes carries the password, which IS checked server-side.
  // ════════════════════════════════════════════════════════════════
  router.get("/public/rent-roll", (req, res) => {
    res.type("html").send(PAGE_HTML);
  });

  const PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rent-Roll Parsing Bench</title>
<style>
  :root{
    --paper:#FAF8F3; --ink:#1C1B18; --muted:#6B675E; --line:#DDD8CC;
    --green:#2E6B4F; --green-soft:#E4EEE8; --amber:#9A6B14; --amber-soft:#F4EAD4;
    --red:#A3372E; --red-soft:#F3E1DF; --blue:#2D5575; --blue-soft:#E2EAF1;
    --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.45}
  .wrap{max-width:1180px;margin:0 auto;padding:28px 20px 80px}
  header{border-bottom:3px double var(--ink);padding-bottom:14px;margin-bottom:22px}
  header h1{font-size:21px;margin:0;letter-spacing:.01em}
  header p{margin:5px 0 0;color:var(--muted);font-size:13.5px}
  .card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:18px 20px;margin-bottom:18px}
  .card h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
  label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}
  input[type=text],input[type=password],input[type=email],textarea{
    width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:4px;
    font:inherit;background:var(--paper)}
  input:focus,textarea:focus{outline:2px solid var(--green);outline-offset:-1px}
  .filebox{border:1.5px dashed var(--line);border-radius:6px;padding:14px;background:var(--paper);
    display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  button{font:inherit;cursor:pointer;border-radius:4px;border:1px solid var(--ink);
    background:var(--ink);color:#fff;padding:9px 18px;font-weight:600}
  button:hover{background:#000}
  button:disabled{opacity:.45;cursor:default}
  button.ghost{background:#fff;color:var(--ink)}
  button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
  .status{font-family:var(--mono);font-size:13px;margin-top:10px;min-height:18px}
  .status.err{color:var(--red)} .status.ok{color:var(--green)}
  .summary{display:flex;gap:26px;flex-wrap:wrap;font-family:var(--mono);font-size:13px}
  .summary b{display:block;font-size:11px;font-family:var(--sans);font-weight:600;
    text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:2px}
  .panel{border-left:3px solid var(--amber);background:var(--amber-soft);
    padding:10px 14px;border-radius:0 4px 4px 0;margin-top:12px;font-size:13.5px}
  .panel.unclear{border-color:var(--blue);background:var(--blue-soft)}
  .panel b{font-size:11px;text-transform:uppercase;letter-spacing:.07em}
  .panel ul{margin:6px 0 0;padding-left:18px}
  .tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:6px;background:#fff}
  table{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:12.5px}
  th{position:sticky;top:0;background:var(--ink);color:#fff;text-align:left;
    padding:7px 9px;font-weight:600;white-space:nowrap;font-family:var(--sans);font-size:11px;
    text-transform:uppercase;letter-spacing:.05em}
  td{border-top:1px solid var(--line);padding:5px 9px;white-space:nowrap;font-variant-numeric:tabular-nums}
  td[contenteditable]{cursor:text;min-width:54px}
  td[contenteditable]:focus{outline:2px solid var(--blue);outline-offset:-2px;background:var(--blue-soft)}
  td.edited{background:var(--amber-soft)}
  tr:nth-child(even) td{background-color:rgba(0,0,0,.018)}
  tr:nth-child(even) td.edited{background:var(--amber-soft)}
  .chip{display:inline-block;font-family:var(--sans);font-size:10.5px;font-weight:700;
    padding:1.5px 7px;border-radius:9px;margin-right:4px;text-transform:uppercase;letter-spacing:.04em}
  .chip.model,.chip.nonrev{background:var(--red-soft);color:var(--red)}
  .chip.aff{background:var(--blue-soft);color:var(--blue)}
  .chip.conc{background:var(--amber-soft);color:var(--amber)}
  .chip.assumed{background:var(--amber-soft);color:var(--amber)}
  .chip.confirmed{background:var(--green-soft);color:var(--green)}
  td.notecell{white-space:normal;min-width:230px;max-width:420px;font-size:11.5px;color:var(--muted)}
  .gradebtns{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
  .gradebtns button{background:#fff;color:var(--ink)}
  .gradebtns button.sel-accurate{background:var(--green);border-color:var(--green);color:#fff}
  .gradebtns button.sel-partial{background:var(--amber);border-color:var(--amber);color:#fff}
  .gradebtns button.sel-wrong{background:var(--red);border-color:var(--red);color:#fff}
  .editcount{font-family:var(--mono);font-size:12.5px;color:var(--amber);margin:8px 0}
  .hidden{display:none}
  footer{margin-top:26px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);padding-top:12px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Rent-Roll Parsing Bench</h1>
    <p>Upload a rent roll &rarr; see exactly what the parser extracted &rarr; correct anything wrong &rarr; grade it. Parse-only: nothing here touches a live property, NOI, or supported revenue.</p>
  </header>

  <div class="card">
    <h2>1 &middot; Upload &amp; parse</h2>
    <div class="grid">
      <div><label for="pw">Access password</label><input type="password" id="pw" autocomplete="off"></div>
      <div><label for="nm">Your name (optional)</label><input type="text" id="nm"></div>
      <div><label for="em">Email (optional)</label><input type="email" id="em"></div>
    </div>
    <div class="filebox" style="margin-top:14px">
      <input type="file" id="file" accept=".xlsx,.xls,.csv,.pdf,.docx,.doc,.txt">
      <button id="parseBtn">Parse rent roll</button>
      <span style="color:var(--muted);font-size:12.5px">.xlsx&ensp;.xls&ensp;.csv&ensp;.pdf&ensp;.docx&ensp;.txt &mdash; max 10&nbsp;MB</span>
    </div>
    <div class="status" id="parseStatus"></div>
  </div>

  <div id="results" class="hidden">
    <div class="card">
      <h2>2 &middot; What the parser read</h2>
      <div class="summary">
        <div><b>Detected system</b><span id="sysOut">&mdash;</span></div>
        <div><b>Level reached</b><span id="lvlOut">&mdash;</span></div>
        <div><b>Rows extracted</b><span id="cntOut">&mdash;</span></div>
        <div><b>Session</b><span id="sessOut">&mdash;</span></div>
      </div>
      <div class="panel" id="missingPanel"><b>Missing / not in this file</b><ul id="missingList"></ul></div>
      <div class="panel unclear" id="unclearPanel"><b>Parser flagged as unclear</b><ul id="unclearList"></ul></div>
    </div>

    <div class="card">
      <h2>3 &middot; Extracted rows &mdash; click any value to correct it</h2>
      <div class="tablewrap"><table id="rowsTable">
        <thead><tr>
          <th>#</th><th>Property</th><th>Unit</th><th>BR</th><th>Market rent</th>
          <th>Actual rent</th><th>Status</th><th>Tenant</th><th>Lease start</th>
          <th>Lease end</th><th>Prov</th><th>Flags &amp; parser note</th>
        </tr></thead>
        <tbody id="rowsBody"></tbody>
      </table></div>
      <div class="editcount" id="editCount"></div>
    </div>

    <div class="card">
      <h2>4 &middot; Grade this parse</h2>
      <div class="gradebtns">
        <button data-rating="accurate" id="gAcc">Accurate</button>
        <button data-rating="partial" id="gPar">Partially right</button>
        <button data-rating="wrong" id="gWrg">Mostly wrong</button>
      </div>
      <label for="notes">Notes &mdash; what did it miss or get wrong?</label>
      <textarea id="notes" rows="3"></textarea>
      <div style="margin-top:12px"><button id="sendBtn">Submit grade &amp; corrections</button></div>
      <div class="status" id="sendStatus"></div>
    </div>
  </div>

  <footer>Corrections are stored as training data only. Supported revenue still requires the normal promotion gate.</footer>
</div>

<script>
(function(){
  "use strict";
  var EDITABLE = ["unit_number","bedrooms","market_rent","actual_rent","status","tenant_name","lease_start","lease_end"];
  var state = { session: null, rows: [], edits: {}, rating: null };

  function el(id){ return document.getElementById(id); }
  function show(node){ node.classList.remove("hidden"); }
  function hide(node){ node.classList.add("hidden"); }
  function fmt(v){ return (v === null || v === undefined || v === "") ? "" : String(v); }

  function chipsFor(row){
    var html = "";
    var note = (row.note || "").toLowerCase();
    var name = (row.tenant_name || "").toLowerCase();
    var status = (row.status || "").toLowerCase();
    if (note.indexOf("model") > -1 || name.indexOf("model") > -1 || status.indexOf("model") > -1 ||
        note.indexOf("employee") > -1 || name.indexOf("employee") > -1) {
      html += '<span class="chip model">non-revenue</span>';
    }
    if (note.indexOf("afford") > -1 || note.indexOf("ami") > -1 || note.indexOf("income-restrict") > -1) {
      html += '<span class="chip aff">affordable</span>';
    }
    if (note.indexOf("concession") > -1) {
      html += '<span class="chip conc">concession</span>';
    }
    if (row.prov === "assumed") html += '<span class="chip assumed">assumed</span>';
    else if (row.prov === "confirmed") html += '<span class="chip confirmed">confirmed</span>';
    return html;
  }

  function renderRows(rows){
    var body = el("rowsBody");
    body.innerHTML = "";
    rows.forEach(function(row, i){
      var tr = document.createElement("tr");
      var cells = [
        ["idx", String(i + 1), false],
        ["property_address", fmt(row.property_address), false],
        ["unit_number", fmt(row.unit_number), true],
        ["bedrooms", fmt(row.bedrooms), true],
        ["market_rent", fmt(row.market_rent), true],
        ["actual_rent", fmt(row.actual_rent), true],
        ["status", fmt(row.status), true],
        ["tenant_name", fmt(row.tenant_name), true],
        ["lease_start", fmt(row.lease_start), true],
        ["lease_end", fmt(row.lease_end), true],
        ["prov", fmt(row.prov), false]
      ];
      cells.forEach(function(c){
        var td = document.createElement("td");
        td.textContent = c[1];
        if (c[2]) {
          td.setAttribute("contenteditable", "plaintext-only");
          td.dataset.row = String(i);
          td.dataset.field = c[0];
          td.dataset.was = c[1];
          td.addEventListener("blur", onCellEdit);
        }
        tr.appendChild(td);
      });
      var noteTd = document.createElement("td");
      noteTd.className = "notecell";
      noteTd.innerHTML = chipsFor(row) + (row.note ? " " + escapeHtml(row.note) : "");
      tr.appendChild(noteTd);
      body.appendChild(tr);
    });
  }

  function escapeHtml(s){
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function onCellEdit(ev){
    var td = ev.target;
    var key = td.dataset.row + ":" + td.dataset.field;
    var now = td.textContent.trim();
    if (now !== td.dataset.was) {
      td.classList.add("edited");
      var orig = state.rows[Number(td.dataset.row)] || {};
      state.edits[key] = {
        row_index: Number(td.dataset.row),
        property_address: orig.property_address || null,
        unit_number: orig.unit_number || null,
        field: td.dataset.field,
        was: td.dataset.was === "" ? null : td.dataset.was,
        corrected: now === "" ? null : now
      };
    } else {
      td.classList.remove("edited");
      delete state.edits[key];
    }
    var n = Object.keys(state.edits).length;
    el("editCount").textContent = n ? (n + " correction" + (n === 1 ? "" : "s") + " pending \u2014 submit below") : "";
  }

  function renderList(panelId, listId, items){
    var panel = el(panelId), list = el(listId);
    if (!items || !items.length) { hide(panel); return; }
    list.innerHTML = "";
    items.forEach(function(it){
      var li = document.createElement("li");
      li.textContent = (typeof it === "string") ? it : JSON.stringify(it);
      list.appendChild(li);
    });
    show(panel);
  }

  el("parseBtn").addEventListener("click", function(){
    var f = el("file").files[0];
    var status = el("parseStatus");
    status.className = "status";
    if (!el("pw").value) { status.className = "status err"; status.textContent = "Enter the access password."; return; }
    if (!f) { status.className = "status err"; status.textContent = "Choose a file first."; return; }
    var fd = new FormData();
    fd.append("file", f);
    fd.append("password", el("pw").value);
    if (el("nm").value) fd.append("uploader_name", el("nm").value);
    if (el("em").value) fd.append("uploader_email", el("em").value);
    el("parseBtn").disabled = true;
    status.textContent = "Parsing \u2014 a full roll can take a minute or two\u2026";
    fetch("/public/rent-roll/parse", { method: "POST", body: fd })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        el("parseBtn").disabled = false;
        if (!res.ok) { status.className = "status err"; status.textContent = res.j.error || "Parse failed."; return; }
        status.className = "status ok";
        status.textContent = "Parsed " + res.j.row_count + " rows.";
        state.session = res.j.session_id;
        state.rows = res.j.rows || [];
        state.edits = {};
        state.rating = null;
        el("sysOut").textContent = res.j.detected_system || "unknown";
        el("lvlOut").textContent = fmt(res.j.level_reached) || "\u2014";
        el("cntOut").textContent = String(res.j.row_count);
        el("sessOut").textContent = String(res.j.session_id).slice(0, 8);
        renderList("missingPanel", "missingList", res.j.missing);
        renderList("unclearPanel", "unclearList", res.j.unclear);
        renderRows(state.rows);
        el("editCount").textContent = "";
        el("notes").value = "";
        el("sendStatus").textContent = "";
        ["gAcc","gPar","gWrg"].forEach(function(id){ el(id).className = ""; });
        show(el("results"));
        el("results").scrollIntoView({ behavior: "smooth" });
      })
      .catch(function(){
        el("parseBtn").disabled = false;
        status.className = "status err";
        status.textContent = "Network error \u2014 is the server awake? Try again.";
      });
  });

  ["gAcc","gPar","gWrg"].forEach(function(id){
    el(id).addEventListener("click", function(){
      state.rating = el(id).dataset.rating;
      el("gAcc").className = state.rating === "accurate" ? "sel-accurate" : "";
      el("gPar").className = state.rating === "partial" ? "sel-partial" : "";
      el("gWrg").className = state.rating === "wrong" ? "sel-wrong" : "";
    });
  });

  el("sendBtn").addEventListener("click", function(){
    var status = el("sendStatus");
    status.className = "status";
    if (!state.session) { status.className = "status err"; status.textContent = "Parse a file first."; return; }
    if (!state.rating) { status.className = "status err"; status.textContent = "Pick a grade: accurate, partial, or wrong."; return; }
    var corrections = Object.keys(state.edits).map(function(k){ return state.edits[k]; });
    el("sendBtn").disabled = true;
    status.textContent = "Saving\u2026";
    fetch("/public/rent-roll/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-review-password": el("pw").value },
      body: JSON.stringify({
        session_id: state.session,
        rating: state.rating,
        corrected_rows: corrections.length ? corrections : null,
        notes: el("notes").value || null
      })
    })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        el("sendBtn").disabled = false;
        if (!res.ok) { status.className = "status err"; status.textContent = res.j.error || "Save failed."; return; }
        status.className = "status ok";
        status.textContent = "Saved \u2014 thanks. " + (corrections.length ? corrections.length + " corrections recorded as training data." : "Grade recorded.");
      })
      .catch(function(){
        el("sendBtn").disabled = false;
        status.className = "status err";
        status.textContent = "Network error \u2014 try again.";
      });
  });
})();
</script>
</body>
</html>`;

  // ════════════════════════════════════════════════════════════════
  //  ROUTE 1: PARSE — upload a file, get the extraction back. No DB write to
  //  candidates. Saves a public_upload_sessions row and returns its id.
  // ════════════════════════════════════════════════════════════════
  router.post("/public/rent-roll/parse", (req, res, next) => {
    publicUpload(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "File too large — keep it under 10 MB. For a big image PDF, export the table to Excel/CSV or paste the text." });
        }
        return res.status(400).json({ error: "Upload failed: " + err.message });
      }
      next();
    });
  }, async (req, res) => {
    if (!checkPassword(req, res)) return;
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'file')." });

    // Enforce the tighter public cap explicitly (the shared multer cap is 25 MB).
    if (req.file.size > PUBLIC_MAX_BYTES) {
      return res.status(413).json({ error: "File too large — keep it under 10 MB." });
    }

    try {
      let text;
      try { text = await fileToText(req.file); }
      catch { return res.status(400).json({ error: "Couldn't read that file. Supported: .xlsx .xls .csv .pdf .docx .doc .txt" }); }

      if (!text || !text.trim()) {
        return res.status(400).json({ error: "The file had no readable text. If it's a scanned/photo PDF, paste the table or upload an Excel/CSV instead." });
      }

      const parsed = await parseOnly(text);
      const rows = flattenRows(parsed);
      const detectedSystem = parsed.detected_system || "unknown";
      const signature = formatSignature(detectedSystem, text);

      const session = await pool.query(
        `insert into public_upload_sessions
           (uploader_name, uploader_email, source_filename, detected_system,
            format_signature, level_reached, raw_extraction, extracted_row_count)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         returning id, created_at`,
        [
          req.body.uploader_name || null,
          req.body.uploader_email || null,
          req.file.originalname || null,
          detectedSystem,
          signature,
          parsed.level_reached || null,
          parsed,
          rows.length,
        ]
      );

      res.json({
        session_id: session.rows[0].id,
        detected_system: detectedSystem,
        level_reached: parsed.level_reached || null,
        format_signature: signature,
        row_count: rows.length,
        rows,
        unclear: Array.isArray(parsed.unclear) ? parsed.unclear : [],
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
        note: "This is a parse-only preview. Nothing here affects any live property, NOI, or supported revenue.",
      });
    } catch (e) {
      if (e.truncated) return res.status(413).json({ error: e.message });
      if (e.unparseable) return res.status(502).json({ error: e.message });
      console.error("public parse error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  ROUTE 2: FEEDBACK — grade + corrections for a session. Saves feedback and
  //  records HUMAN-corrected mappings into mapping_memory (corrected_by_human).
  //  mapping_memory is captured but NOT wired to the live parser in this build.
  // ════════════════════════════════════════════════════════════════
  router.post("/public/rent-roll/feedback", express.json({ limit: "2mb" }), async (req, res) => {
    if (!checkPassword(req, res)) return;
    const { session_id, rating, corrected_mappings, corrected_rows, notes } = req.body || {};
    if (!session_id) return res.status(400).json({ error: "session_id is required." });
    if (rating && !["accurate", "partial", "wrong"].includes(rating)) {
      return res.status(400).json({ error: "rating must be accurate, partial, or wrong." });
    }

    try {
      const sess = await pool.query(
        "select id, format_signature from public_upload_sessions where id=$1",
        [session_id]
      );
      if (!sess.rows.length) return res.status(404).json({ error: "session not found." });
      const signature = sess.rows[0].format_signature;

      const fb = await pool.query(
        `insert into public_rent_roll_feedback
           (session_id, rating, corrected_mappings, corrected_rows, notes)
         values ($1,$2,$3,$4,$5) returning id, created_at`,
        [session_id, rating || null, corrected_mappings || null, corrected_rows || null, notes || null]
      );

      // Record human-corrected column mappings into mapping_memory (high trust).
      // Upsert: reinforce times_seen if the same mapping is seen again.
      let learned = 0;
      if (corrected_mappings && typeof corrected_mappings === "object") {
        for (const [sourceCol, canonicalField] of Object.entries(corrected_mappings)) {
          if (!sourceCol || !canonicalField) continue;
          await pool.query(
            `insert into mapping_memory
               (format_signature, source_column, canonical_field, corrected_by_human, confidence, times_seen, last_seen_at)
             values ($1,$2,$3,true,1.0,1,now())
             on conflict (format_signature, source_column, canonical_field) do update set
               corrected_by_human = true,
               times_seen = mapping_memory.times_seen + 1,
               last_seen_at = now()`,
            [signature, String(sourceCol), String(canonicalField)]
          );
          learned += 1;
        }
      }

      res.json({
        feedback_id: fb.rows[0].id,
        learned_mappings: learned,
        note: "Thanks — saved. Corrections are stored as training data only. They do not affect any live property or revenue.",
      });
    } catch (e) {
      console.error("public feedback error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  ROUTE 3: ADMIN — uploads, scores, corrections, accuracy over time.
  //  Password-gated (same shared secret). Read-only.
  // ════════════════════════════════════════════════════════════════
  router.get("/public/rent-roll/admin", async (req, res) => {
    if (!checkPassword(req, res)) return;
    try {
      const sessions = (await pool.query(
        `select s.id, s.uploader_name, s.uploader_email, s.source_filename,
                s.detected_system, s.format_signature, s.level_reached,
                s.extracted_row_count, s.created_at,
                f.rating, f.notes, f.created_at as feedback_at
           from public_upload_sessions s
           left join public_rent_roll_feedback f on f.session_id = s.id
          order by s.created_at desc
          limit 200`
      )).rows;

      const ratingCounts = (await pool.query(
        `select coalesce(rating,'(ungraded)') as rating, count(*)::int as n
           from public_rent_roll_feedback group by rating`
      )).rows;

      const mappings = (await pool.query(
        `select format_signature, source_column, canonical_field,
                corrected_by_human, times_seen, last_seen_at
           from mapping_memory
          order by last_seen_at desc
          limit 200`
      )).rows;

      const totals = (await pool.query(
        `select
           (select count(*)::int from public_upload_sessions) as total_uploads,
           (select count(*)::int from public_rent_roll_feedback) as total_feedback,
           (select count(*)::int from mapping_memory) as total_learned_mappings`
      )).rows[0];

      res.json({ totals, rating_breakdown: ratingCounts, sessions, learned_mappings: mappings });
    } catch (e) {
      console.error("public admin error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
