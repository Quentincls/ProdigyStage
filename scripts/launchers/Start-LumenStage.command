#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js 20 ou plus récent est requis."
  echo "  Installation : https://nodejs.org (version LTS)"
  echo "  Relancez ensuite ce fichier."
  echo ""
  open "https://nodejs.org"
  read -n 1 -s -r -p "Appuyez sur une touche pour fermer."
  exit 1
fi
export LUMENSTAGE_OPEN=1
node server/index.js
echo ""
read -n 1 -s -r -p "LumenStage s'est arrêté. Appuyez sur une touche pour fermer."
