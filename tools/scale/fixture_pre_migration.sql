-- ════════════════════════════════════════════════════════════════════
--  RELEASE 0 SCALE FIXTURE — PART A, BEFORE THE CANDIDATE
--
--  100,000 work orders, deterministic. Re-running against a clean
--  baseline produces identical ids, identical cardinalities and an
--  identical state distribution — every id is md5(seed_text)::uuid and
--  every bucket is `i % 100`, so nothing depends on random().
--
--  ⚠ ISOLATED HARNESS ONLY. Refuses unless the sentinel is present.
--
--  ── NO REAL DATA ────────────────────────────────────────────────────
--  No real names, phone numbers, resident data or production records.
--  Persons are omitted entirely rather than invented: this fixture
--  measures work-order cardinality, and a synthetic resident would be a
--  fabricated human for no measured benefit.
--
--  ── THE POPULATION IS THE POINT ─────────────────────────────────────
--  Buckets are chosen so every four-state reader result has a large,
--  separable population — including the one the release exists to catch:
--  closed + NOT inventoried + no evaluation (§3.2.0, correction 7).
-- ════════════════════════════════════════════════════════════════════

begin;

do $guard$
declare p text;
begin
  if current_database() <> 'r0scale' then
    raise exception 'REFUSED: fixture runs only against the isolated scale database, not %', current_database();
  end if;
  select purpose into p from public.release_0_scale_harness_guard where id = true;
  if p is distinct from 'ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION' then
    raise exception 'REFUSED: harness sentinel absent or wrong';
  end if;
end $guard$;

-- ── properties: 5 synthetic, deterministic ──────────────────────────
insert into public.properties (id, name)
select md5('r0-prop-' || k)::uuid, 'R0 SCALE PROPERTY ' || k
  from generate_series(1, 5) k
on conflict (id) do nothing;

-- ── users: 10 synthetic evaluators ──────────────────────────────────
insert into public.users (id, name, role, account_kind, is_active, status)
select md5('r0-user-' || k)::uuid, 'R0 SCALE TECH ' || k,
       'maintenance', 'human_staff', true, 'active'
  from generate_series(1, 10) k
on conflict (id) do nothing;

insert into public.property_team_assignments
  (user_id, property_id, role_title, allowed_modules, active)
select md5('r0-user-' || k)::uuid, md5('r0-prop-' || ((k % 5) + 1))::uuid,
       'technician', array['maintenance'], true
  from generate_series(1, 10) k
on conflict do nothing;

-- ════════════════════════════════════════════════════════════════════
--  100,000 WORK ORDERS
--
--  bucket = i % 100 — the whole distribution, in one place:
--
--    00-14  open              non-terminal      15,000
--    15-24  scheduled         non-terminal      10,000
--    25-34  in_progress       non-terminal      10,000
--    35-39  needs_followup    non-terminal       5,000
--    40-59  complete          → evaluation satisfied      20,000
--    60-67  complete          → evaluation not_satisfied   8,000
--    68-80  complete          → INVENTORIED, no evaluation 13,000
--    81-92  closed            → INVENTORIED, no evaluation 12,000
--    93-96  complete          → NOT inventoried, no eval    4,000  DEFECT
--    97-99  closed            → NOT inventoried, no eval    3,000  DEFECT ←
--
--  terminal 60,000 · non-terminal 40,000 · inventoried 25,000
--  with-evaluation 28,000 · defects 7,000
--
--  The last bucket is the correction-7 hole: a closed row outside the
--  inventory with no evaluation. Under revision 3's definition it was not
--  "terminal" and escaped detection entirely.
-- ════════════════════════════════════════════════════════════════════
insert into public.work_orders
  (id, property_id, title, description, status, source,
   urgency_status, urgency_basis, urgency_decided_by,
   is_emergency, needs_pm_review, completion_photo, completion_note,
   created_at, work_order_ref)
select
  md5('r0-wo-' || i)::uuid,
  md5('r0-prop-' || ((i % 5) + 1))::uuid,
  'R0 SCALE WORK ORDER ' || i,
  'Synthetic scale fixture row. No real property, resident or repair.',
  case
    when i % 100 between  0 and 14 then 'open'
    when i % 100 between 15 and 24 then 'scheduled'
    when i % 100 between 25 and 34 then 'in_progress'
    when i % 100 between 35 and 39 then 'needs_followup'
    when i % 100 between 81 and 92 then 'closed'
    when i % 100 between 97 and 99 then 'closed'
    else 'complete'
  end,
  'scale_fixture',
  'regular', 'scale fixture', 'system',
  false, false,
  --  ATTACHMENT-PRESENCE-ONLY HISTORICAL ROWS. The legacy writer emitted a
  --  stub:// string with no bytes, so presence is all the column can
  --  honestly support — which is exactly what had_column_photo records.
  case when i % 100 between 68 and 92 and i % 3 = 0
       then 'stub://closeout-photo/' || i else null end,
  case when i % 100 between 68 and 92 and i % 4 = 0
       then 'Legacy closeout note.' else null end,
  timestamptz '2024-01-01 00:00:00+00' + (i || ' minutes')::interval,
  --  work_order_ref is bigint, not text. Offset well clear of any
  --  existing sequence so the fixture cannot collide with it.
  1000000 + i
from generate_series(1, 100000) i;

-- ════════════════════════════════════════════════════════════════════
--  PROOF ATTACHMENTS
--
--  Four storage states and five classifications, so the reader's
--  preserved-count and not-preserved-count are both exercised, and so
--  §3.1's classification change (dropping 'unclassified' from the
--  required set) has a population that would move if it were wrong.
--
--  `stored` carries REAL bytes: the table checks
--    byte_size = octet_length(content), sha256 ~ 64 hex, stored_at not null
--  so a fake stored row is unrepresentable.
-- ════════════════════════════════════════════════════════════════════
with content as (select decode(repeat('ab', 64), 'hex') as c)
insert into public.work_order_proof_attachments
  (id, work_order_id, property_id, uploaded_by_user_id, mime_type,
   storage_state, proof_classification, content, byte_size, sha256,
   received_at, stored_at, provider)
select
  md5('r0-att-' || i || '-' || j)::uuid,
  md5('r0-wo-' || i)::uuid,
  md5('r0-prop-' || ((i % 5) + 1))::uuid,
  md5('r0-user-' || ((i % 10) + 1))::uuid,
  'image/jpeg',
  st.state,
  st.classification,
  case when st.state = 'stored' then content.c end,
  case when st.state = 'stored' then octet_length(content.c) end,
  case when st.state = 'stored' then encode(sha256(content.c), 'hex') end,
  timestamptz '2024-01-01 00:00:00+00' + (i || ' minutes')::interval,
  case when st.state = 'stored'
       then timestamptz '2024-01-01 00:00:00+00' + (i || ' minutes')::interval end,
  'scale_fixture'
from generate_series(1, 100000) i
cross join content
cross join lateral (
  select j, state, classification from (values
    --  the preserved proof the reader counts
    (1, 'stored',        'repair_photo'),
    --  a second preserved kind, also counted
    (2, 'stored',        'condition'),
    --  arrived and could NOT be kept — never proof, reported separately
    (3, 'not_preserved', 'repair_photo'),
    --  §3.1: 'unclassified' is REMOVED from the required set. If the
    --  classification array regressed, these rows would start counting.
    (4, 'stored',        'unclassified'),
    --  referenced only — no bytes, so not preserved
    (5, 'referenced',    'other')
  ) as v(j, state, classification)
  --  every 7th work order gets attachments; how many depends on i, so the
  --  per-work-order distribution is uneven the way real data is
  where i % 7 = 0 and j <= 1 + (i % 5)
) st;

commit;

-- ── verification the fixture asserts about itself ────────────────────
--  Printed, not trusted silently. The runner reconciles these against the
--  census it takes independently.
select 'work_orders'            as what, count(*) as n from public.work_orders where source = 'scale_fixture'
union all select 'terminal',      count(*) from public.work_orders where source='scale_fixture' and status in ('complete','closed')
union all select 'complete',      count(*) from public.work_orders where source='scale_fixture' and status='complete'
union all select 'closed',        count(*) from public.work_orders where source='scale_fixture' and status='closed'
union all select 'non_terminal',  count(*) from public.work_orders where source='scale_fixture' and status not in ('complete','closed')
union all select 'attachments',   count(*) from public.work_order_proof_attachments where provider='scale_fixture'
union all select 'att_preserved', count(*) from public.work_order_proof_attachments
            where provider='scale_fixture' and storage_state='stored'
              and proof_classification in ('repair_photo','condition')
order by 1;
