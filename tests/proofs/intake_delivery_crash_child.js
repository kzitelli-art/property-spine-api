"use strict";
// Class 3: isolated process-death control. Executes the existing authenticated
// route handlers without opening another listener. Dies immediately after the
// canonical capture COMMIT resolves, before response generation can begin.
const boundary = require('../e2e/proof_boundary');
require('../e2e/proof_fence_preload');
const { Pool } = require('pg');
(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const connect = pool.connect.bind(pool);
  pool.connect = function (...args) {
    if (args.length) return connect(...args);
    return connect().then(client => {
      const query = client.query.bind(client);
      let captured = false;
      client.query = function (sql, ...params) {
        if (typeof sql === 'string' && /insert into lead_events/.test(sql) && params[0]?.[1] === 'lead_received') captured = true;
        const result = query(sql, ...params);
        if (captured && typeof sql === 'string' && sql.trim().toLowerCase() === 'commit')
          return result.then(() => process.exit(86));
        return result;
      };
      return client;
    });
  };
  const sms = { sendSms: async () => { throw new Error('Crash control must not reach transport'); } };
  const commBoundary = require('../../src/comms/communications_boundary')({ pool, sms });
  const router = require('../../src/leasing/leasing_leads')({ pool, sms, commBoundary });
  const route = router.stack.find(layer => layer.route?.path === '/leasing/intake').route;
  const input = JSON.parse(process.env.E2E_INTAKE_CRASH_INPUT);
  const req = { body: input.body, headers: { 'x-intake-secret': 'e2e-intake' }, get: name => name === 'Idempotency-Key' ? input.key : undefined };
  const res = { status() { return this; }, json(value) { console.error('Expected process death, got response', value); process.exit(1); } };
  route.stack[0].handle(req, res, () => route.stack[1].handle(req, res));
})().catch(error => { console.error(error); process.exit(1); });
