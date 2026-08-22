#!/usr/bin/env bash
#
# Headless Chrome with a debugging port, for scripts/demo/capture.mjs.
#
# A throwaway profile every time: a reused one carries the previous run's
# cookies, and a stale session is worse than none because the capture then films
# a signed-out page without failing.
set -euo pipefail

PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new \
  --remote-debugging-port=9222 \
  --disable-gpu \
  --hide-scrollbars \
  --user-data-dir="$PROFILE" \
  about:blank
