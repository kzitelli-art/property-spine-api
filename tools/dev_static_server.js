#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   dev_static_server.js — serves the property-spine-app repo for LOCAL
   DOCKER DEV ONLY. NOT the production app host (that is Cloudflare
   Pages / Render, outside this repo).

   Why the rewrite: the app defaults its API base to the deployed origin
   (https://property-spine-api.onrender.com, in index.html #apiBase and
   _apiBase/PRODUCTION_ORIGIN). A local app pointed at production would
   be a local browser driving real deployed data — the wrong place to
   land by default. This server rewrites that one origin string to the
   local API (default http://localhost:3000) in the .html/.js it serves.
   The app repo is untouched, and the app's own localStorage override
   (ps_api_base) still wins over anything served here — clear it if it
   holds the production URL.

   CLASS 2 (temporary scaffolding). Removal condition: the app repo
   gaining a first-class local dev server or an origin configured per
   environment. Delete this file and the compose `app` service with it.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.env.STATIC_ROOT || "");
const PORT = Number(process.env.PORT || 8080);
const FROM = process.env.REWRITE_API_ORIGIN_FROM || "https://property-spine-api.onrender.com";
const TO = process.env.REWRITE_API_ORIGIN_TO || "http://localhost:3000";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".csv": "text/csv; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

// Only file types whose body is text and may carry the API origin.
const REWRITABLE = new Set([".html", ".js", ".mjs"]);

if (!ROOT || !fs.existsSync(ROOT)) {
  console.error(`✗ STATIC_ROOT does not exist: ${JSON.stringify(ROOT)}`);
  console.error("  Mount the property-spine-app checkout at STATIC_ROOT (see docker-compose.yml).");
  process.exit(1);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("dev_static_server: read failed");
      return;
    }
    let body = buf;
    if (REWRITABLE.has(ext)) {
      const text = buf.toString("utf8");
      const hits = text.split(FROM).length - 1;
      if (hits > 0) {
        body = Buffer.from(text.split(FROM).join(TO), "utf8");
        console.log(`  [rewrite] ${path.basename(filePath)}: ${hits} origin(s) -> ${TO}`);
      }
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",   // dev: never let a stale app file masquerade as a change
    });
    res.end(body);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {           // traversal guard — the mount is read-only, but stay correct
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }
  if (urlPath === "/" || urlPath === "") filePath = path.join(ROOT, "index.html");
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`not found: ${urlPath}`);
      return;
    }
    serveFile(res, filePath);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dev-static] serving ${ROOT}`);
  console.log(`[dev-static] listening on :${PORT} — API origin rewritten to ${TO}`);
});
