"use strict";
// Class 3: run the received notice challenges inside the existing owned
// database/server boundary. No default URL or external provider is allowed.
const boundary = require('../e2e/proof_boundary');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
(async () => {
  await boundary.assertDatabase();
  const owned = boundary.manifest(false);
  if (!process.env.E2E_API_BASE) throw Error('Owned API base required');
  let failed = false;
  for (const name of ['notice_space_grain_http', 'notice_concurrency_challenge']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, `${name}.db.js`)], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, HARNESS_DATABASE_URL: owned.url,
        BASE: process.env.E2E_API_BASE, OPERATOR_KEY: 'e2e-key' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
