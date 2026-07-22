# ADR-001 : Fondations de Queuecraft

**Statut :** Proposé (à valider par Mathys)
**Date :** 22 juillet 2026
**Décideur :** Mathys
**Amendé par :** [ADR-002](ADR-002-debit-rcon-reel.md) — D3 et D7, sur la foi des mesures du spike RCON

---

## Comment lire ce document

Un **ADR** (Architecture Decision Record) est un document court qui grave une décision technique : le contexte, ce qu'on choisit, ce qu'on écarte, et ce que ça implique. On l'écrit *avant* de coder pour ne pas re-débattre des mêmes choix dans six mois. Celui-ci est l'ADR de fondation : il regroupe les 9 décisions structurantes du projet. Les termes techniques sont expliqués à leur première apparition, et un glossaire récapitule tout à la fin.

---

## Le projet en une phrase

**Queuecraft transforme un serveur Minecraft en dashboard vivant pour tes files de jobs** : chaque queue est une gare, les jobs en attente sont des minecarts qui s'accumulent sur les rails, les jobs échoués deviennent des tombes dans un cimetière, et un mur de lampes affiche le débit en temps réel.

Une **file de jobs** (job queue), c'est le système qui permet à une app de dire « fais ce travail plus tard, en arrière-plan » — envoyer un email, scraper une page, générer un PDF — au lieu de bloquer l'utilisateur. Outrival en utilise une (pg-boss) pour son scraping.

---

## Contexte général

Trois faits établis par la recherche du 22/07/2026 :

1. **La niche est vide.** Aucun projet « job queue dashboard in Minecraft » n'existe sur GitHub. Le comparable le plus proche, KubeCraftAdmin (~1 050 étoiles), gère des serveurs Kubernetes depuis Minecraft — preuve que le genre « infra dans Minecraft » plaît.
2. **Des dashboards sérieux existent déjà** (Bull Board pour BullMQ, et depuis peu un dashboard officiel `@pg-boss/dashboard`). On ne comble donc pas un manque fonctionnel.
3. **L'écosystème Minecraft vient de bouger** : nouveau schéma de versions par année (26.1, 26.2…), et la bibliothèque de bots la plus connue (mineflayer) ne suit plus. Ça contraint fortement nos choix techniques (voir D3 et D4).

---

## D1 — Positionnement : objet culte fonctionnel, pas outil de production

**Décision.** Queuecraft est un projet « sérieusement absurde » : il fonctionne vraiment, mais son but est le plaisir, la démo et la pédagogie — pas de remplacer Grafana. Le README l'assume dès la première ligne. Version 1 en **lecture seule** (on regarde, on ne touche pas) ; l'interactivité (relancer un job depuis le jeu) arrive en phase 2.

**Pourquoi.** Les dashboards sérieux existent déjà (contexte, point 2). Se positionner contre eux serait perdu d'avance ; se positionner à côté (« Bull Board te montre tes queues, Queuecraft te fait vivre dedans ») est imbattable. Et commencer en lecture seule divise la complexité par deux : on ne peut rien casser chez l'utilisateur.

**Conséquences.** Le ton du README, les choix de scope et la communication (GIF de minecarts qui déraillent) découlent de ce positionnement. Licence **MIT** (licence très permissive : chacun peut utiliser, modifier, revendre — le standard pour maximiser l'adoption d'un projet open source).

---

## D2 — Nom : Queuecraft

**Décision.** Nom du projet et du package : **queuecraft**. « Minecart » était le favori mais le nom est déjà pris sur npm (le registre public des packages JavaScript — deux packages ne peuvent pas porter le même nom).

**Pourquoi.** Vérifié le 22/07 : `minecart` → pris (package vide, squatté). `queuecraft` → libre. Le nom dit exactement ce que fait le projet, et le clin d'œil à Minecraft est évident.

**Conséquences.** Re-vérifier la disponibilité juste avant la première publication (un nom libre aujourd'hui peut être pris demain), et réserver le nom sur npm dès que le squelette du repo existe, même vide.

---

## D3 — Transport : RCON, sans bot ni plugin

Le « transport », c'est la façon dont notre programme parle au serveur Minecraft.

**Décision.** On pilote le serveur via **RCON** uniquement. RCON (Remote CONsole) est un mini-protocole intégré à tous les serveurs Minecraft depuis 2011 : on ouvre une connexion réseau, on envoie une commande texte (`/setblock`, `/summon`…), le serveur répond. C'est exactement comme taper dans la console admin, mais depuis un programme. Bibliothèque : `rcon-client` (v4.2.5, stable, gère la file d'attente des messages pour nous).

**Options écartées.**

| Option | Verdict | Raison |
|---|---|---|
| **Bot mineflayer** (un faux joueur piloté par code) | Écartée pour la v1 | mineflayer ne supporte que jusqu'à Minecraft 1.21.11. Les versions 26.x le font planter (« unsupported protocol version », correctif en cours mais cassé). On serait prisonniers d'une vieille version du jeu. |
| **Plugin Java** (extension installée dans le serveur, ex. Paper) | Reportée en phase 2 | Puissant (accès à tout, temps réel), mais ça force l'utilisateur à installer un fichier .jar, ça nous fait maintenir du Java, et ça nous lie aux versions de l'API Paper. Trop de friction pour un MVP. |
| **Management Protocol officiel** (nouvelle API WebSocket ajoutée par Mojang fin 2025) | Complément futur | Élégant, mais il ne permet PAS d'exécuter des commandes arbitraires — uniquement de la gestion (bans, joueurs, arrêt du serveur). Inutilisable seul pour dessiner dans le monde. On pourra l'ajouter plus tard pour recevoir des notifications (« un joueur s'est connecté »). |

**Conséquences.** Zéro installation côté serveur (RCON s'active avec 3 lignes dans `server.properties`). En échange, on hérite des limites de RCON : lent (quelques dizaines de commandes/seconde), et mot de passe qui circule en clair → **la doc imposera de ne jamais exposer le port RCON sur internet** (localhost ou réseau Docker uniquement).

> ⚠️ **Amendé par [ADR-002](ADR-002-debit-rcon-reel.md).** « Lent (quelques dizaines de commandes/seconde) » est **faux** : mesuré à ~2 300–2 700 cmd/s soutenues sur une seule connexion, sur les deux cibles de D4. En revanche, une limite non anticipée existe : le pipelining est impossible (le serveur ferme la connexion dès 2-3 commandes en vol). La consigne de sécurité sur le port RCON, elle, reste entièrement valable.

---

## D4 — Compatibilité : « vanilla-stable only »

**Décision.** Le moteur de rendu n'utilise **que des commandes vanilla stables depuis des années** : `setblock`, `fill`, `summon`, `data`, `bossbar`, `scoreboard`, `tellraw`, `particle`. (« Vanilla » = le jeu de base, sans mods ni plugins.) Interdiction d'utiliser une fonctionnalité récente ou une API de plugin.

**Pourquoi.** Minecraft vient de changer de schéma de versions (26.1 en mars, 26.2 en juin, 26.3 en approche — fini les 1.21.x). En ne dépendant que de commandes qui n'ont pas bougé depuis des années, Queuecraft marche **à la fois** sur les serveurs 1.21.x (majoritaires aujourd'hui) et 26.x, et survivra probablement à 27.x sans qu'on touche au code.

**Conséquences.** Notre « matrice de compatibilité » (la liste des versions qu'on garantit) se résume à deux cibles testées en CI : **Paper 1.21.11** et **Paper/vanilla 26.2**. Toute nouvelle commande ajoutée au renderer doit passer un check : « existe-t-elle telle quelle dans les deux ? »

---

## D5 — Modèle de données : un format pivot minuscule

**Décision.** Le cœur du projet est un **modèle normalisé** : un format interne unique vers lequel toutes les files de jobs sont traduites, quelle que soit leur techno. Trois notions seulement :

```ts
// L'état d'une queue à un instant T
QueueSnapshot = {
  name: string
  counts: { waiting, active, completed, failed, delayed }  // des nombres
  workers: number          // combien de "machines" consomment la queue
  throughputPerMin: number // jobs traités par minute
}

// Un événement ponctuel
QueueEvent = { type: 'job_failed' | 'job_completed' | ...,
               queue: string, jobId: string, error?: string }

// Les actions possibles (phase 2, optionnelles)
QueueActions = { retry(jobId), cancel(jobId) }
```

Un **adapter** (adaptateur) est un petit module qui traduit une techno de queue précise (pg-boss, BullMQ…) vers ce format pivot. Le moteur de rendu ne connaît que le format pivot — jamais les technos elles-mêmes.

**Pourquoi.** C'est le pattern qui permet « utilisable par tout le monde » : ajouter le support d'une nouvelle techno = écrire un adapter de ~100 lignes, sans toucher au reste. C'est aussi ce qui rend le projet contribuable par des inconnus.

**Conséquences.** Structure en **monorepo** (un seul dépôt Git contenant plusieurs packages) avec pnpm : `packages/core` (modèle + renderer), `packages/adapter-pgboss`, `packages/adapter-bullmq`, `apps/demo`.

---

## D6 — Adapters : pg-boss d'abord, BullMQ ensuite

**Décision.** Premier adapter : **pg-boss v12** (la queue basée sur Postgres — celle d'Outrival). Deuxième : **BullMQ** (la queue basée sur Redis, la plus populaire de l'écosystème JS). À deux, on couvre l'essentiel des projets TypeScript.

**Pourquoi pg-boss en premier.** Vérifié dans le code de la v12.26 : l'API fait déjà presque tout le travail. `getQueues()` liste les queues, `getQueueStats()` renvoie exactement nos compteurs (waiting/active/failed…), un événement `wip` pousse l'état des workers en temps réel, et — cadeau — l'option `persistQueueStats` historise les stats en série temporelle avec un paramètre `maxDataPoints` pensé pour alimenter un graphique : notre mur de lampes historique est servi sur un plateau. Les actions `retry()/cancel()` existent déjà pour la phase 2. Attention : pg-boss v12 exige **Node 22.12+**, ce qui fixe notre plancher de runtime (voir D8).

**Côté BullMQ** : `getJobCounts()`, `getWorkers()`, `getMetrics()` et la classe `QueueEvents` (flux d'événements temps réel) couvrent le même besoin. Un cran plus de code, rien de bloquant.

**Conséquences.** L'interface `Adapter` du core doit être validée en implémentant les DEUX adapters avant de la figer (si une interface ne survit pas à sa deuxième implémentation, elle était mal conçue).

---

## D7 — Rendu : display entities, boucle à 2 Hz, et agrégation

**Décision.** Trois choix liés :

1. **Affichage moderne, pas de panneaux en bois.** Les textes flottants (compteurs, noms de queues, erreurs) utilisent les **display entities** — des entités d'affichage pur ajoutées au jeu en 1.19.4 : du texte ou des blocs flottants, sans collision, redimensionnables, et surtout **animables** : quand on change leur valeur via la commande `/data merge`, le jeu interpole (anime la transition en douceur) au lieu de faire un changement sec. Nos compteurs s'animeront donc nativement, en vanilla, via RCON.

2. **Boucle de rendu à 2 Hz avec diffing.** Le daemon (le programme qui tourne en fond) relit l'état des queues et met à jour le monde 2 fois par seconde maximum. Et il fait du **diffing** : il garde en mémoire ce qu'il a déjà dessiné, compare avec le nouvel état, et n'envoie QUE les commandes correspondant aux différences. Si rien n'a changé, zéro commande envoyée.

3. **Agrégation à fort volume.** RCON plafonnant à quelques dizaines de commandes/seconde, on ne représente pas chaque job individuellement : 1 minecart affiché = N jobs réels (échelle qui s'adapte au volume), les lampes utilisent une échelle logarithmique (chaque palier = ×10). **Exception : les jobs échoués**, matérialisés un par un (une tombe chacun, avec l'erreur affichée) car c'est là que le détail a de la valeur — plafonnés aux 50 plus récents.

**Pourquoi.** Tout découle de la contrainte D3 : RCON est lent, donc chaque commande doit compter. Le diffing et l'agrégation sont les deux techniques standard pour rendre un canal lent suffisant.

**Conséquences.** Le renderer a besoin d'un « état miroir » en mémoire (la copie de ce qui est dessiné) — c'est le morceau le plus délicat du code. Budget cible : < 40 commandes/seconde en régime de croisière.

> ⚠️ **Amendé par [ADR-002](ADR-002-debit-rcon-reel.md).** Le budget de 40 cmd/s est **confirmé et conservé**, mais sa justification change : ce n'est plus une limite subie du canal (mesuré 58× plus haut) mais une discipline choisie, pour ne pas voler le temps de tick du serveur observé. Le diffing et l'agrégation restent obligatoires.

---

## D8 — Stack : TypeScript, Node 22+, Bun en dev

**Décision.** Code en **TypeScript**. Runtime officiellement supporté : **Node.js ≥ 22.12** (imposé par pg-boss v12). Bun reste utilisable en développement (c'est ton confort habituel), mais la CI teste sur Node, car un projet « pour tout le monde » doit tourner sur le runtime que tout le monde a.

**Conséquences.** Pas d'API spécifique à Bun dans le code (`Bun.serve`, etc.) — uniquement du Node standard. pnpm pour le monorepo.

---

## D9 — Démo : `docker compose up` et rien d'autre

**Décision.** Le dépôt contient une démo autonome : un fichier Docker Compose qui lance (a) un serveur Minecraft via l'image `itzg/minecraft-server` (l'image Docker de référence, testée avec les versions 26.x), monde plat pré-généré, RCON activé ; (b) le daemon Queuecraft ; (c) un **générateur de jobs factices** avec un taux d'échec réglable (pour voir le cimetière se remplir). Le tout **sans base de données à installer** : pg-boss tournera sur **PGlite**, une version de Postgres compilée pour s'exécuter *à l'intérieur* du process Node — pas de serveur Postgres, pas de config, ça marche direct (et pg-boss v12 le supporte officiellement).

**Pourquoi.** La leçon de mineSQL et KubeCraftAdmin : ces projets décollent quand n'importe qui peut voir la magie en 2 minutes. Chaque étape d'installation supplémentaire divise le nombre de gens qui essaient.

**Conséquences.** La démo EST le produit marketing : le GIF du README sera capturé dessus. Elle doit être maintenue au même niveau de qualité que le core.

---

## Récapitulatif des conséquences globales

**Ce qui devient facile :** installation utilisateur quasi nulle (RCON + un binaire), compatibilité large (1.21.x et 26.x), contribution externe (écrire un adapter = 100 lignes), démo instantanée.

**Ce qui devient contraint :** tout passe par un canal lent (RCON) → la discipline diffing/agrégation n'est pas optionnelle ; pas d'interactivité riche avant la phase 2 ; pas de bot tant que mineflayer ne supporte pas 26.x.

**À revisiter plus tard :** le plugin Paper (phase 2, pour l'interactivité temps réel), le Management Protocol officiel (si Mojang y ajoute l'exécution de commandes, il pourrait remplacer RCON), un adapter Graphile Worker ou Celery si la demande existe.

---

## Plan d'action

1. [ ] Valider cet ADR (toi)
2. [ ] Créer le repo `queuecraft` (monorepo pnpm, MIT) + réserver le nom npm
3. [ ] `packages/core` : modèle pivot + interface Adapter (types seulement)
4. [ ] Spike RCON : se connecter à un serveur local et poser 100 blocs/seconde pour mesurer la vraie limite
5. [ ] `adapter-pgboss` (lecture seule) branché sur une queue de test
6. [ ] Renderer v0 : une gare, des carts agrégés, un compteur en display entity
7. [ ] Démo Docker Compose (itzg + PGlite + générateur de jobs)
8. [ ] `adapter-bullmq`, puis figer l'interface Adapter
9. [ ] README + GIF, publication

---

## Glossaire

- **ADR** : document court qui grave une décision d'architecture (contexte → décision → conséquences).
- **File de jobs (job queue)** : système qui exécute des tâches en arrière-plan (emails, scraping…) au lieu de bloquer l'application.
- **RCON** : protocole d'administration à distance intégré aux serveurs Minecraft ; permet d'envoyer des commandes console depuis un programme.
- **Vanilla** : le jeu Minecraft de base, sans mods ni plugins.
- **Plugin (Paper)** : extension Java installée dans un serveur Minecraft pour en modifier le comportement.
- **mineflayer** : bibliothèque JavaScript pour créer des bots qui se connectent comme de vrais joueurs.
- **Display entity** : entité d'affichage pur (texte, bloc ou item flottant) pilotable par commandes, avec animations intégrées.
- **Daemon** : programme qui tourne en continu en arrière-plan.
- **Polling** : interroger régulièrement un système (« du nouveau ? ») au lieu d'attendre qu'il nous prévienne.
- **Diffing** : comparer l'état précédent et le nouvel état pour n'appliquer que les différences.
- **Adapter** : module de traduction entre une techno précise et le format interne commun du projet.
- **Monorepo** : un seul dépôt Git contenant plusieurs packages qui évoluent ensemble.
- **Runtime** : le programme qui exécute ton code JavaScript (Node.js, Bun…).
- **PGlite** : Postgres compilé pour tourner à l'intérieur d'un process Node, sans serveur à installer.
- **CI** : tests automatiques lancés à chaque modification du code.
- **Échelle logarithmique** : échelle où chaque palier représente ×10 (permet d'afficher 10 comme 10 000 sur le même mur de lampes).
