-- An application acknowledges an existing commercial offer; it does not author
-- a second set of economics. Historical rows stay unbound, never backfilled.
alter table lease_offers drop constraint if exists lease_offers_source_check;
alter table lease_offers add constraint lease_offers_source_check
  check (source in ('published','discretionary','decision_rail','application_proposal'));

create unique index lease_offers_application_proposal_retry
  on lease_offers (property_id, person_id,
    (authority_basis_snapshot->>'actor_user_id'),
    (authority_basis_snapshot->>'idempotency_key'))
  where source='application_proposal';
create unique index lease_offers_exact_application_target
  on lease_offers(id,property_id,person_id,space_id);
alter table lease_offers add column supersedes_application_offer_id uuid references lease_offers(id);
create unique index lease_offers_one_application_successor
 on lease_offers(supersedes_application_offer_id)
 where source='application_proposal' and supersedes_application_offer_id is not null;

alter table application_invitations add column application_offer_id uuid;
alter table application_invitations add constraint invitation_offer_target_fk
  foreign key(application_offer_id,property_id,person_id,space_id)
  references lease_offers(id,property_id,person_id,space_id);
alter table lease_applications add column application_offer_id uuid;
alter table lease_applications add column application_terms_hash text;
alter table lease_applications add column application_terms_acknowledged_at timestamptz;
alter table lease_applications add constraint application_offer_target_fk
  foreign key(application_offer_id,property_id,person_id,space_id)
  references lease_offers(id,property_id,person_id,space_id);
alter table lease_applications add constraint application_offer_ack_complete check (
 (application_offer_id is null and application_terms_hash is null and application_terms_acknowledged_at is null)
 or (application_offer_id is not null and space_id is not null and application_terms_hash is not null
     and application_terms_hash ~ '^[a-f0-9]{64}$' and application_terms_acknowledged_at is not null));
alter table application_invitations add constraint invitation_offer_exact_space
 check(application_offer_id is null or space_id is not null);

-- Acceptance is its own fact, not a second economic snapshot. The application
-- columns are the current projection; this history survives later acceptance.
create table application_terms_acknowledgements (
 id uuid primary key default gen_random_uuid(),
 application_id uuid not null references lease_applications(id),
 invitation_id uuid not null references application_invitations(id),
 offer_id uuid not null references lease_offers(id),
 terms_hash text not null check(terms_hash ~ '^[a-f0-9]{64}$'),
 acknowledged_at timestamptz not null default now(),
 unique(application_id,offer_id)
);
create function protect_application_terms_acknowledgement() returns trigger language plpgsql as $$
begin raise exception 'Application term acknowledgements are immutable'; end $$;
create trigger application_terms_acknowledgement_immutable before update or delete
 on application_terms_acknowledgements for each row execute function protect_application_terms_acknowledgement();

alter table application_proposed_terms_confirmations add column application_offer_id uuid references lease_offers(id);
alter table application_proposed_terms_confirmations add column application_terms_hash text;
alter table lease_packets add column application_offer_id uuid references lease_offers(id);
alter table lease_packets add column application_terms_hash text;

create function protect_application_offer_terms() returns trigger language plpgsql as $$
begin
 if old.source='application_proposal' and
   row(new.source,new.property_id,new.person_id,new.space_id,new.offered_terms_snapshot,new.authority_basis_snapshot,new.supersedes_application_offer_id)
   is distinct from
   row(old.source,old.property_id,old.person_id,old.space_id,old.offered_terms_snapshot,old.authority_basis_snapshot,old.supersedes_application_offer_id)
 then raise exception 'Application offer terms are immutable; record a successor offer'; end if;
 return new;
end $$;
create trigger application_offer_terms_immutable before update on lease_offers
 for each row execute function protect_application_offer_terms();
