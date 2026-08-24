"use strict";

/*
 * CLASS 2 — TEMPORARY ADAPTER.
 *
 * This page owns no authentication or provisioning decision. It gives a human
 * browser access to teamaccess.js's existing /auth/sms/start and
 * /auth/sms/verify doors. Remove it when the canonical staff app has a
 * browser-verified invite-token entry screen of its own.
 */

function inlineJson(value) {
  return JSON.stringify(String(value || ""))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function safeAppOrigin(raw) {
  if (!raw) return "";
  try {
    const parsed = new URL(String(raw));
    const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !localHttp) return "";
    return parsed.origin;
  } catch (_) {
    return "";
  }
}

function renderStaffInviteAcceptancePage({ token, appOrigin }) {
  const tokenJson = inlineJson(token);
  const appOriginJson = inlineJson(safeAppOrigin(appOrigin));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Set up Property Spine access</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#596579;--line:#d9dfeb;--accent:#244c9b;--bad:#9c2f2f}
    *{box-sizing:border-box}body{margin:0;background:#f3f5f9;color:var(--ink);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(100% - 32px,460px);margin:8vh auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 14px 40px rgba(28,39,64,.08)}
    h1{font-size:1.55rem;line-height:1.2;margin:0 0 10px}p{margin:0 0 18px;color:var(--muted)}
    label{display:block;font-weight:650;margin:18px 0 7px}input{width:100%;font:inherit;padding:12px 14px;border:1px solid #aeb8ca;border-radius:9px;letter-spacing:.16em}
    button,a.action{display:inline-block;width:100%;margin-top:12px;padding:12px 16px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:650 1rem/1.25 system-ui;text-align:center;text-decoration:none;cursor:pointer}
    button[disabled]{opacity:.55;cursor:wait}.hidden{display:none}.status{min-height:24px;margin-top:16px;color:var(--ink)}.status.error{color:var(--bad)}
    .fine{font-size:.88rem;margin-top:18px}.success{padding:14px;border-radius:10px;background:#edf6ef;color:#1f5e32}
  </style>
</head>
<body>
  <main>
    <h1>Set up your Property Spine access</h1>
    <p>First, request a six-digit verification code. It will be sent to the phone number your manager invited.</p>
    <section id="requestStep">
      <button id="sendCode" type="button">Text me a verification code</button>
    </section>
    <section id="verifyStep" class="hidden">
      <label for="otp">Verification code</label>
      <input id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" aria-describedby="status">
      <button id="verifyCode" type="button">Verify and activate access</button>
    </section>
    <div id="status" class="status" role="status" aria-live="polite"></div>
    <section id="successStep" class="hidden">
      <p class="success">Your staff access is active. Sign in to Property Spine with this phone number to continue.</p>
      <a id="openApp" class="action hidden" rel="noreferrer">Open Property Spine</a>
    </section>
    <p class="fine">This link can be used only once. Property Spine will never ask you for an operator key.</p>
  </main>
  <script>
  (() => {
    "use strict";
    const token = ${tokenJson};
    const appOrigin = ${appOriginJson};
    const send = document.getElementById("sendCode");
    const verify = document.getElementById("verifyCode");
    const otp = document.getElementById("otp");
    const status = document.getElementById("status");
    const requestStep = document.getElementById("requestStep");
    const verifyStep = document.getElementById("verifyStep");
    const successStep = document.getElementById("successStep");
    const openApp = document.getElementById("openApp");

    function message(text, isError) {
      status.textContent = text || "";
      status.className = "status" + (isError ? " error" : "");
    }
    async function post(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        redirect: "error",
        cache: "no-store"
      });
      let payload = {};
      try { payload = await response.json(); } catch (_) {}
      if (!response.ok) throw new Error(payload.receipt || payload.error || "Property Spine could not complete that request.");
      return payload;
    }

    send.addEventListener("click", async () => {
      send.disabled = true;
      message("Sending your code…", false);
      try {
        const result = await post("/auth/sms/start", { token });
        requestStep.classList.add("hidden");
        verifyStep.classList.remove("hidden");
        message(result.receipt || "Code sent. Enter it below.", false);
        otp.focus();
      } catch (error) {
        message(error.message, true);
        send.disabled = false;
      }
    });

    verify.addEventListener("click", async () => {
      const code = otp.value.trim();
      if (!/^\\d{6}$/.test(code)) { message("Enter the six-digit code from your text.", true); return; }
      verify.disabled = true;
      message("Verifying…", false);
      try {
        await post("/auth/sms/verify", { token, code });
        verifyStep.classList.add("hidden");
        successStep.classList.remove("hidden");
        message("Access activated.", false);
        if (appOrigin) {
          openApp.href = appOrigin;
          openApp.classList.remove("hidden");
        }
      } catch (error) {
        message(error.message, true);
        verify.disabled = false;
      }
    });
  })();
  </script>
</body>
</html>`;
}

module.exports = { renderStaffInviteAcceptancePage, safeAppOrigin };
