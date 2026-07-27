# PRODIGY STAGE — contexte pour Claude

Previz/timeline/éditeur de scènes pour le show "Prodigy 12" (Bruxelles, De
Brouckère). Une console ChamSys joue le show au timecode et émet l'Art-Net du
rig ; ce soft l'écoute, l'affiche en 3D, et permet de créer des scènes.
Utilisateurs : une équipe SANS light designer — la simplicité radicale est une
exigence produit ("n'importe qui change une couleur en 2 clics").

## Règles absolues

1. **Le soft n'émet RIEN vers le rig** tant que la Phase 6 (man-in-the-middle)
   n'est pas développée et validée en répétition sur site. Pur spectateur.
2. **Développement par phases avec validation utilisateur** — ne jamais
   déborder de la phase demandée. Récap de fin + STOP.
3. **Tout est data-driven** : patch dans `data/patch.json` (vérifié contre la
   doc lumière officielle), scènes/presets/marqueurs dans `data/show.json`.
   Aucune adresse DMX en dur dans le code.
4. **Simplicité UI avant tout** : anglais, sombre, pas d'emojis, aucune notion
   DMX visible dans l'éditeur, une action primaire par écran, le complexe
   sous "Advanced". Références : Figma, Linear, iMovie (timeline).
5. Les scènes ne se chevauchent JAMAIS (règle produit, `ui/src/sceneRules.ts`).
6. Moteur d'effets partagé dans `/core` : pur TS, zéro dépendance,
   déterministe vs timecode (`npm run test:core` doit passer).

## État (2026-07-27)

Phases 0–5 + passes UX terminées : previz 3D 60 fps (32 Tambora, bloom),
Monitor DMX, mode Placement, timecode Art-Net + timeline (manipulation
directe, mini-map, undo Ctrl+Z), enregistreur/replay de runs, éditeur de
scènes (5 effets, presets, préécoute), modes Watch/Edit + menu Tools.
Testé chez le client (Mac) le 2026-07-27. Channel-map et univers **validés
sur le premier enregistrement console réel** (2026-07-27) : mode Tambora
« Standard RGB » 61 ch identifié (RGBW global ch 1–4, dimmer 7–8, tilt
mécanique 9–10 — voir docs/architecture.md). La previz suit couleur,
intensité et tilt. Reste : calibrer le sens du tilt sur vidéo salle,
enregistrement d'un run timecodé du vrai show, puis **Phase 6** :
émission Art-Net (passthrough < 5 ms, SPECTATOR/ARMED avec hold 1 s,
BLACKOUT, watchdog 250 ms, crossfade 0,5 s) — la phase la plus sensible.

Lire `README.md` (état + roadmap) et `docs/architecture.md` (conventions,
formats, pièges) avant toute modification.

## Commandes

- `npm install` puis `npm run dev` (serveur 4480 + UI Vite 3019)
- `npm run fake-show` — simule la console (Art-Net + timecode 25 fps)
- `npm run test:core` — self-test du moteur d'effets (doit passer)
- `npm run build` — tsc serveur + vite UI (doit passer avant tout commit)
- `npm run package` — zip client (nécessite le PC Windows local, pas le cloud)

## Sessions cloud (depuis le téléphone)

Tu peux : modifier le code, la doc, les données ; builder ; lancer test:core.
Tu ne peux pas : voir la previz, tester l'UDP/Art-Net en réel, produire le
zip Livrables (PC local requis). Toujours `npm run build` + `npm run
test:core` verts avant de committer. Commits atomiques, messages clairs.
