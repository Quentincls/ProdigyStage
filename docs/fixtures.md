# Le parc, machine par machine

Ce que Stage sait de chaque famille, d'où ça vient, et surtout **ce qu'il ne
sait pas**. La règle de tout ce document : une information non vérifiée est
marquée comme telle et ne produit aucun contrôle dans l'interface. Un chart
inventé dessine un rig qui fait autre chose que ce qu'il fait — c'est pire que
ne rien dessiner.

## Deux questions différentes

Une confusion tenait toute l'interface en otage. Ce ne sont pas les mêmes
questions :

| Champ du profil | Question | Ce qu'il pilote |
| --- | --- | --- |
| `standardMap` | Stage peut-il **décoder** ce que la console envoie ? | la lecture, le Debug |
| `has` | Qu'est-ce que la machine **sait faire** ? | l'inspecteur, les behaviors |

Un B Panel 240WW gradue — sa fiche technique dit « 16 bit dimming » — et c'est
vrai qu'on ait trouvé son chart ou non. Donc l'inspecteur propose Intensity, la
previz l'affiche, et le Debug dit honnêtement qu'on ne sait pas lire ce que la
console lui envoie. Stage n'émet rien : éditer n'a jamais dépendu de savoir lire.

## Contrainte de la recherche

**L'environnement de développement bloque la quasi-totalité des hôtes**
(403 au CONNECT du proxy). Inaccessibles : `claypaky.it`, `ayrton.eu`,
`luxibel.com`, `smoke-factory.de`, `gdtf-share.com`, `open-fixture-library.org`,
`archive.org`, tous les agrégateurs de manuels. Seuls `github.com` et
`raw.githubusercontent.com` répondent.

Conséquence : **aucun PDF constructeur n'a pu être ouvert**. Les cartes de
canaux ci-dessous viennent de définitions communautaires (QLC+, GDTF), qui sont
de bonnes sources et pas les sources primaires. Chaque ligne dit laquelle.

## Clay Paky Tambora Batten — 61 ch

**Confirmé.** C'est la seule famille validée deux fois indépendamment.

| | |
| --- | --- |
| Mode | Standard RGBW (13 ch) + bloc pixel RGB (48 ch) = 61 |
| Source | [QLC+ `Clay-Paky-Tambora-Batten.qxf`](https://github.com/mcallegari/qlcplus/blob/master/resources/fixtures/Clay_Paky/Clay-Paky-Tambora-Batten.qxf) |
| Corroboré par | l'enregistrement console du 2026-07-27, canal par canal |

Carte : RGB 1–3, White 4, CTO 5, Strobe 6, Dimmer 7–8 (16 bit), Tilt 9–10
(16 bit, course 220°), Zoom 11, Function 12, Reset 13, pixels à partir de 14.
Zoom optique 4–35°. **Inchangée par cette passe** — elle marchait, elle n'a pas
bougé d'une ligne.

Capabilities : intensity, color, white, colourTemp, strobe, tilt, zoom, pixels.

## Clay Paky Sharpy X Frame — 43 ch

**Probable.** Une seule source, mais elle est cohérente et le compte tombe juste.

| | |
| --- | --- |
| Mode | Standard, 43 ch — le seul mode de cette machine, donc rien à départager |
| Source | [QLC+ `Clay-Paky-Sharpy-X-Frame.qxf`](https://github.com/mcallegari/qlcplus/blob/master/resources/fixtures/Clay_Paky/Clay-Paky-Sharpy-X-Frame.qxf) |

**Soustractive** : CMY (1–3) + CTO linéaire (4) + roue de 14 couleurs (6) sur une
lampe à décharge 550 W, ~8000 K. Pas d'émetteur RGB — lue en RGB elle serait
noire au moment où elle est la plus lumineuse. C'est pour ça que
`readLuminaire()` a maintenant un chemin CMY.

Dimmer 16 bit (8–9), strobe 7, iris 10, gobos 11/14–16, prismes 17–20, frost 21,
zoom 22, focus 23–24, **4 couteaux de découpe** 26–36, pan 37–38 et tilt 39–40
(16 bit, 540° / 270°). Zoom 3–52° en spot, 2–29° en beam selon le canal 25.

Capabilities : intensity, color, colourTemp, strobe, pan, tilt, zoom, focus,
iris, frost, gobo, prism, framing.

## Luxibel B Blinded1 — 4 ch

**Probable.** Et une leçon : **B BLINDED1 ≠ B BLINDED**.

Le B BLINDED (sans « 1 ») est le 2-lite : cinq modes, et son mode 4 canaux est
*deux dimmers 16 bit séparés*, sans strobe. Le B BLINDED1 est le 1-lite : trois
modes (1/2/4), un moteur 110 W warm white + ambre. Appliquer le chart de l'un à
l'autre donne une machine qui ne strobe jamais et gradue sur les mauvais canaux.

| | |
| --- | --- |
| Mode | 4 channel — le seul de ses trois modes à faire 4 |
| Source | GDTF Luxibel « B Blinded1 » (FixtureTypeID `3DB3CBC1-…`, rév. 2021-10-22) |
| Corroboré par | la fiche produit Luxibel : « 8/16 bit dimmer mode, adjustable strobe speed with random function » |

Carte : Dimmer 1, Dimmer fine 2, Shutter/Strobe 3, Dimmer speed 4.

**Piège désamorcé** : sur ce chart, `0–5 = ouvert, pas de strobe`. Sur le
Tambora, `0–3 = shutter fermé`. La même règle appliquée aux deux dessine un
blinder noir à tous les niveaux où il tourne réellement. D'où le champ
`shutterOpenFrom` dans le profil.

Optique : 50°, 2700 K nominal (~1200 K en mode tungsten). L'ambre est mélangé
par la machine elle-même à bas niveau — **il n'est adressable sur aucun canal**,
donc aucune capability couleur n'est déclarée.

Capabilities : intensity, strobe.

## Luxibel B Panel 240WW — 3 ch

**Mode certain, fonctions inconnues.**

Luxibel propose 1, 2 et 3 canaux ; un seul fait 3, donc le mode ne fait aucun
doute. Mais le chart lui-même n'a pas pu être ouvert : **`standardMap` est
absent** et Stage ne décode rien de ce que la console leur envoie.

Optique (fiche produit, via résumés de moteur de recherche — non vérifiée sur
document) : 240 LED SMD warm white, **2700 K**, CRI 95.8, **160°**, dimmer
16 bit, barndoors et porte-frost.

C'est ce 160° qui fait qu'un panel n'est plus un petit point bleu mais une
source large et douce. Et le 2700 K qui fait qu'il est ambré et pas blanc.

Warm white **fixe** : Luxibel vend le B PANEL240CW (froid) et les B PANEL180TW /
360TW (tunable) comme des produits distincts. Donc jamais de sélecteur de
couleur sur cette famille.

Capabilities : intensity.

## Ayrton Perseo Beam — 42 ch

**Non résolu.** C'est le trou de cette passe, et il est déclaré comme tel.

Aucun document Ayrton n'a pu être ouvert. Le seul GDTF Ayrton public trouvé est
le **Perseo** simple, dont le mode Extended fait 58 canaux — donc ce n'est pas
notre machine. Ni QLC+ ni Open Fixture Library n'ont d'entrée Perseo.

Ce qui est établi : le patch adresse 41/83/125/167, soit un pas franc de 42, donc
la console est bien configurée sur une personnalité 42 canaux. Le mode « Ex » est
vraisemblablement « Extended ». Et le zoom **2–42°** est publié partout, y
compris dans le nom commercial du produit.

Donc : `standardMap` absent, faisceau dessiné à la bonne largeur, rien décodé.

Capabilities déclarées (`has`) : intensity, pan, tilt, zoom — ce qu'est une
lyre beam, pas ce qu'un chart nous a dit. **Couleur non déclarée** : savoir si ce
modèle mélange en CMY ou porte une roue fixe n'a pas été établi, et un sélecteur
de couleur qui ne ferait peut-être rien est pire que pas de sélecteur.

**À faire sur site, dix minutes** : ouvrir Advanced sur un Perseo, bouger un
fader sur la console, regarder quel nombre bouge. C'est le seul endroit d'où ce
chart peut être rempli, et il est fait pour ça.

## Smoke Factory Captain D — 1 ch

**Le seul cas où une carte n'est pas une supposition** : un hazer à un canal a un
canal, et c'est le niveau de sortie. Les documents Smoke Factory n'étaient pas
accessibles non plus, mais il n'y a rien à se tromper ici.

Capabilities : fog.

## Récapitulatif

| Famille | Mode | Carte | Décodé | Dessiné comme |
| --- | --- | --- | --- | --- |
| Tambora | Standard RGBW + pixels, 61 | **confirmée ×2** | oui | barre + 16 pixels + nappe |
| X-Frame | Standard, 43 | probable (QLC+) | oui | faisceau orienté, 3–52° |
| Blinders | 4 channel | probable (GDTF) | oui | flare large 50°, chaud |
| Side Panels | 3 channel | **inconnue** | non | wash doux 160°, 2700 K |
| Beams | « Ex », 42 | **inconnue** | non | faisceau orienté, 2–42° |
| Smoke | 1 channel | triviale | oui | volume au sol |

Deux familles sur six ne sont pas décodées. Elles sont visibles, sélectionnables,
éditables et animables — parce que rien de tout cela n'exige de savoir lire la
console. Ce qu'elles ne font pas, c'est prétendre montrer ce que la console leur
demande.

## Ce que la vérification adverse a corrigé

Chaque fiche a été relue par un second agent dont la consigne était de la
**réfuter**, pas de l'approuver. Résultat honnête : les six ont été réfutées sur
le point « modèle confirmé », pour la même raison — aucun document constructeur
n'a pu être ouvert. C'est déjà écrit en haut de ce document, mais il faut le
redire : rien ici ne repose sur un PDF Claypaky, Ayrton, Luxibel ou Smoke
Factory.

Ce que la relecture a réellement apporté :

**Captain D — risque d'adressage.** Le manuel Smoke Factory (récupéré par
extraction de recherche) dit que la machine présente **deux canaux quand un
ventilateur est monté** : 1 = pompe, 2 = ventilateur. Nos six hazers sont
patchés à une adresse d'écart — u5/501-502 et u8/1-4 — donc si un ventilateur
est monté, le canal 2 d'une machine est le canal 1 de la suivante. Quatre
collisions calculées. Rien n'est émis, donc rien ne peut être endommagé : la
previz lirait la soufflerie d'un hazer comme la sortie d'un autre. **Un coup
d'œil aux machines tranche plus vite que n'importe quel document.**

**Perseo — course mécanique absente, exprès.** Le profil déclare `pan` et `tilt`
sans `panRangeDeg`/`tiltRangeDeg`. La capability vient de ce qu'est la machine ;
la course, elle, demanderait un document. Éditer marche sans (un layer vise dans
la salle), décoder en aura besoin.

**Perseo — chiffre corrigé.** Le mode Extended du Perseo simple compte 58 canaux
d'après notre propre lecture de son `description.xml` ; un jeu de données tiers
donne 61 pour le Perseo *Profile*. Les deux disent la même chose pour nous : ce
n'est pas 42, donc ce n'est pas notre machine.

**X-Frame — deux réserves.** Le Sharpy X Frame **FD** pourrait partager le même
footprint 43 canaux, et la machine embarque des réducteurs de faisceau qui
descendent à **0,5°** — le cône dessiné ne les modélise pas.

**Tambora — angle de faisceau discuté.** QLC+ donne 4–35°, le marketing Claypaky
4–50°, des revendeurs 4–53°. Nous affichons 4–35°, la valeur du fichier
réellement lu.

## Vérifier la réception sur site

`Tools → Diagnostics` affiche une ligne par famille :

```
Tambora       32  receiving on 1, 2, 3, 4     reads intensity/color/.../tilt/zoom/pixels
Side Panels   16  SILENT on 6, 7              NOT DECODED — channel chart unconfirmed
Beams          4  receiving on 5              NOT DECODED — channel chart unconfirmed
```

Deux colonnes, deux problèmes différents, et les confondre coûte un après-midi :

- **SILENT** = rien n'arrive sur cet univers. C'est un câble, un patch console,
  ou un univers que la console n'émet pas. Se règle côté console.
- **NOT DECODED** = ça arrive, mais Stage n'a pas la carte des canaux. Aucun
  re-patch n'y changera rien ; ça se règle dans Advanced, un fader à la fois.
