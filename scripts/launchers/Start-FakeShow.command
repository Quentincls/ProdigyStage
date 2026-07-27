#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required: https://nodejs.org"
  open "https://nodejs.org"
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
echo "Console simulator: plays a test show on universes 1-4."
echo "Also launch Start-LumenStage to watch it in the previz."
echo ""
node server/fake-show.js
