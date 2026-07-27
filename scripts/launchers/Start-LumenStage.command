#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js 20 or newer is required."
  echo "  Install the LTS version from https://nodejs.org"
  echo "  then launch this file again."
  echo ""
  open "https://nodejs.org"
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
export LUMENSTAGE_OPEN=1
node server/index.js
echo ""
read -n 1 -s -r -p "LumenStage stopped. Press any key to close."
