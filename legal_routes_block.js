// ════════════════════════════════════════════════════════════════════
//  LEGAL PAGES — A2P 10DLC compliance (privacy policy + SMS terms)
//  Public, no auth (carriers must reach them during campaign vetting).
//  Served by the API itself — same pattern as the tenant setup page,
//  so the pilot needs zero extra hosting. Brand: Fraunces + IBM Plex on
//  the dark palette. Plain-text fallbacks at /legal/privacy.txt and
//  /legal/sms-terms.txt in case a vetting bot dislikes styled HTML.
//
//  These are the two URLs the A2P campaign form requires:
//    Privacy Policy URL → {APP_BASE_URL}/legal/privacy
//    Terms & Conditions URL → {APP_BASE_URL}/legal/sms-terms
//  i.e. https://property-spine-api.onrender.com/legal/privacy
//       https://property-spine-api.onrender.com/legal/sms-terms
// ════════════════════════════════════════════════════════════════════
const LEGAL_BRAND = "Virtus Management LLC (DBA OneFive Capital)";
const LEGAL_PROGRAM = "OneFive Capital Tenant Line";
const LEGAL_CONTACT = "kameron@onefivecap.com";
const LEGAL_UPDATED = "June 14, 2026";

function legalPage(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${title} — ${LEGAL_BRAND}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
:root{--bg:#0e1116;--panel:#161a21;--line:#262c38;--ink:#e7e4dd;--ink-dim:#9aa0ab;--accent:#d4a056;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:'IBM Plex Sans',sans-serif;line-height:1.65;
display:flex;justify-content:center;padding:40px 18px 80px;-webkit-font-smoothing:antialiased}
.wrap{width:100%;max-width:680px}
.kicker{font-family:'IBM Plex Sans',sans-serif;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);margin-bottom:8px}
h1{font-family:'Fraunces',serif;font-size:30px;font-weight:600;margin-bottom:6px;line-height:1.15}
.updated{color:var(--ink-dim);font-size:13px;margin-bottom:28px}
h2{font-family:'Fraunces',serif;font-size:19px;font-weight:600;margin:26px 0 8px}
p{margin-bottom:12px;color:#d6d2c9}
ul{margin:0 0 12px 20px;color:#d6d2c9}li{margin-bottom:6px}
strong{color:var(--ink)}
a{color:var(--accent)}
.box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:18px 0}
hr{border:none;border-top:1px solid var(--line);margin:30px 0}
.foot{color:var(--ink-dim);font-size:12px;margin-top:30px}
</style></head><body><div class="wrap">
<div class="kicker">${LEGAL_BRAND}</div>
<h1>${title}</h1>
<div class="updated">Last updated ${LEGAL_UPDATED}</div>
${bodyHtml}
<hr/>
<p class="foot">${LEGAL_BRAND} · Questions? Contact <a href="mailto:${LEGAL_CONTACT}">${LEGAL_CONTACT}</a></p>
</div></body></html>`;
}

// ── SMS Terms & Conditions ───────────────────────────────────────────
const SMS_TERMS_HTML = `
<div class="box">
<p><strong>Program:</strong> ${LEGAL_PROGRAM}</p>
<p><strong>Program description:</strong> A two-way text messaging service for residents of properties managed by ${LEGAL_BRAND}. Residents text their property's number to submit maintenance requests, ask about rent balances, and receive building updates; property staff and the system reply on the same number.</p>
</div>

<h2>How you opt in</h2>
<p>Residents opt in during lease onboarding. Property staff send you a personal setup link; you verify your mobile number with a one-time passcode sent to the number on file, and consent to receive text messages from your property's line. Your opt-in is recorded for your resident account. We do not add anyone to this program who has not completed this verified opt-in.</p>

<h2>Message frequency</h2>
<p>Message frequency varies and depends on your activity — for example, when you send a maintenance request, ask a question, or when your property sends an update relevant to you. This is a conversational service, not a recurring bulk-message program.</p>

<h2>Costs</h2>
<p><strong>Message and data rates may apply.</strong> ${LEGAL_BRAND} does not charge for the messages themselves; your mobile carrier's standard message and data rates apply according to your plan.</p>

<h2>To get help</h2>
<p>Reply <strong>HELP</strong> to any message for help, or contact us at <a href="mailto:${LEGAL_CONTACT}">${LEGAL_CONTACT}</a>.</p>

<h2>To opt out</h2>
<p>Reply <strong>STOP</strong> at any time to stop receiving text messages from your property's line. After you reply STOP, you will receive one confirmation message and then no further texts, unless you opt in again. Opting out of texts does not affect your lease or your ability to reach your property manager by other means.</p>

<h2>Carriers</h2>
<p>Carriers are not liable for delayed or undelivered messages.</p>

<h2>Privacy</h2>
<p>Your privacy is important to us. See our <a href="/legal/privacy">Privacy Policy</a> for how we handle your information. We do not share your mobile information with third parties or affiliates for marketing or promotional purposes.</p>
`;

app.get("/legal/sms-terms", (_req, res) =>
  res.set("Content-Type", "text/html").send(legalPage("SMS Terms &amp; Conditions", SMS_TERMS_HTML)));
app.get("/legal/sms-terms.txt", (_req, res) =>
  res.set("Content-Type", "text/plain").send(
`${LEGAL_PROGRAM} — SMS Terms & Conditions (updated ${LEGAL_UPDATED})

Program: ${LEGAL_PROGRAM}, a two-way text messaging service for residents of properties managed by ${LEGAL_BRAND}. Residents text their property's number to submit maintenance requests, ask about rent balances, and receive building updates.

Opt-in: Residents opt in during lease onboarding by verifying their mobile number with a one-time passcode sent to the number on file. Only verified residents are messaged.

Message frequency: Varies based on your activity. This is a conversational service, not a recurring bulk program.

Costs: Message and data rates may apply. ${LEGAL_BRAND} does not charge for messages; standard carrier rates apply.

HELP: Reply HELP for help, or email ${LEGAL_CONTACT}.
STOP: Reply STOP at any time to opt out. You will receive one confirmation and then no further texts.

Carriers are not liable for delayed or undelivered messages.
We do not share your mobile information with third parties for marketing purposes.
Privacy policy: /legal/privacy`));

// ── Privacy Policy ───────────────────────────────────────────────────
const PRIVACY_HTML = `
<p>${LEGAL_BRAND} ("we," "us") operates a text messaging service that lets residents of properties we manage communicate with their property. This policy explains what we collect through that service, how we use it, and how we protect it.</p>

<h2>Information we collect</h2>
<ul>
<li><strong>Your mobile phone number</strong>, provided during lease onboarding and verified by one-time passcode.</li>
<li><strong>The content of messages</strong> you send to and receive from your property's line.</li>
<li><strong>Resident and tenancy details</strong> needed to serve you — your name, unit, and lease as they relate to your messages (for example, to open a maintenance request or answer a balance question).</li>
</ul>

<h2>How we use your information</h2>
<ul>
<li>To operate the tenant text line: route your messages, open maintenance requests, answer questions about your account, and send you updates relevant to your tenancy.</li>
<li>To verify your identity when you connect to the service.</li>
<li>To keep a record of communications between you and your property.</li>
</ul>

<h2>How we share your information</h2>
<div class="box">
<p><strong>We do not sell your information. We do not share your mobile information with third parties or affiliates for marketing or promotional purposes.</strong> No mobile information is shared with third parties for marketing.</p>
</div>
<p>We share information only with service providers that help us operate the messaging service (for example, our messaging carrier, Twilio, which transmits the texts), and only as needed to deliver the service. These providers are bound to handle your information solely for that purpose. We may also disclose information where required by law.</p>

<h2>How long we keep it</h2>
<p>We retain message records for as long as you are a resident and as needed for property records and legal compliance, after which they are deleted or anonymized.</p>

<h2>Your choices</h2>
<p>You can opt out of text messages at any time by replying <strong>STOP</strong> to your property's line. You can ask us what information we hold about you, or request corrections, by contacting us at <a href="mailto:${LEGAL_CONTACT}">${LEGAL_CONTACT}</a>.</p>

<h2>Security</h2>
<p>We use reasonable administrative and technical safeguards to protect your information. Phone-number verification uses one-time passcodes, and the verification codes themselves are never stored in readable form.</p>

<h2>Changes</h2>
<p>We may update this policy; the "last updated" date above reflects the current version.</p>
`;

app.get("/legal/privacy", (_req, res) =>
  res.set("Content-Type", "text/html").send(legalPage("Privacy Policy", PRIVACY_HTML)));
app.get("/legal/privacy.txt", (_req, res) =>
  res.set("Content-Type", "text/plain").send(
`${LEGAL_BRAND} — Privacy Policy (updated ${LEGAL_UPDATED})

${LEGAL_BRAND} operates a text messaging service for residents of properties we manage.

Information we collect: your mobile number (verified by one-time passcode), the content of your messages, and the resident/tenancy details needed to serve you (name, unit, lease).

How we use it: to route your messages, open maintenance requests, answer account questions, send tenancy-relevant updates, and verify your identity.

How we share it: We do not sell your information. We do NOT share your mobile information with third parties or affiliates for marketing or promotional purposes. We share only with service providers (e.g., our messaging carrier Twilio) as needed to deliver the service, and where required by law.

Retention: kept while you are a resident and as needed for records/compliance, then deleted or anonymized.

Your choices: reply STOP to opt out anytime; email ${LEGAL_CONTACT} for access/correction requests.

Security: reasonable safeguards; one-time passcodes are never stored in readable form.`));
