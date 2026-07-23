# ADR-002 : Débit RCON réel — D3 corrigé, D7 confirmé, pipelining interdit

**Statut :** Proposé (à valider par Mathys)
**Date :** 22 juillet 2026
**Décideur :** Mathys
**Amende :** ADR-001, décisions D3 et D7 (ne les remplace pas)

---

## Contexte

L'ADR-001 a été écrit *avant* toute mesure. Deux de ses affirmations sur RCON
étaient des estimations présentées comme des faits :

- **D3** : « on hérite des limites de RCON : lent (quelques dizaines de
  commandes/seconde) ».
- **D7** : « Budget cible : < 40 commandes/seconde en régime de croisière »,
  justifié par « RCON plafonnant à quelques dizaines de commandes/seconde ».

Le spike `spikes/rcon-benchmark` a mesuré la réalité le 22/07/2026, sur les deux
cibles de compatibilité de D4 (Paper 1.21.11 et Paper 26.2), serveur local sans
joueur, monde plat. Médiane de 3 runs :

| Mesure | 1.21.11 | 26.2 |
|---|---|---|
| Séquentiel, 1 connexion | 1 213 cmd/s | 1 433 cmd/s |
| Soutenu 10 s, 1 connexion | 2 673 cmd/s | 2 341 cmd/s |
| Soutenu 10 s, 4 connexions | 10 184 cmd/s | 9 782 cmd/s |
| 2+ commandes « en vol » (pipelining) | connexion fermée | connexion fermée (dès 3) |

Les chiffres étant invraisemblables au premier abord (>1 000 cmd/s là où on
attendait 20), ils ont été contrôlés : `src/verify-effects.ts` repose 300 blocs
puis relit le monde un par un via `execute if block`. **300/300 présents.** Les
commandes sont réellement exécutées, le débit n'est pas un artefact de mesure.

Pourquoi si rapide ? L'hypothèse « le serveur exécute une commande par tick,
donc 20/s » est fausse : un serveur au repos passe l'essentiel de ses 50 ms de
tick à ne rien faire, et vide la file de commandes en continu. La latence
mesurée (0,7 ms aller-retour) est celle d'une boucle locale, pas d'un tick.

---

## Décision

**1. D3 est corrigé sur les faits.** RCON n'est pas « lent ». Sur les deux
cibles, une seule connexion soutient ~2 300–2 700 commandes/seconde. La phrase
« quelques dizaines de commandes/seconde » de l'ADR-001 est erronée d'environ
deux ordres de grandeur et ne doit plus être citée comme justification.

**2. D7 est confirmé, mais sa justification change.** Le budget de 40 cmd/s
est tenu avec un facteur 58 de marge. On **le garde quand même**, pour trois
raisons qui n'ont rien à voir avec la capacité du canal :

- Les mesures viennent d'un serveur **au repos, sans joueur**. Un serveur réel
  a beaucoup moins de temps libre par tick ; la marge observée est un plafond
  théorique, pas une garantie.
- Chaque commande consomme du temps sur le fil principal du serveur. Un
  renderer qui envoie 2 000 cmd/s ne « tient » pas : il vole les ressources du
  serveur qu'il est censé observer.
- Le diffing et l'agrégation restent la bonne architecture indépendamment du
  débit disponible : ils rendent le rendu lisible et le coût prévisible.

Autrement dit : le budget de 40 cmd/s passe du statut de **contrainte
technique subie** à celui de **discipline choisie**. Il ne bouge pas.

**3. Le pipelining est interdit.** Envoyer plusieurs commandes sans attendre
la réponse sur une même connexion fait fermer la connexion par le serveur :
dès 2 commandes en vol sur 1.21.11, dès 3 sur 26.2. Ce n'est pas une lenteur,
c'est une rupture. Toute connexion RCON doit être pilotée **strictement une
commande à la fois**.

**4. Le parallélisme, s'il en faut un jour, passe par plusieurs connexions.**
Chacune séquentielle. Le débit monte linéairement (4 connexions ≈ ×4). À
n'utiliser que si une raison précise l'exige — le budget D7 ne le demande pas.

---

## Conséquences

**Ce que ça change pour le renderer.** Une seule connexion RCON suffit très
largement, pilotée en série. La bibliothèque `rcon-client` doit être
configurée avec `maxPending: 1` — sa valeur par défaut, plus élevée, casse la
connexion. Un listener `rcon.on('error')` est obligatoire : quand le serveur
coupe, l'écriture suivante émet un `EPIPE` **asynchrone** qu'aucun `try/catch`
ne rattrape, et qui tue le process Node.

**Ce que ça ne change pas.** Le diffing, l'agrégation (1 minecart = N jobs,
lampes en échelle log), le plafond de 50 tombes et la boucle à 2 Hz de D7
restent tels quels. La règle non négociable n°2 du CLAUDE.md est inchangée.

**Ce que ça ouvre.** La marge réelle permet d'envisager sereinement des choses
que D7 aurait interdites par prudence : redessiner intégralement une zone
plutôt que de la patcher finement, ou tolérer un premier rendu coûteux au
démarrage (le run à froid mesuré à 332 cmd/s reste 8× le budget). À décider au
cas par cas, sans toucher au budget de croisière.

**Ce qui reste à mesurer.** Tout ceci vaut pour un serveur vide. Refaire le
benchmark avec un joueur connecté et un monde chargé avant de s'appuyer sur la
marge pour une décision de design. Tant que ce n'est pas fait, la marge est
une observation, pas un budget.

---

## Amendement du 23 juillet 2026 — la mesure « reste à faire » est faite

Le point ci-dessus est résolu. Le spike a été relancé **en conditions
réalistes** : monde du dashboard rendu (`demo:traffic --render`, renderer v1 —
3 gares, 36 minecarts + 48 villagers à IA), générateur de trafic en croisière,
**1 joueur connecté** devant la gare. Mêmes scénarios, mêmes builds
(1.21.11-132, 26.2-65), médiane de 3 runs. Détail et tableau avant/après :
`spikes/rcon-benchmark/README.md`.

> Renderer **v1** (v2 n'existe qu'en spec). Ses entités à IA ticként plus que
> les `*_display` inertes de v2 : la charge est donc **plus lourde** que le v2
> cible. Les chiffres sont un **proxy conservateur** — une borne basse de marge.

**Ce que la charge fait au débit.** Dégradation > 50 % sur 7 des 8 cases
mesurées. Sur la seule métrique qui décrit le renderer (soutenu 10 s, **une**
connexion en série) :

| | Serveur vide | Sous charge (médiane) | Marge vs 40 cmd/s |
|---|---|---|---|
| 1.21.11 soutenu 1 conn | 2 673 cmd/s | **688 cmd/s** | ×17,2 |
| 26.2 soutenu 1 conn | 2 341 cmd/s | **1 478 cmd/s** | ×37 |

**La marge ×58 était un artefact du repos.** En croisière réelle elle tombe à
**×17** (pire version). Pire : les scénarios latency-bound (rafale courte, JIT
froid, tick surchargé) descendent bien plus bas — médiane de A à **×1,9**, et
**un run isolé sur 26.2 est passé sous le budget** (7,5 cmd/s, 133 ms/commande,
×0,19). Le canal n'a plus 58× de mou ; par moments, il en a moins d'un.

**D7 (40 cmd/s) ne bouge pas — et sort renforcé.** La décision D7 de cet ADR
gardait le budget comme *discipline choisie*, pas comme plafond subi, en pariant
justement que « un serveur réel a beaucoup moins de temps libre par tick ». La
mesure confirme le pari :

1. Le régime de rendu réel (soutenu, 1 connexion) garde une marge confortable
   (×17 minimum) : **40 cmd/s reste tenable sous charge.**
2. Mais la marge est **instable et peut s'évaporer en rafale** — d'où
   l'obligation, inchangée, de diffing + agrégation. Ce ne sont pas des
   optimisations de confort : ce sont ce qui garde le rendu sous le budget les
   mauvais ticks, quand le canal ne pardonne plus.
3. Le **premier rendu** (froid, latency-bound) est le moment le plus exposé.
   La tolérance déjà accordée par cet ADR à un « premier rendu coûteux » doit
   se lire à la lumière de ces 7,5 cmd/s : au démarrage, sous charge, on est
   *au niveau* du budget, pas 8× au-dessus.

Aucune valeur de D7 ne change, donc pas de nouvel ADR : ceci amende les
**données** et la **marge** de l'ADR-002, pas ses décisions. La phrase « la
marge est une observation, pas un budget » est levée : la marge est mesurée,
et le budget de 40 cmd/s la respecte avec de la réserve en croisière.
