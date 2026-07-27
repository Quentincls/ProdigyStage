# Architecture & conventions

## Flux (cible)

```
                 ┌──────────────────────────────┐
 ChamSys console │        /server (Node)        │      /ui (navigateur)
 ──ArtDMX UDP──> │ parser ArtDMX -> état 4x512  │ ──WS état consolidé ~40 fps──> Monitor / Previz 3D
      6454       │ (Phase 6: merge + réémission)│
                 └──────────────────────────────┘
```

Un seul process serveur, persistance 100 % fichiers JSON (`data/`).

## Pont serveur → UI (Phase 1)

- HTTP + WebSocket sur le port **4480** (`server/src/web.ts`). Le serveur sert
  aussi l'UI buildée (`ui/dist` en repo, `ui/` en package) et `/api/patch` :
  GET relit patch.json à chaque requête (hot reload gratuit), POST l'écrit
  (mode Placement, validation minimale de forme).
- Frame binaire ~40 fps : `[0x01, nbUnivers, puis par univers: id, actif(0|1),
  512 octets DMX]` (2058 octets). Stats JSON à 1 Hz : pkt/s par univers,
  IP source, état du socket UDP, trafic des autres univers.
- Actif = au moins un paquet reçu dans les 2 dernières secondes.
- UI : les buffers DMX restent hors React (canvas + requestAnimationFrame) ;
  React ne re-rend qu'à 1 Hz sur les stats. Reconnexion WS auto (1 s) +
  watchdog anti-veille : connexion silencieuse > 5 s = morte → close forcé
  → reconnexion (le serveur parle au moins 1×/s).

## Previz & Placement (Phases 2-3)

- `ui/src/previz/PrevizScene.ts` (Three vanilla) : pixels et battens en
  InstancedMesh, bloom UnrealBloomPass, glow additif au sol, vues 1/2/3
  (tween basé horloge, indépendant du framerate). Les meshes de fixtures
  sont reconstructibles à chaud (`applyPatch`) pour le mode Placement.
- Placement : picking par raycast sur les battens (clic sans drag < 5 px),
  sélection teintée en bleu, panneau à champs numériques (fixture seule ou
  déplacement groupé par centroïde), Save = POST /api/patch. Aucune notion
  DMX dans l'UI de placement.
- Les touches 1/2/3 sont ignorées quand le focus est dans un champ.

## Packaging v0 (`npm run package`)

`dist-package/LumenStage/` : `server/` (JS compilé) + `ui/` (build Vite) +
`data/patch.json` + `node_modules/ws` + lanceurs `Start-LumenStage.bat/.command`
et `Start-FakeShow.bat/.command` + `README.html` (doc client 1 page, anglais).
Zip écrit avec mode 0755 sur les `.command` (double-clic macOS préservé).
Les lanceurs vérifient Node ≥ 20 (sinon ouvrent nodejs.org). `LUMENSTAGE_OPEN=1`
fait ouvrir le navigateur par le serveur une fois le port 4480 prêt.
Copie automatique du zip vers `Desktop\Livrables`.

## Univers

- Univers "show" 1–4 = les 32 Tambora Batten (MVP). 5–8 = reste du rig,
  hors périmètre jusqu'à décision contraire.
- Sur le réseau, l'adresse de port Art-Net commence à 0 : univers show N
  = univers Art-Net N-1 (convention MagicQ par défaut). Réglable en un seul
  point : `SHOW_TO_ARTNET_OFFSET` dans `server/src/artnet.ts`.
  **À confirmer sur le vrai flux console (Phase 3/4bis).**

## Patch (data/patch.json)

Généré par `npm run generate-patch` (source : `scripts/generate-patch.mjs`).
Vérifié le 2026-07-26 contre la PATCH LIJST officielle
(III_LIGHT_DOCU_LIGHT_BXL_PDF, p. 28–29) : adresses Standard
001/062/123/184/245/306/367/428, PixelRGB = Standard + 13, heads 1–16 (L)
sur univers 1–2, heads 101–116 (R) sur univers 3–4.

Reste une hypothèse (Phase 3/4bis, sur vraies données) : l'ordre interne des
13 canaux Standard et l'ordre RGB des pixels. Corrigeable en data via
`fixtureTypes.*.standardMap` / `pixelOrder` sans toucher au code.

## Géométrie

- +X le long de la salle, x=0 au milieu des murs de battens, côté scène/arche
  en X négatif (L1/R1 sont côté scène — hypothèse à confirmer, la patch list
  ne donne pas les positions).
- +Y vers le haut, +Z du mur gauche vers le mur droit.
- `rotation` en degrés Euler [rx, ry, rz] ; ry=0 regarde +Z (mur gauche vers
  la tribune), ry=180 regarde -Z (mur droit vers la tribune).
- Conformément au LICHTPLAN (p. 5), chaque mur est une ligne **continue** de
  16 battens jointifs (~16 m), à 6 m de hauteur, murs espacés de 12 m.
  (Le brief initial supposait 32 m espacés — le plan officiel prime.)
  Affinage via l'UI de placement en Phase 3.

## Décisions

- Parser ArtDMX écrit à la main (format trivial, pas de lib abandonnée).
- Pas de base de données, pas de framework backend. WebSocket via `ws`.
- UI anglais, sobre, sombre. Aucune notion de canal DMX visible côté éditeur.
