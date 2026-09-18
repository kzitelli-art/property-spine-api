"use strict";

// Offline request preparation only. The existing authenticated agent-facts
// writer remains the sole publication/approval mechanism; never writes SQL.
const fs = require('node:fs');
const path = require('node:path');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stage(packet, setName, propertyId, snapshot, now = new Date()) {
  const selected = packet.staging_sets?.[setName];
  if (!selected) throw new Error('Unknown staging set');
  if (!UUID.test(propertyId || '') || snapshot.property_id !== propertyId)
    throw new Error('Target must match the authenticated agent-facts response property_id');
  if (!Array.isArray(snapshot.facts)) throw new Error('Complete agent-facts response required');
  const property = packet.properties.find(p => p.property_name === selected.property_name);
  if (!property) throw new Error('Packet property missing');
  if (!UUID.test(property.canonical_property_id || '') || property.canonical_property_id !== propertyId)
    throw new Error('Packet canonical property does not match target');
  const requests = selected.fact_keys.map(key => {
    const candidates = property.facts.filter(f => f.fact_key === key);
    if (candidates.length !== 1) throw new Error('Selected card must be unique: ' + key);
    const card = candidates[0];
    if (!card.source_refs?.length || card.source_refs.some(ref => !packet.sources[ref]))
      throw new Error('Missing source provenance: ' + key);
    const active = snapshot.facts.filter(f => f.fact_key === key && f.space_id == null && f.status === 'active');
    if (active.length > 1) throw new Error('Ambiguous current writer identity: ' + key);
    const old = active[0];
    if (old && !UUID.test(old.id || '')) throw new Error('Malformed active fact identity: ' + key);
    if (old?.effective_until != null && !Number.isFinite(new Date(old.effective_until).getTime()))
      throw new Error('Invalid effective_until: ' + key);
    if (!Number.isFinite(new Date(now).getTime())) throw new Error('Invalid staging time');
    const expired = old?.effective_until != null && new Date(old.effective_until).getTime() <= new Date(now).getTime();
    const same = old && !expired && old.rendered_text === card.rendered_text && old.source_type === card.source_type;
    const body = { fact_key: key, rendered_text: card.rendered_text, source_type: card.source_type };
    return {
      fact_key: key, action: same ? 'skip_unchanged' : old ? 'replace_requires_publication_review' : 'create_requires_publication_review',
      source_status: card.status,
      provenance: card.source_refs.map(ref => ({ ref, ...packet.sources[ref] })),
      review_notes: card.review_notes || [],
      previous_fact_id: old?.id || null,
      ...(same ? {} : { method: 'POST', path: old ? `/operator/agent-facts/${old.id}/replace` : '/operator/agent-facts', body }),
    };
  });
  return { property_id: propertyId, property_label: property.property_name, physical_address: property.physical_address,
    set: setName, prepared_only: true,
    requirements: ['Verify canonical property identity independently; a matching name is insufficient.',
      'Review the exact wording and dated source. Only the current property-scoped authorized staff session may publish.',
      'Read agent-facts again immediately before execution. A stale replacement must stop on 409; never fall back to create.',
      'The writer records the actual publishing user and confirmation time. Source date is historical evidence, not a fabricated current approval.'],
    requests };
}

module.exports = { stage };
if (require.main === module) {
  try {
    const [setName, propertyId, snapshotFile] = process.argv.slice(2);
    if (!snapshotFile) throw new Error('Usage: node tools/stage_leasing_content.js <set> <verified-property-uuid> <agent-facts-response.json>');
    const packet = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/content/temple/leasing-content.json')));
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile));
    process.stdout.write(JSON.stringify(stage(packet, setName, propertyId, snapshot), null, 2) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
