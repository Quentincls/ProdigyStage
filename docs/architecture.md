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

## UX (passe hiérarchie, 2026-07-27)

Retour client : « la hiérarchie des informations est incompréhensible ».
Corrections structurelles, pas cosmétiques :

- **Previz** : les vues sont des **directions** (`VIEWS[].dir`), la distance
  vient de la sphère englobante du rig et du ratio du viewport
  (`measureRig` / `frameDistance` / `applyView`). Avant : positions en dur
  qui cadraient mal et laissaient les murs sortir du champ. Reframe au
  resize sauf si l'opérateur a bougé la caméra (`userMoved`). Barres
  éteintes en `#2b313b` : le rig ne disparaît plus quand la console noircit.
- **Transport** (`editor.ts`) : `live` / `paused` / `playing` / `preview`.
  `pauseAt` fige, `playLocal` fait tourner la timeline sur l'horloge locale
  (relire un show console éteinte), `seekTo` respecte l'état courant.
  Un seul contrôle pour revenir au direct : le bouton LIVE (l'ancien
  « Back to live » du dock faisait doublon, supprimé).
- **Bibliothèque de looks** (`ui/src/presets.ts`) : 12 presets livrés,
  vignettes rendues par le vrai moteur (`LookThumb`). Une install neuve
  n'avait aucun preset — l'éditeur ouvrait sur le vide.
- **Panneau de scène** — quatre zones, dans l'ordre de lecture : identité
  (nom + plage + durée), **une** action primaire pleine largeur (Preview),
  `LOOK` (look courant en grand + « Change » qui déplie la bibliothèque),
  `ADJUST` (murs + paramètres), puis Advanced. Le sélecteur de type
  d'effet est passé sous Advanced : deux façons concurrentes de choisir un
  look côte à côte obligeaient à deviner laquelle utiliser.
- Sections séparées par un filet (`.panel-group`), menu Tools sur sa propre
  élévation (il flotte au-dessus du panneau, même surface = illisible), avec
  titre + une ligne d'explication par entrée, et « Live output » isolé sous
  un séparateur avec un badge ON quand il émet.
- **Une scène = au plus un look par mur.** `renderScenePixel` applique le
  *dernier* track qui correspond au mur : deux looks sur « both » et le
  second masquait totalement le premier — on pouvait donc ajouter des looks
  strictement invisibles. L'UI n'expose plus « ajouter un look » mais
  « donner un look différent à chaque mur » (split/merge, 1 ou 2 tracks).
- Nouvelles scènes nommées « At 0:11 » (leur position dans le show) plutôt
  que « Scene 3 », et champ nom avec placeholder « Name this moment ».
- **Rendu** : tone mapping ACES + bloom élargi (1,45 / 0,75 / 0,12) et un
  halo additif face caméra par machine (`updateHalos`, billboard reconstruit
  chaque frame, taille pilotée par l'intensité). Les barres se voient
  désormais comme de la lumière dans l'air, pas comme des plans émissifs.

## Sortie Art-Net — man-in-the-middle (Phase 6)

**Tout ce qui émet vers le rig vit dans `server/src/output.ts`, et nulle part
ailleurs.** Le fichier est écrit pour être sûr par construction, dans cet
ordre :

1. **Démarre en `off`** : le socket UDP n'est même pas créé.
2. **Aucune cible par défaut** : `data/output.json` absent = `targets: []`.
   Une install non mise en service ne *peut pas* atteindre un rig, quoi que
   clique l'utilisateur. Mettre en service = écrire l'adresse du rig dans ce
   fichier (ou via Advanced dans le panneau Live output).
3. **Anti-boucle** : une cible loopback sur notre propre port d'écoute est
   refusée (elle réinjecterait dans notre listener).
4. **`spectator`** relaie la console octet pour octet ; seul **`armed`**
   substitue nos scènes ; **`blackout`** force des zéros.
5. **Watchdog 5 s** : plus de trame console = on cesse d'émettre, pour ne
   jamais figer le rig sur notre dernière image. Exception voulue : en
   `blackout` on continue d'émettre des zéros à 25 Hz (une sécurité doit
   fonctionner même console morte).

### Le débit console n'est pas le débit du show (piège, corrigé le 2026-08-03)

Une console n'émet pas en continu : elle émet quand elle a quelque chose à
dire. Posée sur un look statique, la ChamSys retombe à **~1 trame/s par
univers** (l'Art-Net n'exige un rafraîchissement d'une donnée inchangée que
toutes les 4 s). Deux conséquences, toutes deux constatées en salle :

- un watchdog à 250 ms lisait ce lien parfaitement sain comme mort pendant
  la quasi-totalité de chaque seconde (« LIGHTS — on hold, no console
  signal » alors que la console était là, en vert, juste au-dessus) ;
- émettre **uniquement à la réception** échantillonnait **nos propres
  animations** au rythme de la console : une scène qui scintille sortait à
  1 fps pendant que la previz la montrait à 60. La previz ne mentait pas sur
  la scène, c'est le fil qui la ralentissait.

Donc : le seuil du watchdog se lit contre le rafraîchissement **au repos**,
et en `armed` on rafraîchit le rig sur **notre** horloge
(`ARMED_REFRESH_MS = 25`, soit 40 Hz, juste sous le plafond Art-Net de
44 Hz). Trames console et horloge partagent un budget par univers
(`lastSentAt`) : une console à plein régime ne se retrouve pas doublée.

Deux propriétés à ne pas casser, chacune tenue par un test :

- **`spectator` n'a pas d'horloge.** Une trame console entrée = exactement
  une trame sortie. C'est ce qui rend le passthrough auditable.
- **Rendre à nouveau n'est pas re-merger.** Un merge fond *vers* la trame
  console ; le réappliquer sur un tampon déjà fondu ferait monter un
  crossfade à mi-course jusqu'au plein à chaque rafraîchissement, et le fondu
  de 0,5 s deviendrait une coupe. D'où `raw` (dernière trame console intacte)
  séparé de `buffers` (ce qu'on a émis) : **chaque émission repart de `raw`**,
  donc le centième rafraîchissement d'une trame est identique au premier.
- Et l'horloge ne survit jamais au lien : `refresh()` ne fait rien si le
  watchdog est déclenché, sinon un timer rejouerait éternellement notre
  dernière image — précisément ce que le watchdog promet d'empêcher.

Émission **à la réception** (plus l'horloge ci-dessus quand `armed`) : le
passthrough coûte une passe de merge, mesurée et exposée (`passthroughUs`).
Mesuré ici : **~0,2 ms au pire**, budget 5 ms.

### La cible ne doit pas être la console (piège, salle, 2026-08-03)

Le champ « Lighting network address » avait été réglé sur l'IP **de la
console**. Chaque trame fusionnée repartait donc vers le pupitre qui venait
de l'envoyer, le rig n'entendait rien — et le panneau annonçait joyeusement
des trames en sortie, puisqu'il y en avait. Le logiciel connaissait déjà
l'adresse d'où arrivent les trames console : il ne s'en servait pas.
`targetsPointingAtTheConsole()` (UI) compare les deux et le dit, dans
Diagnostics et dans le panneau Live output. **Avertissement, pas blocage** :
une install où le nœud et le pupitre partagent une adresse est le problème
de quelqu'un, pas quelque chose à interdire.

### Recevoir ne prouve pas qu'on peut émettre

Corollaire du même aveuglement, ajouté le 2026-08-03. Une console qui diffuse
en broadcast atteint **toutes** les machines du câble, y compris une dont
l'adresse est sur un autre sous-réseau : un Mac resté en DHCP, ou retombé sur
une auto-attribuée 169.254.x.x, entend tout le show parfaitement et ne peut
répondre à rien — l'unicast vers le nœud n'a pas de route, les trames meurent
dans le noyau, et l'écran affiche du vert partout.

Le serveur rapporte donc ses propres adresses IPv4 (`localAddresses()`,
lecture locale via `node:os`, aucun accès réseau) et l'UI compare
(`ui/src/net.ts`, pur, testé par `npm run test:net`). Règle de ce module :
`onOurNetwork()` renvoie `null` quand il ne peut pas savoir (serveur plus
ancien, cible qui n'est pas une IPv4, broadcast) et **le null est un
silence, jamais un défaut** — accuser à tort le réseau devant un rig éteint
coûte plus cher que de se taire. `output.lastError` (EHOSTUNREACH & co) est
également remonté dans le panneau.

Merge (`mergeUniverse`, pure et testée) : base = trame console, puis pour
chaque batten couvert par une piste de la scène active — RGB ← couleur de la
scène, blanc ← 0, dimmer ← plein, shutter ← ouvert, le tout fondu par
`crossfadeMix` (0,5 s en entrée et en sortie, symétrique). **Tilt et zoom
sont délibérément laissés à la console** : le mouvement continue de tourner,
notre scène ne fait que repeindre. Un mur non ciblé n'est jamais écrit.

Résolution : **une couleur par batten** (ch 1–3 + dimmer), puisque la console
est en mode « Standard RGB ». La previz, elle, rend 16 pixels par batten :
sur un effet à gradient fin, l'écran est donc plus détaillé que la salle.
À corriger le jour où la console passera en mode pixel, ou en aplatissant la
previz quand `armed`.

Le moteur `/core` est un **workspace npm** (`@prodigy-stage/core`) : le
serveur l'importe compilé (`core/dist`), l'UI importe la source (hot reload
Vite). Conséquence en dev : après une modif de `core/effects.ts`, relancer
`npm run build -w core` pour que le serveur la voie (`npm run dev` le fait
au démarrage).

Tests sans rig ni console : `npm run test:output` (sécurité, fidélité du
passthrough, merge, watchdog, latence) et le banc complet documenté dans
`README.md` (fake-show + sink UDP + scène armée).

## Compose et la direction artistique

Trois responsabilités, jamais mélangées :

| Qui | Sait | Fichier |
| --- | --- | --- |
| l'analyse | **quand** — beats, barres, sections, énergie | `server/src/audio.ts` |
| l'intention | **pour quoi** — palette, mood, énergie, mouvement, densité | `core/vocabulary.ts` |
| le compositeur | **comment** — quel effet, à quelle vitesse, sur quelle barre | `server/src/compose.ts` |

La direction artistique (`server/src/direction.ts`) écrit **uniquement des
intentions**. Elle reçoit la structure trouvée par l'analyse plus le brief de
l'opérateur, et renvoie pour chaque chapitre une palette, un mood, une énergie
(avec rampe), un mouvement, une densité, des familles de looks, un nom et une
phrase d'explication. Elle ne voit jamais une barre, n'écrit jamais une scène,
et ne déplace jamais une frontière : la composition reste produite par
`compose.ts`, de façon déterministe, à partir de ce qu'elle a proposé. C'est
ce qui préserve la garantie dont dépend Regenerate — même intention, même show.

- Modèle `claude-opus-5`, `thinking: adaptive`, réponse contrainte par un JSON
  schema **généré depuis `core/vocabulary.ts`** : ajouter une palette la rend
  disponible au modèle le jour même, sans toucher à ce fichier.
- `applyDirection()` est pur et testé sans réseau (`npm run test:audio`) :
  mot inconnu, mauvais type, nombre hors bornes, section manquante ou
  renumérotée — la proposition la plus fausse possible ne peut pas casser un
  draft. C'est la porte d'entrée, donc c'est elle qu'on teste.
- **Optionnelle et inerte sans clé.** Pas de clé (`data/direction.json` ou
  `ANTHROPIC_API_KEY`) = la fonctionnalité n'est pas proposée et Compose
  retombe sur `defaultIntent()`. `direction.ts` est le seul module qui parle à
  l'extérieur de la machine ; comme `output.ts`, garder cette propriété.
- La clé n'est jamais renvoyée à l'UI : `status()` ne dit que `configured` et
  d'où elle vient.

## Packaging v0 (`npm run package`)

`dist-package/LumenStage/` : `server/` (JS compilé) + `ui/` (build Vite) +
`data/patch.json` + les dépendances runtime avec leur fermeture transitive
(`copyPackage()` dans `scripts/package.mjs` — les nommer à la main marchait
avec `ws` seul et devient un piège dès qu'il y en a deux, un paquet oublié
n'étant pas une erreur de build mais un `ERR_MODULE_NOT_FOUND` en salle)
+ lanceurs `Windows-*.bat` / `Mac-*.command`
(Start/FakeShow/Update) + `README.html` (doc client 1 page, anglais).
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

**Mode identifié : Tambora Batten « Standard RGB », 61 canaux** — croisement
du chart DMX officiel (08.2021, corroboré par la définition QLC+) et du
premier enregistrement réel (run du 2026-07-27, 147 s de looks manuels).
L'hypothèse initiale (dimmer=1, strobe=2) était fausse. Bloc Standard :

| ch | fonction | previz |
|----|----------|--------|
| 1–3 | Rouge, Vert, Bleu (machine entière) | affiché |
| 4 | Blanc | additionné au RGB |
| 5 | CTO | ignoré (à faire si besoin) |
| 6 | Strobe (0–3 = noir, sinon ouvert/flash) | gate noir/ouvert, flashs non simulés |
| 7–8 | Dimmer + fin (16 bits) | appliqué |
| 9–10 | Tilt + fin (16 bits, mécanique, 220° de course) | barres animées en 3D |
| 11 | Zoom | ignoré |
| 12–13 | Function / Reset | ignorés |
| 14–61 | 16 pixels RGB (Pixel Engine) | ignorés (parqués par la console) |

Preuves dans l'enregistrement : couleurs de picker limpides sur ch 1–3
(255,105,180 hot pink…), dimmer 7/8 monté 0→255 à t=9 s et redescendu à
t=134 s (début/fin de session), tilt 9/10 balayant en continu (FX de tilt
console — les « mouvements » vus en salle sont mécaniques).

Points encore ouverts : sens et zéro du tilt (calibrer sur une vidéo salle
+ enregistrement synchrones), simulation des flashs de strobe, CTO, et
comportement de la zone pixel pendant le show timecodé (le run du 27/07 ne
contenait ni timecode ni cues — à revérifier sur un enregistrement du vrai
show). Implication Phase 6 : pour être visibles sur les vraies machines,
nos scènes devront sans doute émettre sur les ch 1–3 + dimmer par machine
(résolution = 1 couleur par batten) tant que la console reste dans ce mode.

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


## Light layers sur le fil (2026-08-03)

Jusqu'ici seules les **Scenes** pouvaient sortir, et seulement vers les deux murs.
Un light layer se voyait dans la previz et n'atteignait jamais la salle — donc
« je modifie dans le soft » ne modifiait rien.

Le chemin est maintenant complet, et il reste dans le seul module qui émet :

```
LightLayer → renderLayerIntent (/core) → FixtureIntent
                                           ↓
                        writeFixture (/core/fixtures.ts)
                                           ↓
                    mergeLayerUniverse (output.ts) → Art-Net
```

`writeFixture()` est le miroir exact de `readFixture()`, et vit au même endroit
pour la même raison : un seul fichier sait ce que veut dire un canal, et il doit
le savoir **dans les deux sens** ou les deux vont diverger.

### La règle qui fait toute la sécurité

**Un profil sans `standardMap` n'écrit rien.** Pas des zéros, pas une
supposition : rien, et il le dit en retournant `false`. Les Side Panels et les
Perseo Beams sont donc physiquement inatteignables — il n'y a pas d'adresse où
écrire. Ce n'est pas une vérification que quelqu'un doit penser à ajouter, c'est
l'absence de donnée qui fait le travail. Et le jour où l'un des deux charts est
relevé sur site, la famille devient pilotable sans aucune autre modification.

Vérifié dans `output-selftest` : un layer qui nomme explicitement ces deux
familles ne change **pas un octet**, sur les quatre univers.

### Ce qui n'est jamais écrit

Seuls les canaux que le profil déclare. Gobos, prismes, couteaux de découpe,
iris, macros : laissés exactement comme la console les envoie. Prendre la main
sur une couleur ne remet jamais à zéro les blades d'une lyre.

### Priorité

`preview > layer > scene > console`, identique à l'écran et sur le fil — c'est
ce qui garantit que la salle montre ce que la previz montre.
