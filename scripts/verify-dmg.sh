#!/usr/bin/env bash
# Verify the app inside a built DMG is validly ad-hoc signed, including the
# unpacked native helpers that codesign --deep does not traverse.
set -euo pipefail
dmg="$1"
mount=$(mktemp -d)
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -quiet
trap 'hdiutil detach "$mount" -quiet || true' EXIT
app="$mount/Nectar.app"

codesign --verify --deep --strict --verbose=2 "$app"
signature=$(codesign -d --verbose=4 "$app" 2>&1)
if ! grep -q '^Signature=adhoc$' <<<"$signature"; then
  echo "::error::expected an ad-hoc signed app"
  exit 1
fi
while IFS= read -r -d '' binary; do
  if file -b "$binary" | grep -q 'Mach-O'; then
    codesign --verify --strict --verbose=2 "$binary"
  fi
done < <(find "$app" -type f -print0)
echo "OK: $app is validly ad-hoc signed"
