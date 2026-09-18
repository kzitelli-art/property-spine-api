const assert = require("assert");
const ledgerModule = require("../../src/money/commitment_ledger");

const proposal = {
  id: "offer-proposal", source: "application_proposal", status: "sent",
  property_id: "property-1", person_id: "person-1", application_id: "application-1",
  qualifying_action: "application_submitted", expires_at: null,
};
const calls = [];
const q = {
  async query(sql) {
    calls.push(sql);
    if (/where id = \$1 for update/.test(sql) && /lease_offers/.test(sql)) {
      return { rowCount: 1, rows: [proposal] };
    }
    if (/where id = \$1 for update/.test(sql) && /lease_applications/.test(sql)) {
      return { rowCount: 1, rows: [{ id: "application-1", property_id: "property-1" }] };
    }
    if (/where application_id = \$1/.test(sql)) {
      assert.match(sql, /source <> 'application_proposal'/);
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  },
};

(async () => {
  const service = ledgerModule({ pool: q })._service;

  await assert.rejects(
    () => service.qualifyOffer(q, { offer_id: proposal.id, action: "application_submitted" }),
    (e) => e.code === "APPLICATION_PROPOSAL_NOT_LEDGER"
  );

  await assert.rejects(
    () => service.lockLeaseEconomics(q, {
      application_id: proposal.application_id, offer_id: proposal.id,
      locked_by_person_id: "person-2", lines: [{ effective_month: "2026-10-01", amount: 1200, line_type: "base_rent" }],
    }),
    (e) => e.code === "APPLICATION_PROPOSAL_NOT_LEDGER"
  );

  const eligible = await service.findEligibleOfferForApplication(q, proposal.application_id);
  assert.deepEqual(eligible, []);
  console.log("commitment_ledger_application_proposal: PASS");
})().catch((e) => { console.error(e); process.exit(1); });
