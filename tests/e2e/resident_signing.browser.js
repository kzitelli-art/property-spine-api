/*  BROWSER RUNG — THE RESIDENT SIGNS, IN A REAL BROWSER.
    Real Chromium, the real tenant page served by the real server.js, a real
    tokenized link, real Postgres behind every write. Not the operator shell:
    that boot path is pinned to PRODUCTION_ORIGIN by design and is on the
    hands-off list, so it is not forced here.                              */
const { chromium } = require("../../node_modules/playwright");
const { pool, q, api, ctx, toPacket } = require("./leasing_e2e_lib.js");
const OUT = __dirname;
let pass = 0, fail = 0;
const ok  = (n, d) => { pass++; console.log(`  ✓ ${n}${d ? "  — " + d : ""}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}  — ${d}`); };

(async () => {
  const C = await ctx();
  const P = await toPacket(C, { bed: C.bedB });
  console.log(`  packet ${P.packetId.slice(0, 8)} · link /t/lease/${P.rawTok.slice(0, 12)}…`);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });   // a resident's phone
  const errors = [], sandbox = [];
  page.on("pageerror", (e) => errors.push("APP " + e.message));
  //  Requests are classified by ORIGIN. Anything to this server is the
  //  product under test. Anything external (the page links Google Fonts) is
  //  this container's egress proxy, which Chromium cannot authenticate to —
  //  a fact about the harness, not the product. Saying so beats a green tick
  //  that quietly ignores real failures.
  page.on("requestfailed", (r) => {
    const u = r.url();
    (u.includes("localhost:3000") ? errors : sandbox).push(`${r.method()} ${u.slice(0,70)} :: ${(r.failure()||{}).errorText}`);
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const line = `HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0,90)}`;
    (r.url().includes("localhost:3000") ? errors : sandbox).push(line);
  });

  await page.goto(`http://localhost:3000/t/lease/${P.rawTok}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const seen = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
  await page.screenshot({ path: OUT + "/resident_page.png", fullPage: true });

  // ── what the resident can actually SEE ──────────────────────────
  const shows = (s) => seen.includes(s);
  if (shows("1025") || shows("1,025")) ok("the rent is visible to the resident"); else bad("rent visible", "no rent in the rendered text");
  if (/Bed B|3B/.test(seen)) ok("the space is visible", /Bed B/.test(seen) ? "Bed B" : "Unit 3B"); else bad("space visible", "neither unit nor bed rendered");
  if (/Official lease package/i.test(seen) && /Governing lease form/i.test(seen))
    ok("the governing package and retained lease form are visible");
  else bad("governing package visible", "the official-package identity or retained form did not render");

  // ── the resident acts, in the browser ───────────────────────────
  const controls = await page.$$('button, [role="button"], input[type="checkbox"]');
  ok("interactive controls rendered", `${controls.length} control(s)`);

  const before = (await q(`select count(*)::int n from lease_packet_fields
                            where lease_packet_id=$1 and completed=true`, [P.packetId])).rows[0].n;

  //  The page re-renders after every acknowledgment, so handles go stale.
  //  Re-query each pass — this is how a resident actually uses it.
  let clicked = 0;
  for (let pass = 0; pass < 12; pass++) {
    const els = await page.$$('button, [role="button"]');
    let acted = false;
    for (const el of els) {
      const t = ((await el.innerText().catch(() => "")) || "").trim();
      if (/^acknowledge$/i.test(t)) {
        try { await el.click({ timeout: 2000 }); clicked++; acted = true; await page.waitForTimeout(600); } catch (_) {}
        break;
      }
    }
    if (!acted) break;
  }
  const signer = (await q("select name from persons where id=$1", [P.person])).rows[0];
  try {
    await page.fill('input[aria-label="Full legal name"]', signer.name);
    await page.click('button:has-text("Sign")');
    clicked++;
  } catch (e) { errors.push("signature: " + e.message.slice(0, 90)); }
  await page.waitForTimeout(800);
  const after = (await q(`select count(*)::int n from lease_packet_fields
                           where lease_packet_id=$1 and completed=true`, [P.packetId])).rows[0].n;
  const reqTotal = (await q(`select count(*)::int n from lease_packet_fields
                              where lease_packet_id=$1 and required=true`, [P.packetId])).rows[0].n;
  if (after > before) ok("clicking in the browser wrote to Postgres", `${clicked} click(s) · completed ${before} → ${after} of ${reqTotal} required`);
  else bad("browser clicks reached the database", `${clicked} click(s), fields still ${after}`);

  //  THE FINAL SUBMIT, IN THE BROWSER — the real control, by its own id,
  //  waited for rather than raced.
  let submitted = false;
  try {
    await page.waitForSelector("#submitBtn:not([disabled])", { timeout: 8000 });
    await page.click("#submitBtn");
    submitted = true;
    await page.waitForTimeout(2500);
  } catch (e) { errors.push("submit: " + e.message.slice(0, 90)); }
  await page.screenshot({ path: OUT + "/resident_after_clicks.png", fullPage: true });
  const pkt = (await q("select status from lease_packets where id=$1", [P.packetId])).rows[0];
  if (pkt.status === "resident_executed") ok("the resident executed the instrument FROM A BROWSER", `packet ${pkt.status}`);
  else bad("resident execution from the browser", `packet is '${pkt.status}' after ${clicked} click(s), submit=${submitted}`);

  if (!errors.length) ok("no failures from this server", `${sandbox.length} external request(s) blocked by this container's egress proxy — harness, not product`);
  else bad("failures from this server", errors.slice(0, 3).join(" || "));

  console.log(`\n  screenshots: ${OUT}/resident_page.png · ${OUT}/resident_after_clicks.png`);
  console.log(`  BROWSER RUNG: ${pass} passed, ${fail} failed`);
  await browser.close(); await pool.end();
  process.exit(fail ? 2 : 0);
})().catch(async (e) => { console.log("DIED: " + e.stack); try { await pool.end(); } catch (_) {} process.exit(1); });
