"use strict";
const assert = require("node:assert/strict");
const {
  readCurrentTermsConfirmation,
} = require("../../src/applications/proposed_terms_service");

(async () => {
  const app = {
    id: "application",
    property_id: "property",
    proposed_terms_confirmation_id: "current",
  };
  const queries = [];
  let row = {
    id: "current",
    source: "authored_offer_acknowledged",
    actor_user_id: "preparer",
    created_at: "prepared-time",
    application_offer_id: "offer",
    application_terms_hash: "hash",
    offer_authored_at: "author-time",
    offer_authority: {
      actor_user_id: "author",
      basis: "pricing-grant",
      property_id: "property",
    },
  };
  const db = {
    query: async (sql, args) => {
      queries.push({ sql, args });
      return { rows: row ? [row] : [] };
    },
  };
  assert.equal(
    typeof readCurrentTermsConfirmation,
    "function",
    "current confirmation read must preserve distinct derived attribution",
  );
  const derived = await readCurrentTermsConfirmation(db, app);
  assert.equal(derived.confirmed_by, null);
  assert.equal(derived.confirmed_at, null);
  assert.equal(derived.prepared_by, "preparer");
  assert.equal(derived.prepared_at, "prepared-time");
  assert.equal(derived.offer_author.user_id, "author");
  assert.equal(derived.offer_author.authored_at, "author-time");
  assert.deepEqual(derived.offer_author.authority, row.offer_authority);
  assert.deepEqual(queries[0].args, [
    "current",
    "application",
    "property",
    null,
    null,
  ]);
  assert.doesNotMatch(queries[0].sql, /order by.*created_at|for update/i);
  row = { ...row, source: "operator_proposed_terms" };
  const legacy = await readCurrentTermsConfirmation(db, app);
  assert.equal(legacy.confirmed_by, "preparer");
  assert.equal(legacy.confirmed_at, "prepared-time");
  assert.equal(legacy.prepared_by, null);
  row = {
    ...row,
    source: "authored_offer_acknowledged",
    offer_authority: null,
  };
  assert.equal(
    (await readCurrentTermsConfirmation(db, app)).offer_author,
    null,
    "missing authorship stays unknown",
  );
  row = null;
  await assert.rejects(
    () => readCurrentTermsConfirmation(db, app),
    /current terms record/,
  );
  assert.equal(
    await readCurrentTermsConfirmation(db, {
      ...app,
      proposed_terms_confirmation_id: null,
    }),
    null,
  );
  console.log("terms confirmation attribution: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
