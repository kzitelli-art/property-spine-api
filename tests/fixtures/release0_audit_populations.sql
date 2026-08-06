-- ════════════════════════════════════════════════════════════════════
--  Release 0 audit — the edge populations the queries must distinguish.
--
--  Every id is FIXED, not generated, so the audit's output is stable and
--  a run can be diffed against the expected receipt rather than read.
--
--  Two properties exist on purpose. A single-property fixture cannot
--  catch a join that forgot to scope on property_id, which is exactly
--  the defect the (work_order_id, property_id) join pairs guard against.
-- ════════════════════════════════════════════════════════════════════

insert into properties (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Property A'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Property B');

insert into users (id, name) values
  ('cccccccc-0000-0000-0000-000000000001', 'Tech One');

insert into comm_events (id, property_id) values
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001');

-- ── WORK ORDERS ─────────────────────────────────────────────────────
--  Naming: wo-<n> where the trailing digits encode the case below.
insert into work_orders (id, property_id, status, completion_note, completion_photo, created_at, updated_at) values
  --  1  PROOF FLIPS: stored 'unclassified' only. Satisfied today, not after.
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'complete', null, null, '2026-01-01', '2026-01-01'),
  --  2  DOES NOT FLIP: stored 'repair_photo'. Real classified evidence.
  ('22222222-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'complete', null, null, '2026-01-02', '2026-01-02'),
  --  3  DOES NOT FLIP: has BOTH unclassified and repair_photo.
  ('33333333-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'complete', null, null, '2026-01-03', '2026-01-03'),
  --  4  DOES NOT FLIP: unclassified but NOT stored (referenced only).
  --     Never satisfied proof, so there is nothing to lose.
  ('44444444-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'complete', null, null, '2026-01-04', '2026-01-04'),
  --  5  FLIPS: stored 'unclassified' + stored 'access_attempt'. access_attempt
  --     is not in PROOF_REQUIRED_CLASSIFICATIONS, so unclassified is the only
  --     thing holding proof up.
  ('55555555-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'complete', null, null, '2026-01-05', '2026-01-05'),
  --  6  DOES NOT FLIP: stored 'condition'. Classified evidence.
  ('66666666-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'complete', null, null, '2026-01-06', '2026-01-06'),
  --  7  THE UNCLASSIFIABLE POPULATION: status complete, NO completed
  --     progress row. Ruling 1's predicate has nothing to compare.
  ('77777777-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'complete', null, null, '2026-01-07', '2026-01-07'),
  --  8  THE SECOND LANE: closeout route. status 'closed', column proof,
  --     no progress row at all.
  ('88888888-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001', 'closed', 'fixed the valve', 'https://example.invalid/p.jpg', '2026-01-08', '2026-01-08'),
  --  9  SECOND LANE, no column note. Proves C5 splits on both columns.
  ('99999999-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', 'closed', null, 'https://example.invalid/q.jpg', '2026-01-09', '2026-01-09'),
  -- 10  NOT FINISHED WORK. Must not appear in C1/C3/C5/E1 at all.
  ('10101010-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', 'open', null, null, '2026-01-10', '2026-01-10'),
  -- 11  NOT FINISHED WORK: the fourth status value the baseline comment
  --     does not mention. C0 must surface it.
  ('11101110-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', 'needs_followup', null, null, '2026-01-11', '2026-01-11'),
  -- 12  PROPERTY B. Same shape as 1 (flips), different property, so B3 and
  --     C3 ordering and property scoping are both exercised.
  ('12121212-0000-0000-0000-000000000012', 'bbbbbbbb-0000-0000-0000-000000000002', 'complete', null, null, '2026-01-12', '2026-01-12'),
  -- 13  PROPERTY B: complete WITHOUT a completed progress row.
  ('13131313-0000-0000-0000-000000000013', 'bbbbbbbb-0000-0000-0000-000000000002', 'complete', null, null, '2026-01-13', '2026-01-13');

-- ── PROGRESS ────────────────────────────────────────────────────────
--  A 'completed' row for 1-6 and 12, and deliberately NOT for 7, 8, 9, 13.
--  Work order 4 also carries a non-'completed' kind, so the kind filter is
--  exercised rather than assumed.
insert into work_order_progress (work_order_id, property_id, kind, reported_by_user_id, occurred_at) values
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'completed', 'cccccccc-0000-0000-0000-000000000001', '2026-02-01T10:00:00Z'),
  ('22222222-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'completed', 'cccccccc-0000-0000-0000-000000000001', '2026-02-02T10:00:00Z'),
  ('33333333-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'completed', 'cccccccc-0000-0000-0000-000000000001', '2026-02-03T10:00:00Z'),
  ('44444444-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'completed', 'cccccccc-0000-0000-0000-000000000001', '2026-02-04T10:00:00Z'),
  --  A claim is NOT a completion. If the kind filter were dropped, work
  --  order 7 would wrongly gain a completion timestamp from this row.
  ('77777777-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'completion_claimed', 'cccccccc-0000-0000-0000-000000000001', '2026-02-07T10:00:00Z'),
  ('55555555-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'completed', 'cccccccc-0000-0000-0000-000000000001', '2026-02-05T10:00:00Z'),
  ('66666666-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'completed', 'cccccccc-0000-0000-0000-000000000001', '2026-02-06T10:00:00Z'),
  ('12121212-0000-0000-0000-000000000012', 'bbbbbbbb-0000-0000-0000-000000000002', 'completed', 'cccccccc-0000-0000-0000-000000000001', '2026-02-12T10:00:00Z');

-- ── PROOF ATTACHMENTS ───────────────────────────────────────────────
--  ck_wopa_stored_is_complete forces stored rows to carry content, size,
--  digest and stored_at together, so these are real rows, not shortcuts.
insert into work_order_proof_attachments
  (work_order_id, property_id, uploaded_by_user_id, mime_type, storage_state,
   proof_classification, content, byte_size, sha256, stored_at, received_at) values
  --  1  stored unclassified only  -> FLIPS
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'image/jpeg', 'stored', 'unclassified', '\x01'::bytea, 1, repeat('a',64), '2026-02-01', '2026-02-01'),
  --  2  stored repair_photo       -> does not flip
  ('22222222-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'image/jpeg', 'stored', 'repair_photo', '\x02'::bytea, 1, repeat('b',64), '2026-02-02', '2026-02-02'),
  --  3  both                      -> does not flip
  ('33333333-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'image/jpeg', 'stored', 'unclassified', '\x03'::bytea, 1, repeat('c',64), '2026-02-03', '2026-02-03'),
  ('33333333-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'image/jpeg', 'stored', 'repair_photo', '\x04'::bytea, 1, repeat('d',64), '2026-02-03', '2026-02-03'),
  --  4  unclassified but REFERENCED, never stored -> not preserved, no flip
  ('44444444-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'image/jpeg', 'referenced', 'unclassified', null, null, null, null, '2026-02-04'),
  --  5  stored unclassified + stored access_attempt -> FLIPS
  ('55555555-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'image/jpeg', 'stored', 'unclassified', '\x05'::bytea, 1, repeat('e',64), '2026-02-05', '2026-02-05'),
  ('55555555-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'image/jpeg', 'stored', 'access_attempt', '\x06'::bytea, 1, repeat('f',64), '2026-02-05', '2026-02-05'),
  --  6  stored condition          -> does not flip
  ('66666666-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'image/jpeg', 'stored', 'condition', '\x07'::bytea, 1, repeat('0',64), '2026-02-06', '2026-02-06'),
  --  a FETCH_FAILED row, so B1's storage-state census has more than two values
  ('66666666-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'image/png', 'fetch_failed', 'unclassified', null, null, null, null, '2026-02-06'),
  -- 12  PROPERTY B, stored unclassified only -> FLIPS
  ('12121212-0000-0000-0000-000000000012', 'bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001', 'image/jpeg', 'stored', 'unclassified', '\x08'::bytea, 1, repeat('1',64), '2026-02-12', '2026-02-12');
