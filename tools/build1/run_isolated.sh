#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  run_isolated.sh — one harness, one disposable database, always dropped
#
#  A previous night left 848 abandoned clones holding ~20 GB, which is
#  enough to kill an overnight run for reasons that have nothing to do
#  with the product. This is the narrow fix, and deliberately not a test
#  infrastructure project.
#
#  ── THE DATABASE IS DESTROYED FROM OUTSIDE ─────────────────────────
#
#  Not by the harness, and not from inside the database. The Release 0
#  tables are append-only by trigger on purpose; a harness that could
#  clean up after itself would be a harness that can delete history. So
#  the disposable database is created here, handed to the child by env
#  var, and dropped by a trap that fires on success, on failure, and on
#  interrupt alike.
#
#  usage:
#    tools/build1/run_isolated.sh VAR_NAME node path/to/harness.js [args…]
#
#  exit code is the CHILD's, preserved exactly — a cleanup wrapper that
#  swallowed a failure would be worse than no wrapper.
# ════════════════════════════════════════════════════════════════════
set -uo pipefail
export PATH=/usr/lib/postgresql/16/bin:$PATH

VAR="${1:?usage: run_isolated.sh VAR_NAME command...}"; shift
HOST=127.0.0.1
PORT=5433
USER=postgres
TEMPLATE=r0scale
PGDATA_DIR=/var/tmp/r0scale/pg
NAME="iso_$$_${RANDOM}"

cleanup() {
  local rc=$?
  #  Terminate any connection the child left open, or the drop blocks and
  #  the clone survives — which is exactly how 848 of them accumulated.
  psql -h "$HOST" -p "$PORT" -U "$USER" -d postgres -qtAc \
    "select pg_terminate_backend(pid) from pg_stat_activity where datname='$NAME'" \
    >/dev/null 2>&1
  dropdb -h "$HOST" -p "$PORT" -U "$USER" --if-exists "$NAME" >/dev/null 2>&1
  exit $rc
}
trap cleanup EXIT INT TERM

#  The local cluster does not survive an idle gap in this environment —
#  it is stopped from outside with no error in its own log. Starting it
#  when it is down is a one-line self-heal; failing a hundred assertions
#  because a background process was reaped is not a product finding.
if ! pg_isready -h "$HOST" -p "$PORT" >/dev/null 2>&1; then
  rm -f "$PGDATA_DIR/postmaster.pid" 2>/dev/null
  su postgres -c "PATH=/usr/lib/postgresql/16/bin:\$PATH pg_ctl -D $PGDATA_DIR -o '-p $PORT' -l $PGDATA_DIR/../pg.log start" >/dev/null 2>&1
  for _ in $(seq 1 45); do
    pg_isready -h "$HOST" -p "$PORT" >/dev/null 2>&1 && break
    sleep 2
  done
fi

if ! createdb -h "$HOST" -p "$PORT" -U "$USER" -T "$TEMPLATE" "$NAME" 2>/dev/null; then
  echo "REFUSED: could not clone $TEMPLATE into $NAME — is the cluster on $PORT up?" >&2
  exit 2
fi

env "$VAR=postgresql://$USER@$HOST:$PORT/$NAME?sslmode=disable" "$@"
