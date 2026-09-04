'use strict';
// ════════════════════════════════════════════════════════════════════
//  SCHEDULING ADAPTER SEAM — scheduling_adapter_seam.js
//
//  The ONE translation point between the Outlook/Acuity adapter and the
//  canonical scheduling service (leasing_scheduling.js, migration 048).
//
//  The adapter (outlook_acuity_sync.js) reads Graph mail and produces a raw
//  ENVELOPE in ITS shape: { source_event_type, external_appointment_id,
//  parsed{...} | occurrences[], idempotency_fingerprint, raw_payload, ... }.
//  The canonical service expects { event_type, occurrences[]:{...} }.
//
//  This seam does the field/shape translation and nothing else. It NEVER
//  writes scheduled_tours directly — 048 owns canonical projection. It only
//  calls the service's ingestSourceEvent inside a transaction.
//
//  Mount wrapper calls:  ingestSchedulingSourceEvent({ pool, envelope, context, logger })
// ════════════════════════════════════════════════════════════════════

const buildSchedulingModule = require('../leasing/leasing_scheduling');

// Map the adapter's source_event_type → the canonical service's event_type.
const EVENT_TYPE_MAP = {
  appointment_created: 'created',
  appointment_rescheduled: 'rescheduled',
  appointment_cancelled: 'cancelled',
  agenda_digest: 'agenda_digest',
  unknown: null, // unknown → not ingested as a scheduling event
};

// Map the adapter's appointment_type hints → canonical values.
function normalizeApptType(t) {
  if (!t) return null;
  const v = String(t).toLowerCase();
  if (v.includes('person')) return 'in_person';
  if (v.includes('facetime') || v.includes('video') || v.includes('virtual')) return 'facetime';
  return 'other';
}

// Translate ONE adapter occurrence/parsed-hint into a canonical occurrence.
// `propertyLabel` is a HINT only — never used to silently guess a mapping; it is
// passed as calendar_label/appointment_name match input that the configurable
// mapping layer resolves (or leaves unresolved, which the service records).
function toCanonicalOccurrence(occ, envelope) {
  return {
    external_appt_id: occ.external_appointment_id || occ.external_appt_id || null,
    // property resolution: pass hints to the mapping layer, do NOT set property_id.
    calendar_label: occ.property_label || occ.calendar_label || null,
    appointment_name: occ.appointment_name || null,
    sender: envelope?.raw_payload?.sender || null,
    recipient_mailbox: (envelope?.raw_payload?.to_recipients || [])[0] || null,
    prospect_name: occ.prospect_name || null,
    prospect_phone: occ.prospect_phone || null,
    prospect_email: occ.prospect_email || null,
    appointment_type: normalizeApptType(occ.appointment_type),
    scheduled_start: occ.scheduled_start || null,
    scheduled_end: occ.scheduled_end || null,
    scheduled_host_user_id: null, // adapter never assigns a host (boundary)
    source_status: occ.source_status || null,
  };
}

// Build the canonical envelope the service expects from the adapter envelope.
function translateEnvelope(envelope) {
  const event_type = EVENT_TYPE_MAP[envelope.source_event_type];
  if (!event_type) {
    return { event_type: null }; // unknown → caller marks unmapped, no ingest
  }

  // The adapter may give either a single `parsed` hint OR an `occurrences` array
  // (the extended digest parser produces the latter). Normalize to occurrences.
  let occList;
  if (Array.isArray(envelope.occurrences) && envelope.occurrences.length > 0) {
    occList = envelope.occurrences;
  } else if (envelope.parsed) {
    // single occurrence: fold the envelope-level appointment id in.
    occList = [{ ...envelope.parsed, external_appointment_id: envelope.parsed.external_appointment_id || envelope.external_appointment_id }];
  } else {
    occList = [{ external_appointment_id: envelope.external_appointment_id }];
  }

  return {
    source_system: envelope.source_system || 'acuity_squarespace',
    ingestion_channel: envelope.ingestion_channel || 'outlook_graph',
    // the envelope's own identity is the idempotency key the service prefers
    source_event_id: envelope.source_event_id || envelope.idempotency_fingerprint || null,
    event_type,
    sender: envelope?.raw_payload?.sender || null,
    recipient_mailbox: (envelope?.raw_payload?.to_recipients || [])[0] || null,
    raw_payload: envelope.raw_payload || null,
    source_received_at: envelope.source_received_at || null,
    occurrences: occList.map((o) => toCanonicalOccurrence(o, envelope)),
  };
}

// A cached service instance per pool (the module is a factory).
const _serviceByPool = new WeakMap();
function serviceFor(pool) {
  let svc = _serviceByPool.get(pool);
  if (!svc) { svc = buildSchedulingModule({ pool })._service; _serviceByPool.set(pool, svc); }
  return svc;
}

/**
 * The seam the mount wrapper calls.
 * @returns {Promise<{status:string, forwarded:boolean, result?:object}>}
 *   status: 'ingested' | 'unmapped' (unknown event type) | 'unresolved_property'
 */
async function ingestSchedulingSourceEvent({ pool, envelope, context, logger = console }) {
  const canonical = translateEnvelope(envelope);
  if (!canonical.event_type) {
    return { status: 'unmapped', forwarded: false };
  }

  const svc = serviceFor(pool);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await svc.ingestSourceEvent(client, canonical);
    await client.query('commit');

    // Surface unresolved-property so the adapter's run counters can flag it.
    const anyUnresolved = (result.results || []).some((r) => r.unresolved_property);
    return {
      status: anyUnresolved ? 'unresolved_property' : 'ingested',
      forwarded: true,
      duplicate: result.duplicate || false,
      occurrences: (result.results || []).length,
      result,
    };
  } catch (err) {
    await client.query('rollback');
    if (logger && logger.error) logger.error('[scheduling-seam] ingest failed', { message: err.message });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ingestSchedulingSourceEvent, translateEnvelope, toCanonicalOccurrence, normalizeApptType };
