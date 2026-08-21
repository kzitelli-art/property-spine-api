"use strict";

// Test-only transport substitution for full-server E2E runs. It preserves the
// communications boundary and records what would reach Twilio, but has no
// network implementation and therefore cannot contact a real phone.
const fs = require("fs");
const path = require("path");
const Module = require("module");

const transportPath = path.resolve(__dirname, "../../src/comms/sms.js");
const originalLoad = Module._load;

Module._load = function loadWithFakeSms(request, parent, isMain) {
  let resolved = null;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) {}
  if (resolved === transportPath) {
    return function fakeSmsTransport() {
      return {
        enabled: () => true,
        validateWebhook: () => false,
        fetchMedia: async () => ({ ok: false, reason: "e2e_transport_has_no_media" }),
        sendSms: async ({ to, from, body }) => {
          const file = process.env.E2E_SMS_LOG;
          if (!file) return { sent: false, reason: "e2e_sms_log_not_configured" };
          fs.appendFileSync(file, JSON.stringify({ to, from, body, at: new Date().toISOString() }) + "\n");
          return { sent: true, sid: `SM_E2E_${Date.now()}`, status: "queued" };
        },
      };
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
