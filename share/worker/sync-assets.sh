#!/usr/bin/env sh
# Copy the files the viewer shares with the extension into the static assets directory.
# public/ subdirectories are gitignored: git holds one copy, deploy gets a duplicate.
#
# Run this before every `wrangler deploy`.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)

mkdir -p "$here/public/vendor" "$here/public/replay" "$here/public/share"

# replay/ is created by Task 5 of docs/plans/2026-08-10-replay-sharing-implementation.md.
# Until it lands, these two are absent and `set -e` would abort the whole script before
# copying anything below. Drop the guard once Task 5 is done — the viewer needs them.
missing=0
for rel in \
  vendor/rrweb-replay.min.js \
  vendor/rrweb.min.css \
  replay/replay-timeline.js \
  replay/replay-core.js \
  share/payload.js \
  share/hosts.js
do
  dest="$here/public/$(dirname "$rel")/"
  if [ -f "$repo/$rel" ]; then
    cp "$repo/$rel" "$dest"
  else
    echo "  skipped $rel (not created yet)"
    missing=$((missing + 1))
  fi
done

echo "synced into $here/public"
[ "$missing" -eq 0 ] || echo "  $missing file(s) missing — the viewer will not work until Task 5 lands"
