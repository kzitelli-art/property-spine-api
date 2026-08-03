-- ════════════════════════════════════════════════════════════════════
--  129_property_line_uniqueness.sql
--  The property line is the property wall. Make the database enforce it.
--
--  BEFORE THIS MIGRATION:
--    · properties.sms_number had NO unique index — migration 030 is only
--      `add column if not exists sms_number text`;
--    · inbound resolution was `where sms_number = $1 limit 1`, no order by.
--  Two properties sharing a number therefore bound a resident's message to
--  an ARBITRARY property — their claim on another building's ledger, with
--  no signal. One guarded route (tenantlink 409-on-clash) was the only
--  defence: application code with no database backstop, bypassed by any
--  seed, migration, admin tool or direct SQL.
--
--  WHAT THIS INSTALLS
--    1. a refusal if any two properties normalize to the SAME line;
--    2. a refusal if any stored line cannot be normalized at all;
--    3. a ONE-TIME backfill of non-canonical stored values;
--    4. a CHECK constraint pinning the canonical form — this is what stops
--       a direct write from bypassing uniqueness with alternate formatting
--       ('(724) 309-8434' and '+17243098434' are the same line, and only
--       one of them can now be stored);
--    5. a UNIQUE index using the SAME eligibility predicate the resolver
--       uses (`sms_number is not null`, no other filter).
--
--  ORDER MATTERS. Duplicates are detected BEFORE anything is mutated, and
--  the migration RAISES with the exact property ids rather than choosing a
--  winner. Selecting one would be the same silent pick this whole slice
--  exists to remove — just moved from read time to migration time. A human
--  decides which building owns the number.
--
--  ON THE SQL NORMALIZATION BELOW. It mirrors normalizePropertyLine() in
--  src/comms/property_line.js. That is deliberately a ONE-TIME historical
--  transform, not a parallel implementation of a live rule: after step 4 no
--  non-canonical value can be stored again, so this expression never
--  governs another write. The ongoing rule has exactly one implementation,
--  in JavaScript. Run tools/property_line_preflight.js — which uses that
--  JavaScript function directly — before releasing this.
--
--  Class (§18): permanent. Removed only if properties.sms_number itself is
--  retired by the canonical communication-line model.
-- ════════════════════════════════════════════════════════════════════

-- ── 1 + 2. REFUSE BEFORE MUTATING ───────────────────────────────────
do $$
declare
  bad_rows   text;
  dup_rows   text;
begin
  -- A stored value we cannot normalize is not a line. Naming the ids is the
  -- whole point: the operator has to look at them.
  select string_agg(format('%s (%L)', id, sms_number), E'\n      ' order by id)
    into bad_rows
    from properties
   where sms_number is not null
     and case
           when length(regexp_replace(sms_number, '\D', '', 'g')) = 10
             then '+1' || regexp_replace(sms_number, '\D', '', 'g')
           when length(regexp_replace(sms_number, '\D', '', 'g')) = 11
            and left(regexp_replace(sms_number, '\D', '', 'g'), 1) = '1'
             then '+' || regexp_replace(sms_number, '\D', '', 'g')
           else null
         end is null;

  if bad_rows is not null then
    raise exception
      'MIGRATION 129 REFUSED — property line(s) cannot be normalized.%s',
      E'\n\n    These properties hold an sms_number that is not a US phone number:\n      '
      || bad_rows
      || E'\n\n    Nothing was changed. Correct or clear each value, then re-run.\n'
         '    Do not guess: an unreadable line is not a line.\n';
  end if;

  -- Two properties normalizing to one number. Report ids; choose nothing.
  select string_agg(entry, E'\n      ')
    into dup_rows
    from (
      select format('%s  <- properties %s',
                    norm,
                    string_agg(id::text, ', ' order by id)) as entry
        from (
          select id,
                 case
                   when length(regexp_replace(sms_number, '\D', '', 'g')) = 10
                     then '+1' || regexp_replace(sms_number, '\D', '', 'g')
                   when length(regexp_replace(sms_number, '\D', '', 'g')) = 11
                    and left(regexp_replace(sms_number, '\D', '', 'g'), 1) = '1'
                     then '+' || regexp_replace(sms_number, '\D', '', 'g')
                 end as norm
            from properties
           where sms_number is not null
        ) n
       where norm is not null
       group by norm
      having count(*) > 1
    ) d;

  if dup_rows is not null then
    raise exception
      'MIGRATION 129 REFUSED — two or more properties share one line.%s',
      E'\n\n    After normalization these lines are held by more than one property:\n      '
      || dup_rows
      || E'\n\n    Nothing was changed. A human decides which property owns each\n'
         '    number — this migration will not pick one. Clear the line on the\n'
         '    properties that should not have it, then re-run.\n';
  end if;
end $$;

-- ── 3. ONE-TIME BACKFILL ────────────────────────────────────────────
--  Only rows that are not already canonical. Proven safe by step 1+2:
--  every remaining value normalizes, and no two collide.
update properties
   set sms_number = case
         when length(regexp_replace(sms_number, '\D', '', 'g')) = 10
           then '+1' || regexp_replace(sms_number, '\D', '', 'g')
         else '+' || regexp_replace(sms_number, '\D', '', 'g')
       end
 where sms_number is not null
   and sms_number !~ '^\+1[0-9]{10}$';

-- ── 4. CANONICAL FORM, ENFORCED ─────────────────────────────────────
--  Exactly the set normalizePropertyLine() can emit. Without this, a direct
--  write could store '(724) 309-8434' beside '+17243098434' and the unique
--  index would see two different strings — uniqueness bypassed by
--  formatting, which is the hole this slice closes.
alter table properties
  drop constraint if exists ck_properties_sms_number_canonical;
alter table properties
  add constraint ck_properties_sms_number_canonical
  check (sms_number is null or sms_number ~ '^\+1[0-9]{10}$');

-- ── 5. ONE LINE, ONE PROPERTY ───────────────────────────────────────
--  SAME eligibility predicate as resolvePropertyByLine(): every row with a
--  non-null sms_number, no further filter. If properties ever gain an
--  archived/inactive flag, this index and that resolver must change in the
--  same commit.
drop index if exists uq_properties_sms_number;
create unique index uq_properties_sms_number
  on properties (sms_number)
  where sms_number is not null;

comment on index uq_properties_sms_number is
  'One line, one property. Inbound routing binds a resident claim to a property ledger by the receiving number; two properties sharing one number would bind it arbitrarily. Paired with ck_properties_sms_number_canonical so alternate formatting cannot bypass this.';
