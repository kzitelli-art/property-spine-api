// ════════════════════════════════════════════════════════════════════
//  build_identity.js — WHAT EXACT CODE IS RUNNING?
//
//  Until that question has an answer read FROM THE RUNNING APPLICATION,
//  `deployed` is not a trustworthy proof state — it is an assumption that
//  the deployed build matches some branch. That assumption has already
//  been wrong here in both directions: a defect and its correction were
//  once both found absent from the running build.
//
//  ── IT REPORTS HOW IT KNOWS ─────────────────────────────────────────
//  Every answer carries `resolved_from`, because the confidence differs
//  enormously by source. A platform-injected commit is authoritative; a
//  local git checkout describes the developer's working tree, not a
//  build; and no answer at all is a real state that must not be dressed
//  up as one.
//
//  ── IT NEVER GUESSES ────────────────────────────────────────────────
//  When nothing identifies the build, `commit` is null and
//  `resolved_from` is "unidentified". A plausible-looking sha would be
//  worse than a blank: it would let someone believe they had verified
//  what is running when they had verified nothing. Honest blank beats
//  confident wrong, and this is the case the whole module exists for.
//
//  Resolved ONCE at module load. A build identity that could change while
//  the process runs would not be an identity.
//  READ-ONLY. Class 1 — permanent.
// ════════════════════════════════════════════════════════════════════
"use strict";

const fs = require("fs");
const path = require("path");

//  In precedence order. Platform-injected values win: they describe the
//  BUILD, which is the question. Render sets RENDER_GIT_COMMIT; the others
//  are the common equivalents elsewhere, listed so a platform change does
//  not silently return us to "unidentified".
const ENV_SOURCES = [
  ["RENDER_GIT_COMMIT", "render_env"],
  ["SOURCE_VERSION", "platform_env"],
  ["GIT_COMMIT", "platform_env"],
  ["COMMIT_SHA", "platform_env"],
  ["VERCEL_GIT_COMMIT_SHA", "platform_env"],
  ["HEROKU_SLUG_COMMIT", "platform_env"],
];

function resolve() {
  for (const [name, kind] of ENV_SOURCES) {
    const v = (process.env[name] || "").trim();
    if (v) return { commit: v, resolved_from: kind, source_variable: name };
  }

  //  A file written at build time, if a build step ever adds one.
  try {
    const p = path.join(__dirname, "..", "..", "BUILD_INFO");
    const raw = fs.readFileSync(p, "utf8").trim();
    if (raw) {
      const m = raw.match(/\b[0-9a-f]{7,40}\b/i);
      return { commit: m ? m[0] : raw.slice(0, 64), resolved_from: "build_file", source_variable: "BUILD_INFO" };
    }
  } catch (_) { /* absent is normal */ }

  //  A git checkout — TRUE ONLY IN LOCAL DEVELOPMENT. Render deploys a
  //  build artifact with no .git, which is exactly why `git rev-parse`
  //  fails there and why this is the LAST resort rather than the first.
  //  Labelled distinctly so a local answer is never mistaken for a
  //  statement about a deployed build.
  try {
    const head = fs.readFileSync(path.join(__dirname, "..", "..", ".git", "HEAD"), "utf8").trim();
    const ref = head.startsWith("ref:") ? head.slice(4).trim() : null;
    const sha = ref
      ? fs.readFileSync(path.join(__dirname, "..", "..", ".git", ref), "utf8").trim()
      : head;
    if (/^[0-9a-f]{40}$/i.test(sha)) {
      return { commit: sha, resolved_from: "local_git_checkout", source_variable: ".git/HEAD", branch: ref ? ref.replace("refs/heads/", "") : null };
    }
  } catch (_) { /* not a checkout */ }

  return { commit: null, resolved_from: "unidentified", source_variable: null };
}

const RESOLVED = resolve();

//  `short` is what a person reads; `commit` is what a machine compares.
const IDENTITY = Object.freeze({
  ...RESOLVED,
  short: RESOLVED.commit ? String(RESOLVED.commit).slice(0, 7) : null,
  //  Process start, not build time — it answers "how long has THIS build
  //  been serving", which is the question you ask next.
  started_at: new Date().toISOString(),
  node_version: process.version,
});

module.exports = { buildIdentity: () => IDENTITY };
