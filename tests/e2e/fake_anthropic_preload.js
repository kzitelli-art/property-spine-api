/*  E2E model-wire sentinel.

    The real server is composed with an Anthropic-shaped client, but no request
    may leave the disposable verification process. Every attempted generation
    is appended to E2E_ANTHROPIC_LOG and then refused locally. Tests can compare
    the log before/after one HTTP request and prove that a 404 did not merely
    hide a provider call behind an error response. */
"use strict";

const fs = require("fs");
const Module = require("module");
const originalLoad = Module._load;

class E2EAnthropic {
  constructor() {
    this.messages = {
      create: async () => {
        const log = process.env.E2E_ANTHROPIC_LOG;
        if (log) fs.appendFileSync(log, `${Date.now()} messages.create\n`);
        throw new Error("E2E Anthropic sentinel refused a model call");
      },
    };
  }
}

Module._load = function loadWithE2EAnthropic(request, parent, isMain) {
  if (request === "@anthropic-ai/sdk") return E2EAnthropic;
  return originalLoad.call(this, request, parent, isMain);
};
