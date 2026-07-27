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

## Timecode + timeline (Phase 4)

- ArtTimeCode (0x9700) reçu sur le même socket UDP ; état dans le listener,
  fenêtre d'activité 1,5 s. Frame binaire passée en v2 (`0x02`) : + 6 octets
  timecode (receiving, h, m, s, frames, fpsType). Abstraction future MTC/LTC :
  remplacer la source dans `listener.ts` (l'UI ne connaît que la frame).
- Timeline canvas (`ui/src/Timeline.tsx`) : règle adaptative, tête de lecture
  (verte LIVE / orange REPLAY), zoom molette + pan drag, suivi auto de la tête
  (pause 4 s après interaction). Marqueurs de sections dans `data/show.json`
  (GET/POST `/api/show`), auto-save debounce 600 ms.
- Enregistreur (`recorder.ts`) : tap brut sur tous les paquets Art-Net reçus →
  `data/recordings/run-*.artrec` (gzip, frames `[u32 deltaMs][u16 len][pkt]`,
  ~6 Ko/s) + sidecar `.json` (durée, nb paquets). Contrôlé par l'UI
  (`/api/record`) ; liste via `/api/recordings`.
- Replay : `replayer.ts` réémet vers 127.0.0.1:6454 avec le timing d'origine
  (streaming + backpressure, pas de fichier en mémoire). Depuis l'UI
  (`/api/replay`) ou `npm run replay -- <file>`. Le serveur reste un pur
  spectateur du rig : le replay ne sort jamais de la machine.

## Éditeur de scènes (Phase 5)

- Moteur d'effets partagé dans **`/core/effects.ts`** : pur TS, zéro
  dépendance, déterministe vs timecode (un même instant rejoue le même rendu,
  sparkle inclus via hash entier). 5 primitives (solid, gradient, wave,
  chase, sparkle), ≤ 4 paramètres chacune, métadonnées `EFFECTS` qui génèrent
  l'UI. Tourne dans le navigateur ET dans Node (`node core/selftest.ts`,
  script `npm run test:core`) — le serveur le branchera en Phase 6.
- Modèle (`data/show.json`) : `scenes[]` = plage timecode + `tracks[]`
  (cible wall-left/right/both + effet + params + fadeIn/fadeOut) ;
  `presets[]` = tracks nommés réutilisables. Priorité : pixel couvert par la
  scène active → effet ; sinon flux console (fait dans PrevizScene, une seule
  passe pixels + glow).
- Temps effectif (`ui/src/editor.ts`) : preview loop > scrub (drag sur la
  règle) > timecode live. Vignettes d'effets animées dans l'éditeur, tout est
  auto-sauvé (même debounce que les marqueurs). Aucune notion DMX visible.
- Toujours AUCUNE émission réseau : les scènes ne se voient que dans la previz.

## UX (passe profonde) — règles et navigation

- **Pas de multi-pistes : les scènes ne se chevauchent JAMAIS** (règle produit,
  `ui/src/sceneRules.ts`). Une seule ligne, bords aimantés (snap 0,5 s aux
  voisines, grille 1 s / 0,1 s zoomé, durée min 1 s). Création/duplication via
  `findFreeSlot` (premier créneau libre ≥ 5 s). À tout instant, au plus une
  scène remplace la console.
- **Undo/redo** (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) sur show.json, 100 états,
  coalescence 400 ms (un drag de slider = un seul pas). Raccourcis : Espace =
  préécoute de la scène sélectionnée, Échap = preview > panneau > outil.
- **Navigation timeline** : mini-map sous la timeline (étendue totale du show,
  scènes en ticks colorés, fenêtre de vue draggable, clic = saut), bouton Fit,
  drag vide = pan, scrub réservé à la règle (curseur crosshair), molette = zoom,
  molette horizontale = pan.
- **Lisibilité** : blocs de scène teintés de la couleur du look principal,
  poignées de trim sur le bloc sélectionné, badge « ▶ nom » sous le timecode
  quand une scène est active, hint « Press + Scene… » quand la timeline est
  vide, Dupliquer + confirmation avant Delete.

## UX (Phase 5.5) — deux modes, un tiroir

- **Watch** (défaut) : previz plein écran + timecode + timeline lecture seule.
  Zéro bouton d'édition — l'écran qu'on laisse tourner en régie.
- **Edit** : timeline interactive avec **manipulation directe** (référence
  iMovie/FCP) : drag d'un bloc scène = déplacer, drag de ses bords = trim
  (curseur ew-resize au survol), clic sur zone vide ou la règle = scrub,
  shift+drag = pan, molette = zoom, molette horizontale = pan. Snap 1 s
  (0,1 s zoomé). `+ Scene` est LA action primaire.
- **Tools (⚙)** : DMX monitor (page overlay), Placement, Runs (record/replay)
  — sortis du chrome principal, usage occasionnel.
- **SceneEditor simplifié** : presets d'abord (« Start from a preset »), UN
  look visible (murs + effet + ≤4 réglages), tout le reste sous « Advanced »
  (fades, looks superposés, gestion des presets, delete). Vocabulaire
  « Look », plus de « Track » visible.
- **Statut en phrases** : « Console connected — nothing is sent » /
  « Waiting for the console… ». Les métriques (pkt/s, IP) vivent dans le
  DMX monitor. La Phase 6 branchera SPECTATOR/ARMED/BLACKOUT sur ce même
  emplacement (hold 1 s pour armer, bannière watchdog).

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
  **Confirmé sur le vrai flux console (enregistrement venue du 2026-07-27)** :
  les Tambora sortent sur les port-addresses 0–3 (= show 1–4). La console
  émet aussi les port-addresses 4–15 (reste du rig) — ignorées, conforme.

## Patch (data/patch.json)

Généré par `npm run generate-patch` (source : `scripts/generate-patch.mjs`).
Vérifié le 2026-07-26 contre la PATCH LIJST officielle
(III_LIGHT_DOCU_LIGHT_BXL_PDF, p. 28–29) : adresses Standard
001/062/123/184/245/306/367/428, PixelRGB = Standard + 13, heads 1–16 (L)
sur univers 1–2, heads 101–116 (R) sur univers 3–4.

**Validé sur le premier enregistrement réel (run du 2026-07-27, 147 s de
looks manuels à la console)** — l'hypothèse initiale (dimmer=1, strobe=2)
était fausse :

- Standard ch 1–3 = **RGB global de la machine**. C'est ce que l'opérateur
  pilote (couleurs de picker limpides dans les données : 255,105,180 hot
  pink, 0,255,0, 255,0,255…) et ce que la salle voit. La previz et le
  Monitor affichent donc ce RGB global (`standardMap: {red, green, blue}`).
- Standard ch 5–10 = moteur d'effets **interne** de la machine (valeurs qui
  balaient en continu). Non émulé par la previz — limitation connue : un
  chase interne machine ne s'anime pas à l'écran, la couleur reste juste.
- Zone pixel (14–61) : présente sur le fil mais **parquée** (105,255,255
  constant) par la programmation console actuelle — jamais animée.

Points encore ouverts : sémantique exacte des ch 4–13 (à confronter au
chart DMX officiel du mode utilisé sur la console), et comportement de la
zone pixel pendant le show timecodé (à revérifier sur un enregistrement du
vrai show — le run du 27/07 ne contenait ni timecode ni cues). Implication
Phase 6 : pour être visibles sur les vraies machines, nos scènes devront
sans doute émettre sur les ch 1–3 par machine (résolution = 1 couleur par
batten) plutôt que sur la zone pixel, tant que le mode console est celui-ci.

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
