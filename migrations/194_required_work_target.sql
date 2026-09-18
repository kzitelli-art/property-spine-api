-- Class 1 extension of the existing required-work identity. No inferred targets.
alter table unit_triage_required_work
  add column scope_kind text not null default 'unspecified'
    check (scope_kind in ('unspecified','unit_wide','rentable_space')),
  add column space_id uuid references spaces(id),
  add constraint required_work_target_shape check (
    (scope_kind='rentable_space' and space_id is not null)
    or (scope_kind<>'rentable_space' and space_id is null));

create unique index spaces_work_target_identity on spaces(id,unit_id);
alter table unit_triage_required_work add constraint required_work_space_unit
  foreign key(space_id,unit_id) references spaces(id,unit_id);

-- Scope corrections require a successor confirmation/work identity. Status and
-- existing attributed withdrawal/supersession remain available.
create function protect_required_work_target() returns trigger language plpgsql as $$
begin
  if row(new.scope_kind,new.space_id,new.unit_id,new.property_id,new.confirmation_id)
     is distinct from row(old.scope_kind,old.space_id,old.unit_id,old.property_id,old.confirmation_id)
  then raise exception 'Required work target is immutable; record a correction'; end if;
  return new;
end $$;
create trigger required_work_target_immutable before update on unit_triage_required_work
 for each row execute function protect_required_work_target();
