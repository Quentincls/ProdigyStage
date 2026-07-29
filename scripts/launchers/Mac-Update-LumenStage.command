#!/bin/bash
# Downloads and installs the latest LumenStage build in place. Everything in
# data/ (scenes, presets, recordings, fixture placements) is left untouched.
set -u
cd "$(dirname "$0")"

URL="${LUMENSTAGE_UPDATE_URL:-https://github.com/Quentincls/ProdigyStage/releases/latest/download/LumenStage-Previz-v3.zip}"

pause_and_exit() {
  if [ -t 0 ]; then
    echo ""
    read -n 1 -s -r -p "Press any key to close."
    echo ""
  fi
  exit "$1"
}

main() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/LumenStage-update.XXXXXX")" || pause_and_exit 1
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading the latest version..."
  if ! curl -fL --retry 3 -o "$tmp/LumenStage.zip" "$URL"; then
    echo ""
    echo "Download failed. Check the internet connection and try again."
    pause_and_exit 1
  fi

  echo "Installing..."
  if command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$tmp/LumenStage.zip" "$tmp/new"
  else
    unzip -o -q "$tmp/LumenStage.zip" -d "$tmp/new"
  fi
  if [ ! -f "$tmp/new/LumenStage/server/index.js" ]; then
    echo "The downloaded file looks incomplete. Nothing was changed."
    pause_and_exit 1
  fi

  # App code is replaced wholesale; data/ is the user's and is never
  # overwritten (new data files are only added if missing).
  rm -rf server ui node_modules
  cp -R "$tmp/new/LumenStage/server" "$tmp/new/LumenStage/ui" "$tmp/new/LumenStage/node_modules" .
  cp "$tmp/new/LumenStage/README.html" README.html
  [ -f "$tmp/new/LumenStage/version.txt" ] && cp "$tmp/new/LumenStage/version.txt" version.txt
  mkdir -p data
  for f in "$tmp/new/LumenStage/data/"*; do
    [ -e "data/$(basename "$f")" ] || cp "$f" data/
  done
  # One exception, and it is the whole point of that file. patch.json belongs
  # to the operator and is never touched; patch.reference.json is this build's
  # own statement of what it knows about the rig, so it must always be the new
  # one. Left alone, an install that updated once would keep an old build's
  # fixture knowledge for ever -- new channel charts, beam angles and
  # capabilities would download and then never arrive.
  cp "$tmp/new/LumenStage/data/patch.reference.json" data/patch.reference.json 2>/dev/null || true
  # Launchers gained a Mac-/Windows- prefix: drop the old unprefixed names so
  # the folder never shows two files with the same visible name. Deleting the
  # script we are running from is safe on macOS -- it is already open.
  rm -f Start-LumenStage.command Start-FakeShow.command Update-LumenStage.command \
    Start-LumenStage.bat Start-FakeShow.bat Update-LumenStage.bat
  for f in "$tmp/new/LumenStage/"*.command "$tmp/new/LumenStage/"*.bat; do
    [ -e "$f" ] && cp "$f" .
  done
  chmod +x ./*.command 2>/dev/null

  echo ""
  echo "Update complete."
  [ -f version.txt ] && cat version.txt
  echo "If LumenStage was running, close it and start it again."
  pause_and_exit 0
}

main
