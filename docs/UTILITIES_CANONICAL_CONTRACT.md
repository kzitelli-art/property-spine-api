# Utilities canonical contract

Status: domain contract for the first Utilities operating registry.

Utilities lives at Asset Management -> Property Expenses -> Utilities. It owns
the living map of utility services at one property. It is not an accounting
screen, a payment rail, a lease system, or a generic document repository.

## The canonical question

Utilities must make these relationships understandable without inference:

```text
property
  -> service declaration
  -> provider relationship
  -> provider account(s)
  -> service point(s)
  -> meter(s), when the real arrangement has them
  -> responsibility and resident-recovery arrangement
  -> dated provider statements
```

The order matters. A statement is an observation against an already-known
provider account. It is not the object from which the property setup is guessed.

## Durable concepts

`service` is a property-scoped utility service. The starter vocabulary is open:
electricity, natural gas, water, sewer, combined water/sewer, steam or district
energy, fuel oil, propane, internet or data, telephone or telecom, waste or
trash, and recycling. A custom class may be added without changing the domain.

`service declaration` is effective-dated and explicitly says `present` or
`not_applicable`. No declaration means `NOT_ESTABLISHED`; it never means no.

`provider` is a Utilities-owned portfolio identity for the party named as
supplying a utility service. The provider is related to each property through
an effective-dated service relationship; PECO is not duplicated merely because
it serves two properties. It is not the existing `vendors` primitive, whose
canonical meaning is a payee learned from bank and accounting evidence, and it
does not assert a formation-document legal identity. A provider may exist even
when every resident pays it directly and the property has never paid it.

`service point` says what and where service is delivered: whole building,
common area, unit, space, shared equipment, or another stated location. A
service point is not a meter or an account.

`meter` is a physical measurement instrument. Its kind is explicit:
provider meter or internal submeter. A non-metered service does not receive a
fake meter.

`provider account` is a durable external account identity under a provider. It
may cover several services, points, or meters. A service may have several
accounts. External identifiers are retained for matching but only masked values
leave the governed read.

`arrangement` is an effective-dated set of separate answers: who receives the
provider bill, who is responsible to the provider, who economically bears the
cost, how residents are charged, who administers resident billing, and who
receives resident payment. No one field is allowed to stand in for another.

`statement` is a dated provider observation against one provider account. Bill
date, service period, due date, amount billed, current amount due, usage, usage
basis, and late fees remain separate facts. A correction supersedes a statement;
it does not overwrite it.

## Opening-truth contract

For every starter service, opening truth must explicitly establish `present`,
`not_applicable`, or leave the service `NOT_ESTABLISHED`. For every present
service, the opening read reports exact gaps in provider, physical arrangement,
account map where the property is provider-billed, responsibility, resident
recovery, third-party administrator, service-point map, meter map, and evidence.

Meter and account requirements depend on the established arrangement. A
resident-direct service does not require a property account. A non-metered
service does not require a meter. Incompleteness always names the unanswered
question.

Later onboarding calls the same canonical Utilities writers used by operating
changes. It does not own a second Utilities record.

## Truth walls

The executable version is `src/asset/utility_contract.js`. These distinctions
must survive storage, writer, read, UI, and Ask Spine:

```text
NOT_ESTABLISHED != not applicable
provider != billing administrator
provider account != property
provider account != meter
meter != submeter
meter != unit
account identifier != service location
bill date != service period
statement amount != current amount due
amount billed != amount paid
payment date != expense period
payment != economic expense
resident charge != provider statement
resident charge != resident collection
resident collection != provider payment
resident recovery != reduction of provider obligation
resident direct != property paid and recovered
master-metered != submetered
provider-metered != resident lease responsibility
submeter != provider account
estimated usage != observed usage
late fee != consumption
billing-administrator calculation != provider statement
lease obligation != collected cash
cash reading != accrual reading
```

## Payment boundary

The existing resident `payments` module records money received from residents.
It is not a provider-payment or accounts-payable rail. Bank transactions are
money observations, not governed settlement of a utility statement. Therefore a
provider statement's payment standing is `NOT_ESTABLISHED` until a future
canonical settlement association explicitly names that statement.

## Capability claim

The first slice claims governed retrieval and same-account statement comparison
where the compared statement dates, periods, amounts, and usage are all recorded.
It does not claim portfolio normalization, anomaly attribution, or causal
explanation. A change in two bills may be described; its cause may not be
invented.
