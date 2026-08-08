-- ════════════════════════════════════════════════════════════════════
--  RELEASE 0 SCALE FIXTURE — EVALUATIONS ONLY
--
--  Evaluations, chains and evaluation→attachment links — and DELIBERATELY
--  NOT activation history or the legacy cutover inventory. Populating
--  those two is exactly what the activation transaction proof measures,
--  so they must be empty when it starts. These tables do not exist until the
--  candidate has been applied, which is also true in production: 137
--  lands on a populated work_orders and the evaluation tables start empty.
--
--  EVERY evaluation row here is inserted through the real chain guard.
--  Nothing is loaded around the trigger, because a population assembled
--  around the guard would prove nothing about the guard.
--
--  ⚠ ISOLATED HARNESS ONLY.
-- ════════════════════════════════════════════════════════════════════

do $guard$
declare p text;
begin
  if current_database() <> 'r0scale' then
    raise exception 'REFUSED: not the isolated scale database (%)', current_database();
  end if;
  select purpose into p from public.release_0_scale_harness_guard where id = true;
  if p is distinct from 'ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION' then
    raise exception 'REFUSED: harness sentinel absent or wrong';
  end if;
end $guard$;

-- ════════════════════════════════════════════════════════════════════
--  2. EVALUATION GENESIS ROWS — 28,000, through the trigger
--
--    buckets 40-59  → satisfied       20,000
--    buckets 60-67  → not_satisfied    8,000
--
--  Set-based INSERT ... SELECT still fires the BEFORE INSERT trigger once
--  per row, so every one of these is guard-checked.
-- ════════════════════════════════════════════════════════════════════
insert into public.work_order_proof_evaluations
  (id, work_order_id, property_id, state, evaluated_at,
   evaluated_by_user_id, evaluated_by_service, rule_version, supersedes_id)
select
  md5('r0-eval-g-' || i)::uuid,
  md5('r0-wo-' || i)::uuid,
  md5('r0-prop-' || ((i % 5) + 1))::uuid,
  case when i % 100 between 40 and 59 then 'satisfied' else 'not_satisfied' end,
  timestamptz '2025-06-01 00:00:00+00' + (i || ' seconds')::interval,
  md5('r0-user-' || ((i % 10) + 1))::uuid,
  'scale_fixture', 'v1', null
from generate_series(1, 100000) i
where i % 100 between 40 and 67;

-- ════════════════════════════════════════════════════════════════════
--  3. EVALUATION → ATTACHMENT LINKS
--
--  Only where the work order actually has a preserved attachment, and only
--  within scope — the composite FKs make anything else unrepresentable.
-- ════════════════════════════════════════════════════════════════════
insert into public.work_order_proof_evaluation_attachments
  (evaluation_id, attachment_id, work_order_id, property_id)
select e.id, a.id, e.work_order_id, e.property_id
  from public.work_order_proof_evaluations e
  join public.work_order_proof_attachments a
    on a.work_order_id = e.work_order_id
   and a.property_id   = e.property_id
 where e.supersedes_id is null
   and a.storage_state = 'stored'
   and a.proof_classification in ('repair_photo','condition');

-- ════════════════════════════════════════════════════════════════════
--  4. CHAINS AT SEVERAL DEPTHS — every successor through the guard
--
--    depth    1   27,880 work orders   (the genesis rows above)
--    depth    2      100
--    depth   10       15
--    depth  100        4
--    depth 1000        1
--
--  Depth is counted as rows in the chain. The FINAL head keeps the state
--  the reader is expected to report, so deepening a chain must not change
--  what §3.2 derives for that work order.
-- ════════════════════════════════════════════════════════════════════
do $chains$
declare
  target record;
  head_id uuid;
  new_id  uuid;
  k int;
  n int;
  spec record;
begin
  for spec in
    select * from (values
      ( 2,  100, 1),      -- depth, how many work orders, offset rank
      (10,   15, 101),
      (100,   4, 116),
      (1000,  1, 120)
    ) as v(depth, howmany, startrank)
  loop
    n := 0;
    for target in
      --  deterministic selection: the nth satisfied-bucket work order,
      --  ordered by id so the choice does not depend on physical layout
      select e.id as gen_id, e.work_order_id, e.property_id
        from public.work_order_proof_evaluations e
       where e.supersedes_id is null
         and e.state = 'satisfied'
       order by e.work_order_id
       offset spec.startrank limit spec.howmany
    loop
      head_id := target.gen_id;
      for k in 2 .. spec.depth loop
        new_id := md5('r0-eval-s-' || target.work_order_id || '-' || k)::uuid;
        insert into public.work_order_proof_evaluations
          (id, work_order_id, property_id, state, evaluated_at,
           evaluated_by_user_id, evaluated_by_service, rule_version, supersedes_id)
        values (new_id, target.work_order_id, target.property_id,
                'satisfied',
                timestamptz '2025-07-01 00:00:00+00' + (k || ' seconds')::interval,
                null, 'scale_fixture', 'v1', head_id);
        head_id := new_id;
      end loop;
      n := n + 1;
    end loop;
    raise notice 'chains of depth %: % built', spec.depth, n;
  end loop;
end
$chains$;

