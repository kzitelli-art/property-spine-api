#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  Property Spine — branch cleanup
#
#  Audited 2026-08-05T12:11Z against:
#      API main  8330aece95e5a242467759e931ffffa7d64816cd
#      App main  357fb15563cf92d4d40405c298387e6f659c24d5
#
#  USAGE
#      ./branch_cleanup.sh            dry run — prints, changes nothing
#      ./branch_cleanup.sh --apply    performs the tags and deletions
#
#  Run once from each clone. It detects which repo it is in from `origin`.
#
#  SAFETY
#    · dry run is the DEFAULT; --apply is required to change anything
#    · every branch tip is verified against the audited SHA before deletion.
#      A branch that moved since the audit is SKIPPED and reported, never
#      deleted on the assumption the audit is still current
#    · the first failed tag push or deletion aborts the run
#    · already-deleted branches and already-created tags are skipped, so the
#      script is safe to re-run after an interruption
#    · `delete` rows are branches with ZERO commits ahead of main — their
#      content is already in main. `archive` rows are tagged first, so no
#      commit is ever unreachable afterwards
# ════════════════════════════════════════════════════════════════════
set -uo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
MANIFEST="$(dirname "$0")/manifest.txt"

[ -f "$MANIFEST" ] || { echo "FATAL: manifest.txt not found beside this script"; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "FATAL: not inside a git clone"; exit 2; }

case "$(git remote get-url origin 2>/dev/null)" in
  *property-spine-api*) REPO=api ;;
  *property-spine-app*) REPO=app ;;
  *) echo "FATAL: origin is neither property-spine-api nor property-spine-app"; exit 2 ;;
esac

echo "repo:  $REPO"
echo "mode:  $([ $APPLY -eq 1 ] && echo APPLY || echo 'DRY RUN — nothing will change')"
echo "fetching…"; git fetch --quiet origin --prune || { echo "FATAL: fetch failed"; exit 2; }
echo

deleted=0; tagged=0; skipped_gone=0; skipped_moved=0; skipped_tagged=0; planned=0

while IFS='|' read -r repo branch audited action; do
  [ "${repo:0:1}" = "#" ] && continue
  [ "$repo" = "$REPO" ] || continue

  # already gone? idempotent re-run
  current="$(git ls-remote --heads origin "$branch" 2>/dev/null | awk '{print $1}')"
  if [ -z "$current" ]; then
    echo "SKIP     $branch — already deleted"; skipped_gone=$((skipped_gone+1)); continue
  fi

  # tip must still match the audit
  if [ "$current" != "$audited" ]; then
    echo "SKIP     $branch — MOVED since audit"
    echo "             audited ${audited:0:12}   now ${current:0:12}"
    skipped_moved=$((skipped_moved+1)); continue
  fi

  tag="archive/$(printf '%s' "$branch" | tr '/' '-')"

  if [ "$action" = "archive" ]; then
    if [ -n "$(git ls-remote --tags origin "$tag" 2>/dev/null)" ]; then
      echo "note     $branch — tag $tag already exists, reusing"
      skipped_tagged=$((skipped_tagged+1))
    elif [ $APPLY -eq 1 ]; then
      git tag -f "$tag" "$current" >/dev/null 2>&1
      if ! git push origin "refs/tags/$tag"; then
        echo; echo "ABORT: tag push failed for $tag — nothing further attempted"; exit 1
      fi
      echo "TAGGED   $tag -> ${current:0:12}"; tagged=$((tagged+1))
    else
      echo "would tag   $tag -> ${current:0:12}"
    fi
  fi

  if [ $APPLY -eq 1 ]; then
    if ! git push origin --delete "$branch"; then
      echo; echo "ABORT: delete failed for $branch — nothing further attempted"; exit 1
    fi
    echo "DELETED  $branch  ($action)"; deleted=$((deleted+1))
  else
    echo "would delete $branch  ($action)"; planned=$((planned+1))
  fi
done < "$MANIFEST"

echo
echo "──────────────── REPORT ($REPO) ────────────────"
if [ $APPLY -eq 1 ]; then
  echo "  tagged                 $tagged"
  echo "  deleted                $deleted"
else
  echo "  would delete           $planned"
fi
echo "  skipped, already gone  $skipped_gone"
echo "  skipped, tip MOVED     $skipped_moved   <-- review these by hand"
echo "  tags already present   $skipped_tagged"
echo "─────────────────────────────────────────────"
if [ $skipped_moved -gt 0 ]; then
  echo "RESULT: PARTIAL — $skipped_moved branch(es) changed since the audit and were left alone."
  exit 3
fi
[ $APPLY -eq 1 ] && echo "RESULT: SUCCESS — all planned operations completed." \
                 || echo "RESULT: DRY RUN OK — re-run with --apply to perform these operations."
