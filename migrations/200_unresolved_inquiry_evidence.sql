-- ════════════════════════════════════════════════════════════════════
-- 200 · UNRESOLVED INQUIRY EVIDENCE
--
-- WHY THIS EXISTS. When /leasing/intake cannot tell which person an
-- inquiry belongs to, it refuses to attach it — correctly. But the refusal
-- throws inside the intake transaction, so the rollback that protects the
-- person card also discarded the inquiry. A prospect who wrote to us
-- simply vanished. An alert that something was lost is not preservation of
-- what was lost.
--
-- The comms boundary already solved this shape for an ambiguous SMS
-- sender: `insert into comm_events ... person_id null, classification
-- 'unknown', needs_human true` — "an ambiguous SENDER still has a known
-- property, so the claim is preserved on that property's ledger for a
-- human" (communications_boundary.js). The web intake door was the one
-- losing it. This migration lets that SAME record carry the one thing a
-- web inquiry has and an SMS does not.
--
-- WHY A COLUMN AT ALL. For SMS the sender's number is recoverable from the
-- provider through `sms_sid`. A web inquiry has no provider: the submitted
-- phone, email and source exist only in the request body. All 44 existing
-- comm_events columns were checked against the live catalog, and every
-- property-scoped table carrying a phone/email column (scheduled_tours,
-- tour_booking_links, team_invites, work_orders, bids) models a different
-- object. There is no existing home for it. `obligations.required_inputs`
-- is text[] — input NAMES, not values, and not a place for a person's
-- contact details.
--
-- WHY IT CANNOT BECOME A BAG. The CHECK confines this column to exactly
-- the case it was added for: an inbound record attached to NO person and
-- flagged for a human. It is structurally impossible to hang it on an
-- attributed message, so it cannot quietly become a second person record
-- or a parallel identity store.
--
-- Additive. No existing row is changed and no column is dropped.
-- ════════════════════════════════════════════════════════════════════

alter table comm_events add column if not exists unresolved_inquiry jsonb;

comment on column comm_events.unresolved_inquiry is
  'Evidence for an inbound inquiry Spine could not attribute to one person: '
  'the contact details as SUBMITTED, the source, and which identity key '
  'conflicted. Only ever set when person_id is null and needs_human is true.';

-- NOT VALID, then VALIDATE. `ADD CONSTRAINT ... CHECK` normally scans the
-- whole table under ACCESS EXCLUSIVE to prove existing rows comply, and
-- comm_events is the busiest table in the system — every message ever sent or
-- received. NOT VALID takes the lock only long enough to record the
-- constraint; VALIDATE then does the scan under SHARE UPDATE EXCLUSIVE, which
-- does not block reads or writes. Every existing row has a NULL
-- unresolved_inquiry, so the scan finds nothing, but the lock it would have
-- taken is real. The constraint is fully enforced for new and updated rows
-- from the moment it is added, NOT VALID or not.
alter table comm_events drop constraint if exists ck_comm_unresolved_inquiry_scope;
alter table comm_events add constraint ck_comm_unresolved_inquiry_scope
  check (unresolved_inquiry is null
         or (person_id is null and needs_human = true and direction = 'inbound'))
  not valid;
alter table comm_events validate constraint ck_comm_unresolved_inquiry_scope;

-- The operator read: find the retained inquiries for a property. Partial, so
-- it costs nothing on the ordinary attributed-message path.
create index if not exists idx_comm_events_unresolved_inquiry
  on comm_events (property_id, occurred_at desc)
  where unresolved_inquiry is not null;
