# Chain preconditions

Some migrations in this chain are **data-dependent**: they refuse unless
specific rows already exist. That is correct behaviour — they are backfills
and authority grants that must not silently do nothing — but it means a
schema built from EMPTY stops at them, while production sails past because
the rows are already there.

Each file here seeds the minimum a named migration needs, and is applied by
`apply_migrations.sh` / `release_rehearsal.sh` immediately before that
migration. The version number in the filename is the only wiring.

**These are FIXTURES for building a test or rehearsal schema.** They are not
production data, are not a migration, and must never be applied to a real
database. Production already has the real rows; that is precisely why these
migrations pass there and stop here.
