# Le pipeline console → écran (état avant extension du rig)

Document de la **Phase 1** de l'extension au parc complet de PRODIGY 12 :
comment une valeur DMX voyage aujourd'hui de la console jusqu'au pixel affiché,
et **où exactement le code suppose qu'il n'existe qu'un seul type de machine**.

Rien n'a été modifié pour écrire ce document. Le filet de sécurité qui
l'accompagne est `server/src/pipeline-selftest.ts` (`npm run test:pipeline`,
inclus dans `npm test`) : 204 assertions qui figent le comportement Tambora
actuel. Vérifié en cassant volontairement le patch — le test échoue.

## 1. Le trajet d'un octet

```
console ChamSys
   │  ArtDMX / ArtTimeCode, UDP 6454
   ▼
listener.ts            parse, 4 buffers de 512 octets, stats, fenêtre d'activité 2 s
   │                   onRaw  → recorder.ts    (enregistrement brut)
   │                   onFrame→ output.ts      (Phase 6, muette par défaut)
   ▼
index.ts               encodeFrame() : une trame binaire v2 toutes les 25 ms
   │                   [0x02][n][par univers: id, actif, 512 octets][timecode]
   ▼  WebSocket :4480
feed.ts (UI)           universes: Map<number, Uint8Array>, active: Map<number, boolean>
   │                   version++ à chaque trame
   ▼
PrevizScene.ts         updateColors()  → couleur de chaque pixel
                       updateTilt()    → orientation de chaque barre
```

Trois choses seulement traversent tout : **le numéro d'univers**, **512 octets**,
et **un drapeau « actif »**. Aucune notion de machine ne circule — l'UI
reconstruit tout à partir de `patch.json`.

### Univers

La console numérote à partir de 1, Art-Net à partir de 0.
`SHOW_TO_ARTNET_OFFSET = -1` dans `artnet.ts` est le seul endroit qui le sait.
Confirmé sur l'enregistrement réel : les Tambora sortent sur les port-addresses
0–3. La console émet aussi 4–15 (le reste du rig) — comptées dans `otherPps`
puis jetées, parce que `ArtnetListener` n'a que quatre buffers.

### Silence ≠ zéro

`isActive(universe)` = un paquet reçu il y a moins de 2 s. **Cette distinction
est vitale** : un univers que personne n'envoie arrive quand même rempli de
zéros, et zéro est une vraie valeur DMX (une extrémité de la course de tilt, un
shutter fermé, du noir). Le previz a longtemps lu ces zéros comme des données
et pointait tous les battens à 110° du niveau, console éteinte. Corrigé le
2026-07-28 ; toute nouvelle famille devra faire la même distinction.

## 2. Où vit la connaissance « Tambora »

| Fait | Fichier | Forme |
| --- | --- | --- |
| adresses, univers, groupe, position | `data/patch.json` | données |
| carte des canaux (RGBW, dimmer, tilt…) | `data/patch.json` → `standardMap` | données |
| 61 canaux, 16 pixels, pixelStart 14 | `data/patch.json` → `fixtureTypes` | données |
| course de tilt 220°, sens | `data/patch.json` → `tiltRangeDeg`, `tiltInvert` | données |
| **comment lire ces canaux** | `PrevizScene.updateColors()` | **code** |
| **comment écrire ces canaux** | `output.ts` → `mergeUniverse()` | **code** |

Les deux dernières lignes sont le sujet de la Phase 2 : la traduction
octets → état est écrite deux fois, dans deux langages d'intention différents,
et aucune des deux n'est testable isolément.

### Lecture — `PrevizScene.updateColors()`

Pour chaque pixel (32 × 16 = 512 emplacements), un `PixelSlot` pré-calculé au
chargement du patch porte les index **absolus** dans le buffer de son univers
(`address - 1 + standardMap[x] - 1`). Puis, par trame :

```
si une scène de l'éditeur couvre ce pixel  → couleur du moteur /core
sinon                                       → couleur de la console :
    intensité = dimmer16 / 65535            (7–8)
    si strobe ≤ 3 → intensité = 0           (6, shutter fermé)
    blanc     = W / 255                     (4)
    rvb       = min(1, canal/255 + blanc) × intensité   (1–3)
```

Deux résolutions coexistent : si la personnalité déclare un RGB machine entière
(`globalRgb`), la scène est rendue **une couleur par batten** et non par pixel —
« honnêteté de résolution », la previz ne peut pas être plus fine que la salle.

La zone pixel (14–61) n'est lue que pour les personnalités sans RGB global.
Sur le vrai show elle est parquée par la console.

### Orientation — `PrevizScene.updateTilt()`

`tilt`/`tiltFine` (9–10) → 16 bits → `(raw/65535 − 0,5) × 220°`, mi-course =
niveau. Depuis le 2026-07-28, **seulement si l'univers est actif** ; sinon les
machines se reposent sur l'angle « Aim » réglé dans le viewport. Barre, pixels
et nappe de brume sont posés depuis une seule matrice (`poseFixture`).

### Écriture — `output.ts`

`mergeUniverse()` repeint une machine : RVB, blanc à 0, dimmer et shutter
ouverts, **tilt et zoom jamais touchés** (la console garde le mouvement).
Inerte sans `data/output.json`.

## 3. Ce qui casse dès la deuxième famille

Trouvé en lisant, pas en supposant :

1. **`output.ts:173`** — `patch.fixtureTypes[patch.fixtures[0].type]` : *la
   première machine du patch décide de la carte des canaux de tout le rig*.
   Avec un seul modèle c'est correct ; avec six, la carte Tambora serait
   appliquée à un Perseo.
2. **`ArtnetListener`** n'alloue que les univers passés au constructeur —
   `SHOW_UNIVERSES = [1,2,3,4]` dans `index.ts`. Les univers 5–8 sont reçus,
   comptés, jetés.
3. **La trame binaire v2** encode `SHOW_UNIVERSES.length` univers. Passer à 8
   double sa taille (4 KB à 40 Hz) — à mesurer, pas à supposer.
4. **`PrevizScene`** dessine une seule géométrie (une barre + 16 pixels) pour
   tout le monde, et `wallPos` suppose que chaque groupe est une ligne
   continue. Un Perseo n'est ni une ligne ni un mur.
5. **`patch.groups`** sert à deux choses à la fois : le câblage physique
   (mur gauche / mur droit) et la cible d'un effet (`target: 'left' | 'right' |
   'both'`). Les groupes logiques du brief (§7) sont une troisième notion, à
   ne pas confondre avec ces deux-là.
6. **`sceneRules.ts` / le moteur `/core`** raisonnent en position normalisée le
   long d'un mur. Une famille ponctuelle (4 Perseo) demandera une autre notion
   de position.

## 4. Ce que le filet de sécurité fige

`server/src/pipeline-selftest.ts`, dans l'ordre du trajet d'un octet :

1. **le fil** — ArtDMX se parse, univers Art-Net N−1 = univers show N, un
   paquet étranger est refusé ;
2. **l'adressage** — les 32 battens aux adresses de la PATCH LIJST
   (1/62/123/184/245/306/367/428), L1–L8 sur l'univers 1 … R9–R16 sur le 4,
   blocs de 61 canaux qui tiennent dans 512 sans se chevaucher ;
3. **la carte des canaux** — les 13 fonctions du bloc Standard, écrites en dur
   dans le test d'après le chart officiel ;
4. **la lecture** — une trame construite pour L5 se relit exactement aux index
   attendus, sans déborder sur L6, et tilt 128/0 vaut le niveau ;
5. **l'écriture** — `mergeUniverse` peint le rouge, ouvre dimmer et shutter, et
   **laisse tilt et zoom intacts** ; sans scène, la trame ressort octet pour
   octet identique ;
6. **le silence** — un univers sans paquet n'est jamais actif.

Les attentes viennent de `data/patch.json` et du document lumière, jamais du
code testé : modifier le code fait échouer le test au lieu de le suivre.

## 5. Le rig complet, d'après le document lumière

Relevé sur `III_LIGHT_DOCU_LIGHT_BXL` (31 pages, PATCH LIJST p. 28–29,
LICHTPLAN p. 5). Les Tambora y sont confirmés au caractère près.

| Heads | Machine | Univers | Adresses | Mode | Ch |
| --- | --- | --- | --- | --- | --- |
| 1–16, 101–116 | Clay Paky Tambora Batten | 1–4 | 1/62/123/184/245/306/367/428 | Standard (+ PixelRGB à +13) | 61 |
| 201–210 | Luxibel B Blinded1 | 5 | 1, 5, 9 … 37 | 4 Channel | 4 |
| 601–604 | Ayrton Perseo Beam | 5 | 41, 83, 125, 167 | Ex | 42 |
| 501–502 | Clay Paky Sharpy X Frame | 5 | 401, 451 | 43ch | 43 |
| 301–308 | Luxibel B Panel 240WW (gauche) | 6 | 1, 11 … 71 | 3ch | 3 |
| 401–408 | Luxibel B Panel 240WW (droite) | 7 | 1, 11 … 71 | 3ch | 3 |
| 701–706 | Smoke Factory Captain D | 5 et 8 | 501–502 / 1–4 | 1ch | 1 |

Absents du patch officiel : les **5 Astera Titan Tube** (DMX sans fil, adressés
sur la console) et les **Luxibel B Flood** (éclairage de service, courant
seulement). Il faudra une configuration explicite pour les premiers, comme le
demande le brief — ne rien deviner.

### Géométrie relevée sur le LICHTPLAN

Mesurée par détection des symboles sur un rendu 300 dpi. Les distances sont
données en **pas de batten** (entraxe de deux Tambora) : c'est un rapport, donc
vrai quelle que soit l'échelle absolue, qui reste elle à confirmer en salle.

- 32 Tambora, deux lignes de 16 bordant la tribune, longueur 16 pas,
  **écartement des deux murs : 9,86 pas** (`generate-patch.mjs` en met 12) ;
- 16 B Panel, 8 par côté, à ~1 pas à l'intérieur de chaque mur ;
- 2 X-Frame, ~0,66 pas à l'extérieur de chaque mur, au niveau du premier batten ;
- 10 Blinded1 en deux rangs symétriques, 3,6 et 4,8 pas côté scène, trou au
  centre ;
- 4 Perseo sur l'arche, ~8 pas côté scène ;
- 5 Astera : 3 sur la ferme haute (~6,2 pas), 2 dans le trou central.

Aucune hauteur d'accroche dans le document : les 6 m de `patch.json` restent
une hypothèse.

## 6. Les trois états, aujourd'hui

Le brief (§17–18) demande de séparer explicitement `consoleState`,
`editorState`, `previewState`, `outputState`. Aujourd'hui :

- **consoleState** existe : `feed.universes` côté UI, les buffers du listener
  côté serveur ;
- **editorState** existe : `editor.scenes` + le moteur `/core`, évalué au
  temps donné par `effectiveShowTime()` ;
- **previewState** n'est pas un état séparé — c'est `editorState` évalué à un
  temps local (preview, scrub) plutôt qu'au timecode ;
- **outputState** existe côté serveur seulement, dans `output.ts`.

L'arbitrage est fait pixel par pixel dans `updateColors()` : une scène qui
couvre le pixel gagne, sinon la console. C'est simple et ça marche pour une
famille ; c'est le point à formaliser avant d'en ajouter six.
