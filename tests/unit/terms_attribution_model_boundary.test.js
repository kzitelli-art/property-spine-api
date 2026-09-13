"use strict";
const assert = require("node:assert/strict");
const { gatherFacts } = require("../../src/agent/ask_spine_answer");
const id = "11111111-2222-4333-8444-555555555555";

(async () => {
  for (const source of ["operator_proposed_terms", "authored_offer_acknowledged"]) {
    const derived = source === "authored_offer_acknowledged";
    const confirmation = {
      id, source, confirmed_by: derived ? null : id,
      confirmed_at: derived ? null : "2026-09-13T00:00:00Z",
      prepared_by: derived ? id : null,
      prepared_at: derived ? "2026-09-13T01:00:00Z" : null,
      application_offer_id: id, application_terms_hash: "private-hash",
      offer_author: { user_id: id, authored_at: "2026-09-12T00:00:00Z", authority: {
        via: "application_proposal", basis: "managed_role_override", actor_user_id: id,
        acting_person_id: id, property_id: id, source_comm_event_ids: [id],
        supersedes_application_offer_id: id, idempotency_key: "private-request-identity",
      } },
    };
    const retained = structuredClone(confirmation);
    const facts = await gatherFacts({ query() { throw Error("unexpected DB read"); } }, {
      property_id: id, allowed_modules: ["leasing"], subject: "leasing_person", question: "Has Taylor signed?",
      leasingReader: {
        resolveLeasingSubject: async () => ({ resolved: true, person: { id, name: "Taylor" } }),
        readLeasingStanding: async () => ({ application: { proposed_terms_confirmation: confirmation } }),
      },
    });
    assert.equal(facts.leasing_person.read_state, "OK");
    const projected = facts.leasing_person.application.proposed_terms_confirmation;
    const wire = JSON.stringify(projected);
    assert.ok(!wire.includes(id), `${source}: database actor/event ids must not reach model facts`);
    assert.ok(!wire.includes("private-request-identity") && !wire.includes("private-hash"));
    assert.equal(projected.source, source);
    assert.equal(projected.confirmed_at, confirmation.confirmed_at);
    assert.equal(projected.prepared_at, confirmation.prepared_at);
    assert.equal(projected.offer_author.authored_at, confirmation.offer_author.authored_at);
    assert.equal(projected.offer_author.authority.basis, "managed_role_override");
    assert.deepEqual(confirmation, retained, "entitled canonical provenance is unchanged");
  }
  console.log("terms attribution model boundary: PASS (derived and legacy)");
})().catch(error => { console.error(error); process.exitCode = 1; });
