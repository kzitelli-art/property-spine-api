"use strict";

const express = require("express");
const http = require("http");

let passed = 0;
const ok = (label, condition) => {
  if (!condition) throw new Error("FAIL " + label);
  passed++;
  console.log("PASS " + label);
};

(async () => {
  const priorNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  let assignmentReady = true;
  let wireResult = { sent: false, reason: "no_property_line" };
  let inviteNumber = 0;
  const queries = [];
  const pool = {
    async query(sql) {
      const text = String(sql);
      queries.push(text);
      if (/select id, name from users/i.test(text)) {
        return { rows: [{ id: "user-1", name: "KZ" }] };
      }
      if (/from property_team_assignments a/i.test(text)) {
        return { rows: [{ property_id: "property-sms", sms_ready: assignmentReady }] };
      }
      if (/select id, token, otp_sent_at from team_invites/i.test(text)) {
        return { rows: [] };
      }
      if (/select id from team_invites/i.test(text)) {
        return { rows: [] };
      }
      if (/insert into team_invites/i.test(text)) {
        inviteNumber++;
        return { rows: [{
          id: "invite-" + inviteNumber,
          token: "token-" + inviteNumber,
          property_id: "property-sms",
          phone_number: "+17035550134",
          accepted_user_id: "user-1",
          allowed_modules: [],
          otp_sent_at: null,
        }] };
      }
      //  Matches the OTP-body property read. It now selects
      //  `coalesce(display_name, name) as name` so the operator sees the
      //  building's name, not its internal one — anchor the mock on
      //  `sms_number from properties where id`, which is unique to this read
      //  and survives the aliasing rather than pinning the old column list.
      if (/sms_number\s+from properties\s+where id/i.test(text)) {
        return { rows: [{ name: "Property with line", sms_number: "+12155550121" }] };
      }
      return { rows: [] };
    },
  };
  const commBoundary = {
    async sendPropertySms() { return wireResult; },
  };

  const app = express();
  app.use(express.json());
  app.use(require("../src/identity/teamaccess")({ pool, sms: null, commBoundary }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function start() {
    const response = await fetch(base + "/auth/sms/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone_number: "703-555-0134" }),
    });
    return { response, body: await response.json() };
  }

  try {
    const failed = await start();
    ok("production refuses a code that did not leave the transport", failed.response.status === 503);
    ok("the refusal does not return a verification token", !failed.body.token);
    ok("the refusal tells the browser delivery failed", failed.body.delivery === "not_configured");
    ok("failed OTP material and the resend marker are cleared",
      queries.some((sql) => /set otp_hash=null, otp_expires_at=null, otp_sent_at=null/i.test(sql)));

    wireResult = { sent: true, sid: "SM_PROOF", status: "queued" };
    const sent = await start();
    ok("an accepted provider send returns success", sent.response.status === 200);
    ok("the successful response carries the relogin token", /^token-/.test(sent.body.token || ""));
    ok("the successful response names the provider-backed delivery", sent.body.delivery === "sms_sent");

    assignmentReady = false;
    const before = inviteNumber;
    const unavailable = await start();
    ok("an account with no configured assignment is refused before OTP creation", unavailable.response.status === 503);
    ok("no invite is minted when no assigned property can deliver", inviteNumber === before);

    const assignmentSql = queries.find((sql) => /from property_team_assignments a/i.test(sql)) || "";
    ok("assignment selection joins the canonical property line", /join properties p/i.test(assignmentSql));
    ok("assignment selection prefers a configured SMS line before recency",
      /sms_number[\s\S]*desc,[\s\S]*can_manage_roles/i.test(assignmentSql));
  } finally {
    process.env.NODE_ENV = priorNodeEnv;
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${passed} staff SMS delivery assertions passed`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
