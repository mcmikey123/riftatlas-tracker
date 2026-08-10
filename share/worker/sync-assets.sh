#!/usr/bin/env sh
# Copy the files the viewer shares with the extension into the static assets directory.
# public/ subdirectories are gitignored: git holds one copy, deploy gets a duplicate.
#
# Run this before every `wrangler deploy`.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)

mkdir -p "$here/public/vendor" "$here/public/replay" "$here/public/share" "$here/public/store"

# Every file below is one the viewer page loads by name, so a missing one is a broken
# deploy. It is reported and counted rather than left to `set -e`, which would abort
# before copying the rest and hide how much is actually absent.
missing=0
for rel in \
  vendor/rrweb-replay.min.js \
  vendor/rrweb.min.css \
  replay/replay-timeline.js \
  replay/replay-core.js \
  share/payload.js \
  share/hosts.js \
  share/viewer-support.js \
  store/css-assets.js
do
  dest="$here/public/$(dirname "$rel")/"
  if [ -f "$repo/$rel" ]; then
    cp "$repo/$rel" "$dest"
  else
    echo "  MISSING $rel"
    missing=$((missing + 1))
  fi
done

echo "synced into $here/public"
[ "$missing" -eq 0 ] || echo "  $missing file(s) missing — do not deploy, the viewer needs all of them"
