# ADR-003 : `playsound` entre dans la liste blanche, les effets passent par `execute as @a`

**Statut :** Proposé (à valider par Mathys)
**Date :** 22 juillet 2026
**Décideur :** Mathys
**Amende :** ADR-001, décision D4 (ne la remplace pas)

---

## Contexte

La décision D4 fixe une liste blanche de commandes Minecraft : uniquement des
commandes stables depuis des années, identiques sur les deux cibles de
compatibilité (Paper 1.21.11 et Paper 26.2). `particle` y figure, `playsound`
non.

Le cimetière (`packages/renderer`, ADR D7 : « jamais de rendu 1:1 des jobs sauf
les failed, max 50 ») pose une pierre tombale par job échoué. À l'apparition
d'une tombe on veut un effet — des âmes qui s'échappent et une cloche —, ce qui
demande `particle` (autorisé) **et** `playsound` (non autorisé). Étendre la
liste blanche sans preuve serait exactement le genre de dérive que D4 existe
pour empêcher.

Deux vérifications ont donc été faites avant d'écrire une ligne de rendu.

**1. Documentation, sur les deux cibles.** La syntaxe
`playsound <sound> [<source>] [<targets>] [<pos>] [<volume>] [<pitch>] [<minVolume>]`
est inchangée depuis 1.20.5 (24w09a), où `source` et `targets` sont devenus
optionnels. Les changelogs 26.1 et 26.2 ne touchent ni `playsound` ni
`particle` — 26.1 ajoute `/swing`, `/fetchprofile`, `/time of clock` ; 26.2
ajoute `/unpublish`, `execute on owner`, les couleurs d'équipe en snake_case.
Les 11 valeurs de `source` sont les mêmes (`ui` existe depuis 1.21.6, donc dans
les deux). `minecraft:block.bell.use` existe depuis 1.14 (18w50a), sans
renommage. `minecraft:soul` est inchangé. `minecraft:cobblestone_wall` (1.13) et
`minecraft:deepslate` (1.17) portent les mêmes identifiants dans les deux
versions ; le seul renommage repéré en 26.1 concerne des identifiants de
*recettes*, pas de blocs.

**2. Le serveur, en vrai.** `packages/renderer/src/probe.ts` envoie ces
commandes à un serveur Paper 1.21.11 et lit sa réponse. Toutes acceptées —
y compris le composant de texte à `extra` qui porte l'épitaphe en deux tons.

La sonde a aussi mis au jour un piège que la documentation présente à
l'envers. Sur un serveur **sans joueur connecté** — le cas normal pour
Queuecraft, dont le monde est un affichage que personne n'habite :

```
particle minecraft:soul …    →  « The particle was not visible for anybody »
playsound … master @a …      →  « No player was found »
```

Le tableau « Result: Successful » de la page wiki de `particle` est faux sur ce
point (MC-123440). Ces deux commandes **échouent** et polluent la console du
serveur à chaque échec de job. Un cimetière qui se remplit produirait alors des
centaines de lignes d'erreur par minute sur le serveur de quelqu'un d'autre.

---

## Décision

**1. `playsound` rejoint la liste blanche de D4.** Preuve de stabilité
documentée ci-dessus, preuve d'exécution par `probe.ts`. La liste devient :

> `setblock` · `fill` · `summon` · `data get|merge|modify` · `kill` · `tp` ·
> `bossbar` · `scoreboard` · `tellraw` · `particle` · **`playsound`** ·
> `forceload` · `time` · `gamerule` · `execute` (formes simples)

**2. Tout effet destiné à un joueur passe par `execute … as @a[…] run`.**
Jamais `particle` ni `playsound` nus. Forme imposée :

```
execute positioned <x> <y> <z> as @a[distance=..40] run particle minecraft:soul <x> <y> <z> … force @s
execute positioned <x> <y> <z> as @a[distance=..40] run playsound minecraft:block.bell.use master @s <x> <y> <z> 2 1.6
```

Quand personne n'est connecté, le sélecteur ne matche rien, la branche
s'éteint : **réponse vide, aucune erreur, aucune ligne de console**. Le coût
reste d'exactement une commande RCON, connecté ou non — ce qui rend le budget
D7 prévisible indépendamment de la présence d'un joueur.

Corollaire à ne pas perdre : une réponse RCON **vide** est un succès. Le
détecteur de refus de `RconSink` (`REJECTION`) ne la compte pas comme un rejet,
et la sonde a un prédicat dédié (`silent`).

**3. « Formes simples » de `execute` : la définition.** D4 autorisait
`execute` « formes simples » sans les nommer. On fige la liste des modificateurs
employés par le renderer, et on s'interdit les autres sans nouvel ADR :
`positioned`, `as`, `at`, `if entity`, `if block`. Pas de `store`, pas de
`facing`, pas de `on`, pas d'imbrication au-delà de trois modificateurs.
`check-pure.ts` vérifie en plus que la commande **portée** par un
`execute … run` est elle-même dans la liste blanche : sans ce contrôle,
l'enveloppe serait un trou dans la discipline D4.

**4. Le spectacle est plafonné à un effet par gare et par tick.** Une rafale de
dix échecs dans le même tick de 500 ms ne produit qu'une cloche et qu'un nuage
d'âmes. Le diff porte ce plafond (`effect: boolean` sur la mutation `grave`),
pas le code d'envoi : c'est donc vérifiable sans serveur.

---

## Conséquences

**Budget.** Une tombe coûte 1 commande en régime saturé (réécriture d'un
emplacement recyclé) ou 2 sur un emplacement vierge, plus 2 pour l'effet, une
seule fois par gare et par tick. Mesuré sur un run de 3 min à `FAIL_RATE=25`
avec trois queues (`SEED=4242`, Paper 1.21.11-132, 23/07/2026) : le burst de
démarrage est throttlé au plafond de 40 cmd/s (rasage + décor + pool, ~150
commandes — premier rendu cher explicitement permis par l'ADR-002), puis
**~10–18 cmd/s soutenu en régime, ~30 cmd/s en surge, pics 1 s touchant le
plafond, 0 commande refusée**. Budget D7 (40) tenu.

**Latence « échec → tombe ».** Sur le même run, 377 échecs : **médiane 0,58 s,
p95 0,92 s, pire 2,51 s**. Le pire cas n'est pas le rendu — le tick qui a posé
cette pierre a fait 9 ms de travail réel, le reste est l'attente du token
bucket pendant une surge qui sature les 40 cmd/s. Une tombe dessinée dans un
tick non throttlé est dans le monde en < 100 ms. Le tail de latence, c'est donc
le budget non négociable qui prime sur le « détail plaisir » du < 2 s, pas un
défaut du cimetière. La cible de 2 s est tenue à p95 ; l'exception est la
coïncidence d'un échec et d'une surge des trois gares.

**Ce que ça n'autorise pas.** `weather`, `title`, `stopsound`, `item` et le
reste ne sont toujours pas dans la liste. Le thunderstorm de
`docs/world-design.md` reste à instruire par son propre ADR — `weather` n'a pas
été vérifié sur 26.2, et `gamerule` est déjà refusé par Paper 1.21.11-132.

**Ce qui reste à mesurer.** `probe.ts` n'a tourné que sur Paper 1.21.11. Le
lancer sur 26.2 (`spikes/rcon-benchmark/README.md`) avant de considérer la
compatibilité comme prouvée plutôt que documentée.
