#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 ou plus récent est requis : https://nodejs.org"
  open "https://nodejs.org"
  read -n 1 -s -r -p "Appuyez sur une touche pour fermer."
  exit 1
fi
echo "Simulateur de console : envoie un show de test sur les univers 1-4."
echo "Lancez aussi Start-LumenStage pour le voir dans le Monitor."
echo ""
node server/fake-show.js
