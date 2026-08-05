-- ════════════════════════════════════════════════════════════════════
--  133_work_order_reference.sql — A NUMBER A HUMAN CAN SAY.
--
--  Work orders are identified by uuid. Nobody texts a uuid. The owner's
--  own example receipt — "Work Order 1042 is now accepted by you" — is not
--  expressible today, because there is no 1042: the column does not exist.
--
--  A conversational technician loop cannot work without one. This is that
--  column, and nothing else.
--
--  ── GLOBAL, NOT PER-PROPERTY, AND WHY ───────────────────────────────
--
--  A per-building counter reads better ("WO 42 at Maple Court") and is the
--  wrong choice here. A technician assigned to two buildings who texts
--  "42" would be ambiguous for a reason that is purely our numbering — a
--  clarification caused by the schema rather than by the world. The
--  reference resolver must ask only when reality is genuinely unclear.
--
--  So the sequence is global and the reference is unique across the
--  portfolio. It identifies; it does not describe. It carries no property,
--  no tenant and no ordering meaning beyond creation order.
--
--  ── IT CANNOT BE OMITTED ────────────────────────────────────────────
--
--  The default is the sequence, so every insert gets one — including the
--  canonical service, with no application change and no code path that can
--  forget. NOT NULL is set after the backfill, so a work order without a
--  reference becomes a row that cannot exist.
-- ════════════════════════════════════════════════════════════════════

begin;

create sequence if not exists work_order_ref_seq as bigint start with 1000;

alter table work_orders add column if not exists work_order_ref bigint;

--  Backfill in creation order so the numbers read as a history rather than
--  as an arbitrary shuffle. Existing rows keep their identity; this only
--  gives them a name.
do $$
declare r record;
begin
  if exists (select 1 from work_orders where work_order_ref is null) then
    for r in select id from work_orders where work_order_ref is null order by created_at, id loop
      update work_orders set work_order_ref = nextval('work_order_ref_seq') where id = r.id;
    end loop;
  end if;
end $$;

alter table work_orders alter column work_order_ref set default nextval('work_order_ref_seq');
alter table work_orders alter column work_order_ref set not null;

create unique index if not exists uq_work_orders_ref on work_orders (work_order_ref);

commit;
