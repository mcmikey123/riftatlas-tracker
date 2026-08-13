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
  share/repaint.js \
  share/clipboard.js \
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

# Exit non-zero so `./sync-assets.sh && wrangler deploy` stops here. Saying "do
# not deploy" and then exiting 0 left the shell free to deploy anyway, and a
# missing module surfaces only as "viewer modules missing" in a recipient's
# browser - the one place nobody is watching.
if [ "$missing" -ne 0 ]; then
  echo "  $missing file(s) missing — do not deploy, the viewer needs all of them"
  exit 1
fi
