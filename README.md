# PRODIGY STAGE

Previz, timeline et éditeur de scènes pour le show "Prodigy 12" (Bruxelles,
Place De Brouckère). Le soft écoute l'Art-Net émis par la console ChamSys et
affiche le show en 3D temps réel — puis, dans les phases futures, timeline
synchronisée au timecode et édition de scènes en man-in-the-middle.

## Où on en est (2026-07-27)

- [x] **Phase 0** — socle : monorepo, patch.json vérifié contre la doc lumière officielle, fake-show
- [x] **Phase 1** — écoute Art-Net (UDP 6454), Monitor DMX, package double-clic v0
- [x] **Phase 2** — previz 3D (32 Tamboras instanciées, bloom, 60 fps, vues 1/2/3)
- [x] **Phase 3** — mode Placement (picking 3D + champs, save patch.json), résilience, package v1
- [x] **Phase 4** — timecode Art-Net, timeline (règle/tête de lecture/marqueurs → show.json), enregistreur + replay de runs
- [x] Passe UX/UI (hover/focus/transitions, reduced-motion, layout dock fixe) — package v2
- [x] **Phase 5** — éditeur de scènes : moteur d'effets déterministe partagé `/core`
      (solid/gradient/wave/chase/sparkle), scènes+tracks dans show.json, panneau
      d'édition (groupe + effet + ≤4 réglages + fades), préécoute en boucle, scrub,
      presets. Visible en previz uniquement.
- [x] **Phase 5.5** — passe simplicité : modes Watch/Edit, menu Tools (monitor,
      placement, runs), manipulation directe sur la timeline (drag = déplacer,
      bords = trim, clic = scrub), éditeur à un look + Advanced replié, statut
      en phrases humaines.
- [x] **Passe UX profonde** — non-chevauchement aimanté (pas de multi-pistes),
      undo/redo Ctrl+Z, mini-map + Fit, blocs teintés couleur du look, poignées
      de trim, Now playing, dupliquer, raccourcis Espace/Échap.

**Le soft n'émet toujours RIEN vers le rig** — pur spectateur jusqu'à la Phase 6.

## Prochaines étapes

1. **Tests réels en attente** : lancement du zip sur le Mac du client (Gatekeeper/Node),
   premier branchement au flux console (validera le channel-map Tambora et la
   numérotation d'univers), tête de lecture calée sur MagicQ au timecode.
   Enregistrer un run complet du show sur site (bouton Record) pour développer dessus.
2. **Phase 6** — sortie Art-Net man-in-the-middle : passthrough < 5 ms, override par
   scène avec crossfade 0,5 s (le moteur /core passe côté serveur), blackout safe,
   watchdog 250 ms, mode ARMED explicite. La phase la plus sensible du projet —
   à valider en répétition sur site uniquement.
3. **Phase 7** — confort prod : headless multi-poste, undo/redo, univers 5-8,
   volumétrique beams, shadow mode.

## Prérequis

- Node.js ≥ 20 (testé avec Node 26)

## Commandes

```
npm install            # installe server + ui (workspaces)
npm run dev            # serveur (watch, web sur 4480) + UI Vite sur http://localhost:3019
npm run fake-show      # générateur Art-Net de test -> 127.0.0.1:6454, univers 1-4 + timecode 25 fps
npm run replay -- data/recordings/run-XXX.artrec  # rejoue un run enregistré
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
