/* BROWSER RUNG — A STAFF INVITEE OPENS THE LITERAL TEXT LINK.
   Real Chromium, real server.js, real migrated Postgres, fake carrier only.
   The proof starts from the URL returned by the invite endpoint; it never
   extracts the token and jumps around the public page. */
"use strict";

const crypto = require("crypto");
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

function messagesTo(phone) {
  return smsMessages().filter((message) => message.to === phone);
}

const newToken = () => crypto.randomBytes(18).toString("base64url");
const hashOtp = (code, token) =>
  crypto.createHash("sha256").update(`${code}:${token}`).digest("hex");
let fixturePhoneSequence = 0;
const fixturePhone = () => `+1646${String(Date.now() + (++fixturePhoneSequence)).slice(-7)}`;

async function seedInvite(C, {
  status = "active",
  expiresAt = new Date(Date.now() + 3600000).toISOString(),
  failedAttempts = 0,
  code = null,
} = {}) {
  const token = newToken();
  const phone = fixturePhone();
  const otpExpiresAt = code ? new Date(Date.now() + 600000).toISOString() : null;
  const row = (await q(
    `insert into team_invites
       (property_id,phone_number,invited_name,role_title,allowed_modules,scope_type,
        invited_by_user_id,token,status,expires_at,failed_attempts,
        otp_hash,otp_expires_at,otp_sent_at)
     values ($1,$2,'Lifecycle Probe','Leasing Agent',array['leasing'],'property',
             $3,$4,$5,$6,$7,$8,$9,case when $8::text is null then null else now() end)
     returning id,token,phone_number,status,expires_at,failed_attempts,
               otp_hash,otp_expires_at,otp_sent_at,accepted_user_id`,
    [C.prop, phone, C.mike, token, status, expiresAt, failedAttempts,
     code ? hashOtp(code, token) : null, otpExpiresAt]
  )).rows[0];
  return { ...row, code };
}

async function inviteRow(id) {
  return (await q(
    `select id,status,expires_at,failed_attempts,otp_hash,otp_expires_at,
            otp_sent_at,accepted_at,accepted_user_id
       from team_invites where id=$1`, [id]
  )).rows[0];
}

async function startMustRefuse(C, spec) {
  const seeded = await seedInvite(C, spec);
  const before = await inviteRow(seeded.id);
  const wireBefore = messagesTo(seeded.phone_number).length;
  const result = await api("POST", "/auth/sms/start", { body: { token: seeded.token } });
  const after = await inviteRow(seeded.id);
  const wireAfter = messagesTo(seeded.phone_number).length;
  const receipt = String(result.body?.receipt || "");
  if (result.status === spec.httpStatus && spec.receipt.test(receipt)) {
    ok(`${spec.label}: start refuses honestly`, `HTTP ${result.status}`);
  } else {
    bad(`${spec.label}: start refuses honestly`, `HTTP ${result.status} ${receipt}`);
  }
  if (JSON.stringify(before) === JSON.stringify(after) && wireBefore === wireAfter) {
    ok(`${spec.label}: refusal writes no OTP and sends no SMS`);
  } else {
    bad(`${spec.label}: refusal writes no OTP and sends no SMS`,
        JSON.stringify({ before, after, wireBefore, wireAfter }));
  }
  return seeded;
}

async function verifyMustRefuse(C, spec) {
  const seeded = await seedInvite(C, { ...spec, code: "424242" });
  const before = await inviteRow(seeded.id);
  const result = await api("POST", "/auth/sms/verify", {
    body: { token: seeded.token, code: seeded.code },
  });
  const after = await inviteRow(seeded.id);
  const user = (await q("select id from users where phone=$1", [seeded.phone_number])).rows[0];
  const receipt = String(result.body?.receipt || "");
  if (result.status === spec.httpStatus && spec.receipt.test(receipt)) {
    ok(`${spec.label}: verify refuses a still-valid planted code`, `HTTP ${result.status}`);
  } else {
    bad(`${spec.label}: verify refuses a still-valid planted code`, `HTTP ${result.status} ${receipt}`);
  }
  if (JSON.stringify(before) === JSON.stringify(after) && !user) {
    ok(`${spec.label}: verify refusal provisions nobody`);
  } else {
    bad(`${spec.label}: verify refusal provisions nobody`, JSON.stringify({ before, after, user }));
  }
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

  // Class 3 lifecycle proof. Fixtures establish states directly; every
  // decision is exercised through the real public HTTP doors. The table,
  // router, communications boundary and verification transaction are real.
  const noSuch = await api("POST", "/auth/sms/start", {
    body: { token: newToken() },
  });
  if (noSuch.status === 404 && /isn't valid/i.test(noSuch.body?.receipt || "")) {
    ok("a nonexistent invitation is an honest 404");
  } else {
    bad("a nonexistent invitation is an honest 404", JSON.stringify(noSuch));
  }

  const past = new Date(Date.now() - 60000).toISOString();
  const startRefusals = [
    { label: "revoked invitation", status: "revoked", httpStatus: 410, receipt: /revoked/i },
    { label: "superseded invitation", status: "superseded", httpStatus: 410, receipt: /replaced/i },
    { label: "stored expired invitation", status: "expired", httpStatus: 410, receipt: /expired/i },
    { label: "clock-expired invitation", status: "active", expiresAt: past, httpStatus: 410, receipt: /expired/i },
    { label: "accepted invitation", status: "accepted", httpStatus: 409, receipt: /already used/i },
    { label: "locked invitation", status: "active", failedAttempts: 5, httpStatus: 423, receipt: /too many wrong codes/i },
    { label: "unknown terminal state", status: "unrecognized", httpStatus: 410, receipt: /no longer active/i },
  ];
  for (const spec of startRefusals) await startMustRefuse(C, spec);

  const verifyRefusals = [
    { label: "revoked invitation", status: "revoked", httpStatus: 410, receipt: /no longer active/i },
    { label: "superseded invitation", status: "superseded", httpStatus: 410, receipt: /no longer active/i },
    { label: "stored expired invitation", status: "expired", httpStatus: 410, receipt: /expired/i },
    { label: "clock-expired invitation", status: "active", expiresAt: past, httpStatus: 410, receipt: /expired/i },
    { label: "locked invitation", status: "active", failedAttempts: 5, httpStatus: 423, receipt: /too many wrong codes/i },
    { label: "unknown terminal state", status: "unrecognized", httpStatus: 410, receipt: /no longer active/i },
  ];
  for (const spec of verifyRefusals) await verifyMustRefuse(C, spec);

  const lockProbe = await seedInvite(C);
  const lockStart = await api("POST", "/auth/sms/start", {
    body: { token: lockProbe.token },
  });
  const lockSms = await waitForSms(
    (message) => message.to === lockProbe.phone_number && /access code is \d{6}/.test(message.body || ""),
    "the lockout probe OTP"
  );
  const validLockCode = String(lockSms.body).match(/access code is (\d{6})/)[1];
  const wrongLockCode = validLockCode === "000000" ? "111111" : "000000";
  let lockStatuses = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await api("POST", "/auth/sms/verify", {
      body: { token: lockProbe.token, code: wrongLockCode },
    });
    lockStatuses.push(response.status);
  }
  const lockedRow = await inviteRow(lockProbe.id);
  if (lockStart.status === 200 && lockStatuses.join(",") === "401,401,401,401,423"
      && Number(lockedRow.failed_attempts) === 5 && !lockedRow.accepted_user_id) {
    ok("the fifth wrong code locks immediately and provisions nobody");
  } else {
    bad("the fifth wrong code locks immediately and provisions nobody",
        JSON.stringify({ lockStart: lockStart.status, lockStatuses, lockedRow }));
  }
  const correctAfterLock = await api("POST", "/auth/sms/verify", {
    body: { token: lockProbe.token, code: validLockCode },
  });
  if (correctAfterLock.status === 423) ok("even the correct code cannot bypass lockout");
  else bad("even the correct code cannot bypass lockout", JSON.stringify(correctAfterLock));

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
  const inviteToken = String(invited.body.link).split("/auth/join/")[1];
  if (/\/auth\/join\/[A-Za-z0-9_-]{24}$/.test(invited.body.link)) ok("the text names the public join door");
  else bad("the text names the public join door", invited.body.link);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  });
  const supersededBrowserInvite = await seedInvite(C, { status: "superseded" });
  const supersededPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const supersededBefore = await inviteRow(supersededBrowserInvite.id);
  const supersededWireBefore = messagesTo(supersededBrowserInvite.phone_number).length;
  await supersededPage.goto(`http://localhost:3000/auth/join/${supersededBrowserInvite.token}`,
    { waitUntil: "networkidle" });
  await supersededPage.click("#sendCode");
  await supersededPage.waitForFunction(() => /replaced/i.test(document.querySelector("#status")?.textContent || ""));
  const supersededReceipt = await supersededPage.locator("#status").innerText();
  const supersededAfter = await inviteRow(supersededBrowserInvite.id);
  const supersededWireAfter = messagesTo(supersededBrowserInvite.phone_number).length;
  if (/replaced/i.test(supersededReceipt)
      && JSON.stringify(supersededBefore) === JSON.stringify(supersededAfter)
      && supersededWireBefore === supersededWireAfter) {
    ok("the browser shows that a replaced link is inert");
  } else {
    bad("the browser shows that a replaced link is inert",
        JSON.stringify({ supersededReceipt, supersededBefore, supersededAfter,
          supersededWireBefore, supersededWireAfter }));
  }
  await supersededPage.close();

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const productErrors = [];
  page.on("pageerror", (error) => productErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().startsWith("http://localhost:3000")) {
      productErrors.push(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const beforeLanding = await inviteRow(inviteId);
  const messagesBeforeLanding = messagesTo(phone).length;
  const landing = await page.goto(invited.body.link, { waitUntil: "networkidle" });
  const afterLanding = await inviteRow(inviteId);
  const messagesAfterLanding = messagesTo(phone).length;
  const openingText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  if (landing?.status() === 200 && /Set up your Property Spine access/i.test(openingText)) {
    ok("Mike's literal text link opens in a browser", "HTTP 200");
  } else {
    bad("Mike's literal text link opens in a browser", `HTTP ${landing?.status()} · ${openingText.slice(0, 120)}`);
  }
  if (!/Missing or wrong x-operator-key/i.test(openingText)) ok("the public door never asks Mike for an operator key");
  else bad("the public door never asks Mike for an operator key", openingText);
  if (JSON.stringify(beforeLanding) === JSON.stringify(afterLanding)
      && messagesBeforeLanding === messagesAfterLanding) {
    ok("opening the link is inert: no OTP, lifecycle write, or SMS");
  } else {
    bad("opening the link is inert: no OTP, lifecycle write, or SMS",
        JSON.stringify({ beforeLanding, afterLanding, messagesBeforeLanding, messagesAfterLanding }));
  }

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

  const sessionsBeforeReplay = accepted ? Number((await q(
    `select count(*)::int as n from staff_sessions
      where user_id=$1 and property_id=$2 and revoked=false`,
    [accepted.accepted_user_id, C.prop]
  )).rows[0].n) : -1;
  const replay = await api("POST", "/auth/sms/verify", {
    body: { token: inviteToken, code },
  });
  const sessionsAfterReplay = accepted ? Number((await q(
    `select count(*)::int as n from staff_sessions
      where user_id=$1 and property_id=$2 and revoked=false`,
    [accepted.accepted_user_id, C.prop]
  )).rows[0].n) : -2;
  if (replay.status === 409 && sessionsBeforeReplay === sessionsAfterReplay) {
    ok("an accepted code cannot be replayed into another session");
  } else {
    bad("an accepted code cannot be replayed into another session",
        JSON.stringify({ replay, sessionsBeforeReplay, sessionsAfterReplay }));
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
