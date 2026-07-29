# Le coût d'une image

Ce document existe parce que « ça rame depuis les nouvelles fixtures » était une
hypothèse raisonnable et fausse, et qu'il a fallu la mesurer pour le savoir. Il
note ce qui a été mesuré, comment, et ce que ça a changé — pour que la prochaine
fois la question se tranche en dix minutes.

**Règle** : ne jamais optimiser ce qui n'a pas été mesuré, et ne jamais échanger
de la qualité d'image contre des images par seconde sans le prouver au pixel.

## L'instrument

`ui/src/perf.ts` — des compteurs mutables écrits sur le chemin chaud, lus une
fois par seconde. Rien là-dedans n'alloue, ne s'abonne, ni ne provoque de rendu.

Deux familles de nombres, et la différence compte quand on lit un rapport venu
d'une autre machine :

- **indépendants du matériel** — draw calls, triangles, instances, rendus React,
  lectures de fixtures, octets sur la socket, vraies lumières Three.js. Ils sont
  identiques partout, donc comparables entre un Mac et un conteneur ;
- **dépendants du matériel** — fps et toute milliseconde. Ils n'ont de sens qu'à
  côté d'une autre mesure prise sur la même machine.

Deux façons de le lire :

- **Shift+P** dans l'application : l'overlay, en direct, avec les interrupteurs.
  C'est un instrument, pas un réglage : rien n'est mémorisé, recharger remet
  tout en place.
- **Tools → Diagnostics** : les mêmes nombres en texte, à copier-coller.

## Ce que la mesure a dit

Conteneur, rendu logiciel (swiftshader), 1280x780, orbite continue, console à
40 Hz. Les fps absolus ne valent que les uns par rapport aux autres.

### Les nouvelles familles ne coûtent rien

| Patch | fps | draw calls | triangles | instances |
| --- | --- | --- | --- | --- |
| Tambora seules (32) | 3,8 | 33 | 2 370 | 652 |
| + Side Panels (48) | 3,6 | 34 | 2 562 | 668 |
| + Blinders (58) | 4,1 | 34 | 2 682 | 678 |
| + Beams (62) | 3,9 | 34 | 2 730 | 682 |
| + X-Frame (64) | 4,2 | 34 | 2 754 | 684 |
| + Smoke — tout (70) | 3,9 | 34 | 2 826 | 690 |

38 machines de plus : **+1 draw call, +456 triangles, +38 instances**. Elles
tiennent dans un seul `InstancedMesh`. `git diff` le confirme indépendamment :
la seule chose que le travail « fixtures » a ajoutée au rendu est ce mesh. Le
bloom et la haze étaient déjà là.

### Ce n'est ni React, ni l'entrée, ni l'état

| Mesure | Valeur |
| --- | --- |
| rendus React | ~1/s par composant (App, Previz, WatchBar, LightPicker), Timeline 2/s |
| trames DMX | 40/s, 160 Ko/s |
| temps de lecture d'une trame | ~25 µs (0,1 % d'une seconde) |
| lectures de fixtures | ~320/s — indexées sur les fps du viewport, pas sur le DMX |
| notre JS par image | 0,3–0,5 ms console branchée, **0,06 ms débranchée** |
| console débranchée | **fps inchangés** |
| viewport seul vs interface complète | **fps inchangés** |

L'architecture demandée existait déjà : une socket, des `Uint8Array` mutables,
React prévenu à 1 Hz par `useSyncExternalStore`, et le viewport qui lit l'état
dans sa propre boucle. Une valeur DMX qui change ne provoque aucun rendu React.

### C'est le remplissage

Même scène, même caméra, résolutions différentes :

| Résolution | Mpx | fps |
| --- | --- | --- |
| x1 | 0,824 | 4,0 |
| x0,7 | 0,403 | 7,3 |
| x0,5 | 0,206 | 11,9 |
| x0,35 | 0,101 | 18,0 |
| x0,25 | 0,052 | 21,7 |

Les pixels de moitié, les images du double : le budget d'une image est en
**pixels**, pas en objets. 34 draw calls et 2 826 triangles ne ralentissent
aucune carte graphique ; 14 passes plein écran, si.

Qui les paie, à résolution constante :

| | fps | draw calls |
| --- | --- | --- |
| tel que livré | 4,0 | 34 |
| sans bloom | 12,0 | 20 |
| sans haze | 4,4 | 30 |
| sans bloom ni haze | 13,9 | 16 |

**Le bloom, c'est 14 des 34 draw calls et les deux tiers du temps.**

> Prudence : ce classement-là dépend du matériel. Un rasteriseur logiciel et un
> GPU ne paient pas les mêmes choses — le mélange additif de 96 nappes
> transparentes en demi-flottant coûte proportionnellement plus cher sur un GPU
> intégré qu'ici. D'où les interrupteurs de l'overlay : la question se retranche
> en dix secondes sur la machine concernée.

## Les corrections

Toutes vérifiées au pixel contre une console figée (même trame, même caméra,
`scratchpad/hold.mjs`), une variable à la fois.

| Correction | Gain | Différence d'image |
| --- | --- | --- |
| Bloom calculé à demi-résolution | +56 % fps | 1,0 % des pixels, écart moyen **0,30/255**, pire 38/255 |
| `antialias: false` sur le renderer | mémoire + un resolve/image | **0 pixel sur 824 320** |
| Un seul `applyPatch` au démarrage | 1 reconstruction au lieu de 2 | aucune |
| Halos re-uploadés seulement s'ils bougent | ~2 Ko/image de moins vers le GPU | aucune |
| Zéro allocation dans la boucle | 156 → 103 Ko/s de tas | aucune |

Total mesuré : **3,9 → 6,6 fps** à 70 fixtures, soit **+69 %**, sans que l'image
change ailleurs que dans le dégradé du halo.

### Pourquoi le bloom peut être calculé plus petit

`EffectComposer` redimensionne toutes les passes à la taille de l'image. Pour un
flou, c'est payer plein tarif pour quelque chose qui va être étalé sur cinq
niveaux de mip. La scène, les émetteurs et l'image finale restent à pleine
résolution ; seule la lueur autour d'eux est calculée sur une grille plus
petite. Une lueur est précisément la seule chose de cette image qui ne peut pas
montrer la différence — et elle ne la montre pas.

### Pourquoi `antialias` ne servait à rien

`EffectComposer` crée ses propres cibles de rendu, non multi-échantillonnées. La
scène n'a donc jamais été anticrénelée : le tampon MSAA du canvas ne recevait
que le quad plein écran final, où il n'y a aucun bord à lisser. Il était alloué
et résolu à chaque image pour une image identique au bit près.

## Ce qui n'a pas été fait, et pourquoi

- **Baisser le `devicePixelRatio`** — c'est le plus gros levier restant et c'est
  une vraie perte de qualité. Le curseur `resolution` de l'overlay permet de
  juger sur pièces ; la décision appartient à l'opérateur, pas au code.
- **Enlever la haze ou le bloom** — c'est le rendu, pas un coût accidentel.
- **Instancing, workers, autre renderer** — 34 draw calls n'ont besoin de rien
  de tout ça. Le problème n'a jamais été le nombre d'objets.

## Refaire les mesures

```
npm run build && node server/dist/index.js
node scratchpad/hold.mjs        # une console constante, pour comparer des images
node scratchpad/profile.mjs families|switches|console|viewport
```

Ou, sur la machine qui rame : **Shift+P**, puis couper le bloom, couper la haze,
descendre la résolution — et noter les fps à chaque étape.
