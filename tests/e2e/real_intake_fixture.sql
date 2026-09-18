-- Class 3: second intake-authorized property, deliberately NOT prospect-activated.
-- Only used inside the nonce-owned verification database.
insert into properties (name)
select 'Real Intake Inactive E2E'
where not exists (select 1 from properties where name='Real Intake Inactive E2E');
