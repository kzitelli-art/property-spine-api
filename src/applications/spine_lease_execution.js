// ════════════════════════════════════════════════════════════════════
//  spine_lease_execution.js — SPINE'S OWN EXECUTED INSTRUMENT, INTO THE
//  CANONICAL EXECUTED-LEASE SERVICE.
//
//  ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────
//  It is an ADAPTER. It is not an executed-lease service, not a tenancy
//  writer, and not a second execution architecture. Both owners are
//  already settled and neither is reopened here:
//
//      executed_lease_service.verifyExecutedLease   the ONE canonical
//                                                   executed-lease record
//                                                   + admission engine
//      tenancy_anchor_service.confirmTermService    the ONE canonical
//                                                   tenancy-anchor writer
//
//  088 already said an in-product signing system would land in that exact
//  service. This is that landing, and nothing more.
//
//  ── THE ONE THING THAT STOPPED IT ───────────────────────────────────
//  `verifyExecutedLease` requires `verified_by_user_id` because
//  "Verification is an attested act by a real staff user." That is right
//  when Spine RECEIVES an outside lease. It is wrong when Spine watched
//  the resident and the company sign the exact instrument it holds:
//  there is nothing left to attest to, and asking a second human to
//  attest to what Spine just witnessed is precisely the "verify what I
//  just signed" ceremony the product is removing.
//
//  So the requirement is SATISFIED HONESTLY rather than faked. For the
//  in-Spine path the verifier IS the authorised company signer — a real
//  person who performed the consequential act — and migration 185 records
//  `verification_basis = 'spine_instrument'` so the two acts can never be
//  read as the same claim.
//
//  ── THE BROWSER SUPPLIES ALMOST NOTHING ─────────────────────────────
//      lease_packet_id                the packet that was executed
//      company_signer_user_id         SERVER-DERIVED from the session
//
//  Everything else is re-read here: the application, the property, the
//  exact space, the governing economics, the instrument identity and
//  hash, both sides' signer evidence, and both execution timestamps. Rent,
//  deposit, bed, dates and signer names are NOT accepted from the caller
//  at this point — Spine already knows them, and re-accepting them would
//  let a browser restate governed truth at the last moment, which is the
//  one place it must not.
//
//  ── ONE SIGNED INSTRUMENT, ONE IDENTITY, ONE RECORD ─────────────────
//      executed_lease_records.document_sha256 = lease_packets.instrument_body_sha256
//
//  Asserted here and enforced by migration 185's check constraint. A
//  signature is a signature ON something; if those two ever disagree, the
//  record describes a document nobody signed.
//
//  ── THE OPERATOR EXPERIENCES ONE ACT ────────────────────────────────
//  Company signs. Internally that still travels
//  executed → admitted → accepted_term_required → confirmTermService →
//  pending lease anchor, and that is fine: internal architecture may have
//  intermediate states. What it may not have is a second human click. On
//  a clean admission this invokes the canonical confirmTermService in the
//  same governed workflow.
//
//  ── A CONFLICT PRESERVES WHAT WAS SIGNED ────────────────────────────
//  The admission engine already gets this right and is not touched: the
//  executed record persists even when activation is blocked. A blocked
//  signed lease stays recorded and names the conflict. This adapter
//  reports that verdict; it never erases evidence to make a state tidy.
//
//  CLASS 1 — permanent product primitive.
//  TRANSACTION: the CALLER owns begin/commit, matching every service this
//  file composes. Nothing here commits.
// ════════════════════════════════════════════════════════════════════
"use strict";

function svcErr(http, body) {
  const e = new Error(body && body.receipt ? body.receipt : "refused");
  e.svc = true; e.http = http; e.body = body;
  return e;
}

/**
 * Execute a fully-signed Spine lease packet into canonical truth.
 *
 * @param client                 an OPEN transaction client. Required.
 * @param lease_packet_id        the packet both parties executed.
 * @param company_signer_user_id SERVER-DERIVED authenticated staff user who
 *                               performed the company signature.
 * @param deps                   { executedLease, confirmTerm } — the canonical
 *                               services, injected so this file owns neither.
 */
async function executeSpineLease(client, { lease_packet_id, company_signer_user_id } = {}, deps = {}) {
  if (!client || typeof client.query !== "function") {
    throw new TypeError("executeSpineLease requires the caller's open transaction client");
  }
  if (!lease_packet_id) throw svcErr(400, { receipt: "lease_packet_id is required." });
  if (!company_signer_user_id) {
    throw svcErr(400, {
      receipt: "The company signer is server-derived from the authenticated session and is required.",
      error: "company_signer_required",
    });
  }
  const executedLease = deps.executedLease;
  const confirmTerm = deps.confirmTerm;
  if (!executedLease || typeof executedLease.verifyExecutedLease !== "function") {
    throw svcErr(503, { receipt: "Executed-lease service is not wired on this deploy." });
  }

  // ── THE PACKET, LOCKED ────────────────────────────────────────────
  const pkt = (await client.query(
    "select * from lease_packets where id=$1 for update", [lease_packet_id]
  )).rows[0];
  if (!pkt) throw svcErr(404, { receipt: "No lease packet with that id." });

  //  The packet must actually be executed. This adapter records what
  //  happened; it never performs the signing, and it must never be the
  //  thing that advances a packet into an executed state.
  if (pkt.status !== "executed") {
    throw svcErr(409, {
      error: "packet_not_executed",
      receipt: `This lease packet is '${pkt.status}'. Both the resident and the authorised `
             + "company signer must have executed it before it becomes canonical truth.",
    });
  }
  if (pkt.is_placeholder) {
    //  Belt and braces: migration 184's trigger already refuses to execute a
    //  placeholder, so this is unreachable through the governed path. It is
    //  kept because a repair script or a future writer could set the status
    //  directly, and a placeholder reaching canonical truth is the one
    //  outcome this whole rail exists to prevent.
    throw svcErr(409, {
      error: "packet_is_placeholder",
      receipt: "This packet has no governing instrument and cannot become an executed lease.",
    });
  }
  if (!pkt.instrument_body_sha256) {
    throw svcErr(409, {
      error: "instrument_identity_missing",
      receipt: "This packet carries no instrument hash, so there is no document the signatures are on.",
    });
  }
  if (pkt.voided_at) {
    throw svcErr(409, { error: "packet_voided", receipt: "This lease packet was voided." });
  }

  // ── SIGNER EVIDENCE — READ, NEVER SUPPLIED ────────────────────────
  //  Both sides' evidence comes from the packet's own completed signature
  //  fields (034's mechanism, widened by 184 to admit a company role).
  const sigs = (await client.query(
    `select f.signer_role, f.completed, f.completed_at, f.signed_by_user_id, f.signed_by_person_id,
            f.session_id, f.ip_address, f.user_agent, f.clause_hash,
            p.name person_name, u.name user_name
       from lease_packet_fields f
       left join persons p on p.id = f.signed_by_person_id
       left join users   u on u.id = f.signed_by_user_id
      where f.lease_packet_id = $1 and f.field_type = 'signature' and f.completed = true
      order by f.completed_at`, [lease_packet_id]
  )).rows;

  const residentSigs = sigs.filter((s) => s.signer_role === "tenant" || s.signer_role === "guarantor");
  const companySigs = sigs.filter((s) => s.signer_role === "company");
  if (!residentSigs.length) {
    throw svcErr(409, { error: "resident_signature_missing",
      receipt: "The packet records no completed resident signature." });
  }
  if (!companySigs.length) {
    throw svcErr(409, { error: "company_signature_missing",
      receipt: "The packet records no completed company signature." });
  }

  //  THE SIGNER OF RECORD MUST BE THE SESSION PERFORMING THIS. Otherwise a
  //  staff user could land somebody else's signature as canonical truth.
  const signedByThisUser = companySigs.some(
    (s) => String(s.signed_by_user_id) === String(company_signer_user_id));
  if (!signedByThisUser) {
    throw svcErr(403, {
      error: "company_signer_mismatch",
      receipt: "The company signature on this packet was made by a different user. "
             + "Execution is recorded by the person who signed it.",
    });
  }

  //  THE SERVICE'S OWN SIGNER SHAPE: `{ name, capacity }` at minimum —
  //  "record each signer's name and legal capacity". Capacity is the legal
  //  role a person signed IN, which is why it is not the same word as the
  //  packet's `signer_role`; the mapping is stated here rather than assumed
  //  to be identical.
  const CAPACITY = { tenant: "resident", guarantor: "guarantor", company: "landlord_representative" };
  const named = (s, who) => {
    if (!who) {
      //  A signature with no identifiable signer cannot become canonical
      //  truth. The packet captured WHO signed (184); if that is missing the
      //  evidence is incomplete, and a placeholder name would be an invention
      //  on an instrument somebody actually signed.
      throw svcErr(409, {
        error: "signer_identity_missing",
        receipt: `A completed ${s.signer_role} signature on this packet names no signer, `
               + "so the executed lease cannot record who signed it.",
      });
    }
    return who;
  };
  const signers = [
    ...residentSigs.map((s) => ({
      name: named(s, s.person_name),
      capacity: CAPACITY[s.signer_role] || s.signer_role,
      role: s.signer_role,
      person_id: s.signed_by_person_id || null,
      signed_at: s.completed_at,
      session_id: s.session_id || null,
      ip_address: s.ip_address || null,
      user_agent: s.user_agent || null,
    })),
    ...companySigs.map((s) => ({
      name: named(s, s.user_name),
      capacity: CAPACITY.company,
      role: "company",
      user_id: s.signed_by_user_id || null,
      signed_at: s.completed_at,
      session_id: s.session_id || null,
      ip_address: s.ip_address || null,
      user_agent: s.user_agent || null,
    })),
  ];

  // ── GOVERNING TERMS — FROM THE PACKET'S OWN SNAPSHOT ──────────────
  //  terms_json is what the instrument was rendered FROM, so it is what the
  //  parties signed. Reading economics from anywhere else now — live
  //  pricing, the application, a request body — would record terms nobody
  //  put their name to.
  const terms = pkt.terms_json || {};
  const need = (k) => {
    const v = terms[k];
    if (v === undefined || v === null || v === "") {
      throw svcErr(409, {
        error: "governing_term_missing",
        receipt: `The executed instrument's snapshot does not carry ${k}, so it cannot become `
               + "canonical truth. The signed terms are the only source for this.",
      });
    }
    return v;
  };

  // ── INTO THE ONE CANONICAL SERVICE ────────────────────────────────
  const verified = await executedLease.verifyExecutedLease(client, {
    application_id: pkt.application_id,
    //  The bed travels from the packet, which took it from the application
    //  (182). It is never re-asserted by a browser at execution time.
    space_id: need("space_id"),
    rent: need("rent"),
    security_deposit: terms.security_deposit == null ? null : terms.security_deposit,
    lease_start_date: need("lease_start_date"),
    lease_end_date: need("lease_end_date"),
    concession_status: terms.concession_status || "none",
    //  ONE SIGNED INSTRUMENT, ONE IDENTITY. This is the assertion the whole
    //  adapter exists to make, and 185 enforces it in the schema too.
    document_sha256: pkt.instrument_body_sha256,
    document_reference: pkt.instrument_form_code || null,
    document_version: pkt.version,
    executed_at: pkt.company_executed_at,
    signers,
    execution_channel: "spine_esign",
    //  A REAL PERSON WHO DID A REAL THING — the company signer, not an
    //  invented attestor. 185's verification_basis says which act it was.
    verified_by_user_id: company_signer_user_id,
    verification_basis: "spine_instrument",
    source_lease_packet_id: lease_packet_id,
    //  One execution per packet, so a replay converges instead of duplicating.
    idempotency_key: `spine_packet:${lease_packet_id}`,
  }, deps);

  // ── ADMITTED → THE TENANCY, IN THE SAME WORKFLOW ──────────────────
  //  The company signature was the human decision. Asking that person to
  //  then click "confirm term" is the ceremony being removed. On a clean
  //  admission the canonical writer is invoked here — the SAME service, not
  //  a copy of it, and it re-derives everything from live sources itself.
  let tenancy = null;
  let tenancy_error = null;
  if (verified.activation_status === "admitted" && confirmTerm) {
    try {
      const signerName = companySigs[0].user_name || "the authorised company signer";
      tenancy = await confirmTerm(client, {
        applicationId: pkt.application_id,
        confirmed_by: signerName,
        confirmed_by_user_id: company_signer_user_id,
      });
    } catch (e) {
      //  A tenancy refusal does NOT unmake the execution. The lease was
      //  signed; that is a fact about the world. Reporting it honestly beats
      //  rolling back evidence to keep the workflow tidy — and the caller
      //  owns the transaction, so it decides what to commit.
      if (e && e.svc) tenancy_error = e.body;
      else throw e;
    }
  }

  return {
    lease_packet_id,
    application_id: pkt.application_id,
    verification_basis: "spine_instrument",
    execution_channel: "spine_esign",
    instrument_body_sha256: pkt.instrument_body_sha256,
    executed_lease_record_id: verified.record_id,
    idempotent: !!verified.idempotent,
    activation_status: verified.activation_status,
    blockers: verified.blockers || [],
    //  Present only on a clean admission. Absent means blocked, and the
    //  blockers say why — never an empty success.
    tenancy: tenancy ? {
      lease_id: tenancy.lease_id,
      lease_status: tenancy.lease_status,
      economics_conflict: tenancy.economics_conflict || null,
    } : null,
    tenancy_error,
    receipt: verified.activation_status === "admitted"
      ? (tenancy
          ? `Lease executed and tenancy created — pending lease ${tenancy.lease_id}.`
          : `Lease executed and admitted; the tenancy anchor did not complete. ${tenancy_error ? tenancy_error.receipt : ""}`)
      : "Lease executed and recorded. Activation is blocked — the executed lease stands and the conflict is named.",
  };
}

module.exports = { executeSpineLease };
