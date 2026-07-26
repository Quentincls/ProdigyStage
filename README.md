# PRODIGY STAGE

Previz, timeline et éditeur de scènes pour le show "Prodigy 12" (Bruxelles,
Place De Brouckère). Le soft écoute l'Art-Net émis par la console ChamSys et
affiche le show en 3D temps réel — puis, dans les phases futures, timeline
synchronisée au timecode et édition de scènes en man-in-the-middle.

**État : Phase 3 — previz 3D + mode Placement + package v1.** Le soft écoute
l'Art-Net (UDP 6454), affiche le show en 3D temps réel (et en moniteur DMX),
et permet de replacer les machines (sauvé dans patch.json). Il n'émet rien.

## Prérequis

- Node.js ≥ 20 (testé avec Node 26)

## Commandes

```
npm install            # installe server + ui (workspaces)
npm run dev            # serveur (watch, web sur 4480) + UI Vite sur http://localhost:3019
npm run fake-show      # générateur Art-Net de test -> 127.0.0.1:6454, univers 1-4
npm run generate-patch # régénère data/patch.json depuis scripts/generate-patch.mjs
npm run build          # build serveur (tsc) + UI (vite)
npm run package        # produit dist-package/LumenStage-Previz-v1.zip (Win+Mac)
```

## Architecture

```
console ChamSys ──Art-Net UDP 6454──> /server (Node TS)
                                        │  état DMX 4x512 + stats
                                        └──WebSocket :4480 (~40 fps)──> /ui Monitor

npm run fake-show : émule la console sur 127.0.0.1 pour développer sans MagicQ.
Packagé : le serveur sert aussi l'UI buildée sur http://localhost:4480.
```

- `/server` — réception Art-Net (parser ArtDMX maison), état, pont WebSocket.
- `/ui` — moniteur DMX puis previz 3D.
- `/data/patch.json` — tout le rig en données, rechargeable à chaud. Généré
  depuis la patch list officielle (vérifiée contre le PDF lumière, p. 28-29).
- `/scripts` — générateur du patch ; lanceurs double-clic à partir de la Phase 1.
- `/docs` — conventions et architecture ([docs/architecture.md](docs/architecture.md)).

## Roadmap

Phases 0→7 décrites dans le brief maître : 0 socle · 1 écoute + monitor +
package v0 · 2 previz 3D · 3 polish + placement · 4 timecode + timeline ·
5 éditeur de scènes · 6 sortie Art-Net (man-in-the-middle) · 7 confort prod.
