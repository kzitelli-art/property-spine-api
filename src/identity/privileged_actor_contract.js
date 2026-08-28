// ════════════════════════════════════════════════════════════════════
//  privileged_actor_contract.js — WHO MAY CLAIM TO BE WHOM
//
//  The permanent contract for privileged services. commitment_ledger.js takes
//  `published_by_person_id`, `granted_by_person_id` and `spoken_by_person_id`
//  FROM ITS CALLER. Today that is unreachable from a browser session — the
//  routes sit behind the operator-key gate, every table is empty, and no
//  route supplies a session actor — so it is a latent defect, not a live one.
//  It must be closed BEFORE real publication, and closed deliberately rather
//  than by editing a working publish path blind.
//
//  ── THE CONTRACT ─────────────────────────────────────────────────────
//   1. A session-facing caller supplies user_id ONLY. Never a person id.
//   2. The server resolves the actor through resolveActorContext.
//   3. A privileged service receives a RESOLVED ACTOR OBJECT — a sealed
//      token proving resolution happened — never a bare person id.
//   4. A non-session system action names an explicit SYSTEM ACTOR with its
//      own authority basis. "The system did it" is an answer; an absent
//      actor is not.
//   5. No caller may supply the authoritative acting person.
//
//  ── WHY A SEALED OBJECT AND NOT A CONVENTION ─────────────────────────
//  A rule saying "pass the resolved person id" is satisfied by passing ANY
//  person id, because both are just uuids — the wrong one type-checks
//  perfectly. Making the accepted type unforgeable moves the guarantee from
//  reviewer diligence into the call signature: a caller cannot fabricate an
//  actor without calling the resolver, and the resolver reads the session.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { resolveActorContext } = require("./actor_context");

// A REGISTRY, not a property. The first version used a symbol key, and the
// harness caught the flaw: object spread COPIES symbol-keyed own enumerable
// properties, so `{ ...realActor, acting_person_id: someoneElse }` produced a
// forged actor that passed the guard. Identity would have been mutable by one
// spread. A WeakSet cannot be copied into — membership is the object itself.
const RESOLVED = new WeakSet();

/** Freeze and register. Membership travels with the OBJECT, never its shape. */
function seal(obj) { const o = Object.freeze(obj); RESOLVED.add(o); return o; }

const SYSTEM_ACTORS = {
  scheduled_job: { basis: "system:scheduled_job", description: "Recurring server-side task." },
  migration: { basis: "system:migration", description: "Schema or data migration." },
  seed: { basis: "system:seed", description: "QA or demo seeding, never a production decision." },
  inbound_webhook: { basis: "system:inbound_webhook", description: "Provider callback with no human." },
};

/**
 * The ONLY way to mint an actor from a session. Reads the session's user and
 * property; a request body cannot reach this function.
 */
async function actorFromSession(pool, { user_id, property_id, verb }) {
  const ctx = await resolveActorContext(pool, { user_id, property_id });
  if (!ctx.ok) {
    const e = new Error(`actor unresolved: ${ctx.failure_reason}`);
    e.code = ctx.failure_reason; e.httpStatus = 403; e.publicMessage = e.message;
    throw e;
  }
  if (verb && !ctx.capabilities[verb]) {
    const e = new Error(`actor lacks ${verb} on this property`);
    e.code = "not_authorized"; e.httpStatus = 403; e.publicMessage = e.message;
    throw e;
  }
  return seal({
    kind: "human",
    session_user_id: ctx.user.user_id,
    acting_person_id: ctx.person.person_id,
    display_name: ctx.person.display_name,
    property_id: ctx.property_id,
    verb: verb || null,
    authority_basis: verb ? ctx.basis[verb] : null,
    link_status: ctx.link_status,
  });
}

/**
 * A non-session action must still name an actor. It cannot borrow a human's.
 */
function systemActor(kind, { property_id = null, note = null } = {}) {
  const spec = SYSTEM_ACTORS[kind];
  if (!spec) throw new Error(`unknown system actor '${kind}'`);
  return seal({
    kind: "system",
    session_user_id: null,
    acting_person_id: null,          // a system action has no human, and says so
    system_actor: kind,
    property_id,
    authority_basis: spec.basis,
    note,
  });
}

/** True only for an object minted above. A plain object cannot pass. */
function isResolvedActor(a) {
  return !!(a && typeof a === "object" && RESOLVED.has(a));
}

/**
 * Guard for privileged services. Refuses a bare id, a plain object, or a
 * hand-built impostor.
 */
function requireResolvedActor(actor, verb) {
  if (typeof actor === "string") {
    const e = new Error("a privileged service received a bare person id. Pass a resolved actor.");
    e.code = "bare_person_id_supplied"; e.httpStatus = 400; e.publicMessage = e.message;
    throw e;
  }
  if (!isResolvedActor(actor)) {
    const e = new Error("actor was not produced by actorFromSession or systemActor.");
    e.code = "unresolved_actor"; e.httpStatus = 400; e.publicMessage = e.message;
    throw e;
  }
  if (verb && actor.kind === "human" && actor.verb !== verb) {
    const e = new Error(`actor was resolved for '${actor.verb}', not '${verb}'.`);
    e.code = "actor_verb_mismatch"; e.httpStatus = 403; e.publicMessage = e.message;
    throw e;
  }
  return actor;
}

/** The attribution block a privileged receipt must carry. */
function actorAttribution(actor) {
  requireResolvedActor(actor);
  return {
    kind: actor.kind,
    session_user_id: actor.session_user_id,
    acting_person_id: actor.acting_person_id,
    system_actor: actor.system_actor || null,
    property_id: actor.property_id,
    authority_basis: actor.authority_basis,
  };
}

// ── the migration plan for commitment_ledger.js ──────────────────────
// Recorded here rather than in a document so it travels with the contract.
const LEDGER_MIGRATION = {
  target: "src/money/commitment_ledger.js",
  current_shape: "publishPricingVersion(spec) reads spec.published_by_person_id; " +
    "recordConcessionIncident reads spec.spoken_by_person_id; " +
    "grantOffer reads spec.granted_by_person_id.",
  risk_today: "LATENT, not live. All routes sit behind the x-operator-key gate, every ledger table " +
    "has 0 rows, and no route supplies a session actor. Nothing browser-reachable can exercise it.",
  required_change: [
    "Each entry point accepts `actor` and calls requireResolvedActor(actor, verb).",
    "published_by_person_id is READ FROM the actor, never from the spec.",
    "Route boundaries call actorFromSession(pool, { user_id: req.operator.id, property_id: req.operator.property_id, verb }).",
    "Seeds and migrations pass systemActor('seed'|'migration') and are recorded as system actions.",
    "canPublish keeps its own check — the actor proves WHO, the ledger still proves MAY.",
  ],
  sequencing: "Must land BEFORE a real publication and AFTER ownership names the publisher, so the " +
    "change is exercised by the rehearsal rather than by a first live publish.",
};

module.exports = {
  actorFromSession, systemActor, isResolvedActor, requireResolvedActor,
  actorAttribution, SYSTEM_ACTORS, LEDGER_MIGRATION,
};
