/* BROWSER RUNG — A STAFF INVITEE OPENS THE LITERAL TEXT LINK.
   Real Chromium, real server.js, real migrated Postgres, fake carrier only.
   The proof starts from the URL returned by the invite endpoint; it never
   extracts the token and jumps around the public page. */
"use strict";

const fs = require("fs");
const { chromium } = require("../../node_modules/playwright");
const { pool, q, api, ctx } = require("./leasing_e2e_lib.js");

const SMS_LOG = process.env.E2E_SMS_LOG;
let pass = 0;
let fail = 0;
const ok = (name, detail) => { pass++; console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); };
const bad = (name, detail) => { fail++; console.log(`  ✗ ${name} — ${detail}`); };

function smsMessages() {
  if (!SMS_LOG || !fs.existsSync(SMS_LOG)) return [];
  return fs.readFileSync(SMS_LOG, "utf8").trim().split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForSms(predicate, label) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const hit = smsMessages().find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fake carrier did not record ${label}`);
}

(async () => {
  const C = await ctx({ wipe: false });
  const suffix = String(Date.now()).slice(-7);
  const phone = `+1312${suffix}`;

  const existingLine = (await q(
    `select id from communication_lines
      where property_id=$1 and line_type='property_facing' and status='active'
      limit 1`, [C.prop]
  )).rows[0];
  if (!existingLine) {
    await q(
      `insert into communication_lines
         (e164,line_type,property_id,authority_ceiling,permitted_audience,
          inbound_enabled,outbound_enabled,outbound_policy,status)
       values ($1,'property_facing',$2,'external','residents_and_prospects',
               true,true,'proactive','active')`,
      [`+1215${suffix}`, C.prop]
    );
  }

  const person = (await q(
    `insert into persons (name,phone,primary_phone_e164,lifecycle_status,source)
     values ($1,$2,$2,'lead','staff_invite_browser_fixture') returning id`,
    [`Mike Grivna Browser ${suffix}`, phone]
  )).rows[0];

  const invited = await api("POST", `/properties/${C.prop}/team-invites`, {
    token: C.token,
    body: {
      invited_name: "Mike Grivna",
      phone_number: phone,
      role_key: "leasing_agent",
      scope_type: "property",
      person_id: person.id,
    },
  });
  if (invited.status !== 200 || !invited.body?.link) {
    throw new Error(`staff invite failed: ${invited.status} ${JSON.stringify(invited.body)}`);
  }
  const inviteId = invited.body.invite_id;
  if (/\/auth\/join\/[A-Za-z0-9_-]{24}$/.test(invited.body.link)) ok("the text names the public join door");
  else bad("the text names the public join door", invited.body.link);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const productErrors = [];
  page.on("pageerror", (error) => productErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().startsWith("http://localhost:3000")) {
      productErrors.push(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const landing = await page.goto(invited.body.link, { waitUntil: "networkidle" });
  const openingText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  if (landing?.status() === 200 && /Set up your Property Spine access/i.test(openingText)) {
    ok("Mike's literal text link opens in a browser", "HTTP 200");
  } else {
    bad("Mike's literal text link opens in a browser", `HTTP ${landing?.status()} · ${openingText.slice(0, 120)}`);
  }
  if (!/Missing or wrong x-operator-key/i.test(openingText)) ok("the public door never asks Mike for an operator key");
  else bad("the public door never asks Mike for an operator key", openingText);

  await page.click("#sendCode");
  await page.waitForSelector("#verifyStep:not(.hidden)", { timeout: 8000 });
  const otpText = await waitForSms(
    (message) => message.to === phone && /access code is \d{6}/.test(message.body || ""),
    "the staff OTP"
  );
  const code = String(otpText.body).match(/access code is (\d{6})/)[1];
  ok("the browser requests the existing staff OTP", otpText.to);

  await page.fill("#otp", code);
  await page.click("#verifyCode");
  await page.waitForSelector("#successStep:not(.hidden)", { timeout: 10000 });
  const finishedText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  if (/Your staff access is active/i.test(finishedText)) ok("the browser reports activation only after verification");
  else bad("the browser reports activation only after verification", finishedText.slice(0, 160));

  const accepted = (await q(
    `select i.status, i.accepted_user_id, u.person_id, pta.primary_for_modules,
            exists(select 1 from person_contexts pc
                    where pc.person_id=u.person_id and pc.property_id=i.property_id
                      and pc.context_type='staff' and pc.active_to is null) as has_staff_context,
            exists(select 1 from assignments a
                    where a.person_id=u.person_id and a.property_id=i.property_id
                      and a.role='leasing' and a.is_active=true) as has_leasing_assignment
       from team_invites i
       join users u on u.id=i.accepted_user_id
       join property_team_assignments pta
         on pta.user_id=u.id and pta.property_id=i.property_id and pta.active=true
      where i.id=$1`, [inviteId]
  )).rows[0];
  if (accepted && accepted.status === "accepted" && accepted.person_id === person.id
      && accepted.has_staff_context && accepted.has_leasing_assignment
      && accepted.primary_for_modules.includes("leasing")) {
    ok("one browser acceptance creates the identity, context, access, and work assignment");
  } else {
    bad("one browser acceptance creates the identity, context, access, and work assignment", JSON.stringify(accepted));
  }

  if (!productErrors.length) ok("the join journey has no product-origin browser failures");
  else bad("the join journey has no product-origin browser failures", productErrors.slice(0, 4).join(" || "));

  console.log(`  STAFF INVITE BROWSER RUNG: ${pass} passed, ${fail} failed`);
  await browser.close();
  await pool.end();
  process.exit(fail ? 2 : 0);
})().catch(async (error) => {
  console.error("DIED: " + error.stack);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
