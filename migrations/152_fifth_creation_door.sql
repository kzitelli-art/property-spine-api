-- ════════════════════════════════════════════════════════════════════
--  152_fifth_creation_door.sql — the door Build 0 did not see
--
--  Build 0 searched `src/` and reported four property-creation doors.
--  `server.js` is 3,000+ lines at the repo ROOT and defines routes; it
--  held a fifth, `POST /properties`, of exactly the same class as the
--  three ungoverned ones — shared key, no actor, no organization, no
--  address identity, no creation record.
--
--  Collapsing it into the canonical service means its creations are
--  recorded like every other door's, and `property_creation_events`
--  CHECKs the source name — so the tag has to be added here rather than
--  in JavaScript alone. Source and schema move together; that is the
--  point of the CHECK.
--
--  ── WHY COLLAPSE AND NOT RETIRE ──────────────────────────────────────
--  Nothing in this repo calls it: the app only GETs /properties, and no
--  test or tool posts to it. But the shared operator key is held OUTSIDE
--  this repository, and source can prove a consumer exists — it cannot
--  prove one does not. Both options break an unknown caller; collapsing
--  breaks it with a 401 that names what is missing and leaves a way
--  forward, where retiring leaves a dead end.
--
--  CLASSIFICATION: Class 1. Additive. No data changes.
-- ════════════════════════════════════════════════════════════════════

alter table property_creation_events
  drop constraint if exists ck_pce_source;

alter table property_creation_events
  add constraint ck_pce_source check (creation_source in
    ('super_admin_wizard','bank_intake','owner_upload','deal_intake',
     --  The fifth. Named for the route rather than a product surface,
     --  because that is what it is: a legacy door, now governed.
     'legacy_properties_route'));
